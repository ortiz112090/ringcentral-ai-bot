# RingCentral AI Voice Bot — SR22 Auto Insurance

An AI voice agent that answers inbound RingCentral calls and runs an SR22 auto-insurance
follow-up sales script using **OpenAI's GPT-4o Realtime API** (streaming speech-to-speech
over WebSocket). Every call and lead is logged to Supabase. Deployable to Render as a
long-running web service. OpenAI is the sole AI provider — there is no Anthropic/Claude
dependency.

## What it does

1. RingCentral sends an inbound-call webhook to this service.
2. The bot answers the call and opens a **GPT-4o Realtime** session for that call.
3. Caller audio is streamed **into** the Realtime model as it arrives; the model's
   spoken response audio is streamed **back out** to the caller as it arrives — no
   waiting for a full turn (this is the latency win).
4. The model tracks state via **tool/function calls** rather than a parsed control
   block: `capture_lead_info`, `record_close_attempt`, `escalate_to_human`,
   `set_call_outcome`.
5. On an escalation trigger (human requested, out-of-script question, or 5 failed
   closes on an unclear situation) the call is transferred to a human queue extension.
6. Every call outcome, transcript, and lead detail is written to Supabase — even if
   the AI errors mid-call, in which case the caller is safely escalated to a human.

> **SMS path.** The optional inbound-SMS script still uses a non-streaming OpenAI **chat**
> turn (text-in/text-out); only live voice uses the Realtime API.

## Architecture

```
Inbound call ──► RingCentral ──► POST /webhooks/ringcentral (Express)
                                        │
                                        ▼
                              audioBridge (per-call bridge)
                                        │
        caller audio ▲│ bot audio       │  answer / transfer / hang up
                     │▼ (streamed)       ▼
             OpenAI GPT-4o Realtime  ◄──►  RingCentral Call Control
             (speech-to-speech WS)
                     │  tool calls (capture_lead_info, record_close_attempt,
                     ▼                  escalate_to_human, set_call_outcome)
               Supabase (calls, leads, transcripts)
```

### Why the change (latency)

The previous pipeline was **sequential**: OpenAI Whisper STT → Anthropic Claude →
OpenAI TTS, three round-trips per turn, measured/estimated at **~2–4s per turn**. The
GPT-4o Realtime API collapses speech-recognition, reasoning, and speech-synthesis into a
**single continuous stream** over one WebSocket, and audio is played back as it is
generated instead of after the whole reply is ready. This overlaps the three stages and
targets **~1–1.5s per conversational turn**.

### Latency expectations

A realistic **1–2s per turn** is achievable with this architecture. **Sub-1s is not
guaranteed**: the phone network and RingCentral media relay add overhead on top of the
model's own latency, and that leg is outside this service's control.

## File structure

```
ringcentral-ai-bot/
├── package.json
├── tsconfig.json
├── render.yaml                 # Render Blueprint (web service, health check /health)
├── .env.example                # All required environment variables
├── README.md
├── SETUP.md                    # Step-by-step RingCentral + Supabase + Render setup
├── supabase/
│   └── migrations/
│       ├── 0001_init.sql        # calls, leads, call_transcripts tables + enums
│       ├── 0002_learning_system.sql # training_calls, call_tags, learned_rules
│       └── 0003_realtime_migration.sql # adds calls.realtime_session_id
└── src/
    ├── index.ts                # Express entrypoint, startup + graceful shutdown
    ├── config.ts               # Env var loader (fails fast on missing secrets)
    ├── logger.ts               # Tiny JSON logger
    ├── callHandler.ts          # Call state + DB logging + SMS text-turn path
    ├── ai/
    │   ├── systemPrompt.ts     # Builds sales-script prompt/instructions (+ approved lessons)
    │   ├── realtimeEngine.ts   # GPT-4o Realtime WebSocket engine (voice, tools, streaming)
    │   ├── conversation.ts     # OpenAI chat turn + JSON control-block parsing (SMS path)
    │   ├── openaiClient.ts     # Shared OpenAI client (realtime, chat, speech, embeddings)
    │   └── retrieval.ts        # Learning system: fetch + format approved lessons at call time
    ├── speech/
    │   └── openai.ts           # OpenAI STT (transcribe) + TTS (synthesize) + embeddings
    ├── ringcentral/
    │   ├── client.ts           # RingCentral SDK JWT auth + REST helpers
    │   ├── audioBridge.ts      # Per-call bidirectional audio bridge (RC ↔ Realtime)
    │   └── telephony.ts        # Answer / transfer / play audio / SMS / subscription
    ├── db/
    │   ├── supabase.ts         # Supabase service-role client
    │   ├── queries.ts          # Call + lead read/write (failure-tolerant)
    │   ├── learningQueries.ts  # Learning-system table read/write (failure-tolerant)
    │   └── types.ts            # Domain/DB types (incl. learning tables)
    ├── learning/
    │   ├── ingest.ts           # Ingest audio (STT) or text transcript into training_calls
    │   ├── tagging.ts          # Create call_tags (mark good/bad moments)
    │   ├── extractLessons.ts   # OpenAI chat distills a tag into a pending learned_rule
    │   ├── review.ts           # Approve/reject queue (reusable, dashboard-ready)
    │   └── cli.ts              # ingest / tag / review CLI (npm run learn:*)
    ├── twilio/
    │   ├── voiceWebhook.ts     # POST /webhooks/twilio/voice (signature + fail-closed TwiML)
    │   ├── mediaStream.ts      # /twilio/media WebSocket ↔ audioBridge (start/media/stop)
    │   ├── escalation.ts       # REST redirect of a live Twilio call to a human
    │   └── client.ts           # Per-tenant Twilio REST client + auth-token resolver
    ├── routes/
    │   ├── health.ts           # GET /health
    │   └── webhooks.ts         # POST /webhooks/ringcentral (calls + SMS)
    └── state/
        └── conversationStore.ts # In-memory per-call state, keyed by session id
```

## Sales script & safety rules

The full decision tree lives in `../sales_script_flow.md` and is compiled — by the same
`src/ai/systemPrompt.ts` module — into the Realtime session `instructions` for live calls
(`buildRealtimeInstructions`) and into the OpenAI chat system prompt for the SMS path
(`buildSystemPrompt`). Identical business rules; only the delivery format differs. Key
encoded rules:

- **Never run an MVR** (Motor Vehicle Record) check under any circumstances.
- **5-attempt close discipline**, in order: initial offer → split payment → shop other
  carriers → manager discount → all fees waived for a good review.
- **Escalate to a human** when the caller asks for one, asks something outside the
  script, or all 5 closes fail on an unclear situation.
- Collect ZIP, DOB, and license number conversationally; if incomplete, give a
  lowballed estimate and offer an appointment.

## Learning System (retrieval-based, not fine-tuning)

The bot improves its rebuttal/response handling by learning from real example calls —
**without ever fine-tuning a model**. Instead of retraining, we store human-approved
"lessons" and inject the relevant ones into the model's prompt/instructions at call time
as supplementary few-shot guidance (Realtime `instructions` for voice, chat system prompt
for SMS). This keeps the core sales script fixed and every behavior change human-reviewed.

### Data flow

```
ingest ──► tag ──► extract lesson ──► review/approve ──► retrieve at call time
(audio/    (mark    (OpenAI distills   (human approves    (top-N approved lessons
 text →     good/    a general,         via CLI; only      injected into the system
 training_  bad       reusable rule →   approved rules      prompt, labeled as
 calls)     moment)   learned_rules,    go live)            "Lessons from past calls")
                      status=pending)
```

1. **Ingest** — `npm run learn:ingest` stores a real call (audio via OpenAI STT, or a
   `Caller:` / `Agent:` text transcript) into `training_calls`.
2. **Tag** — `npm run learn:tag` prints the transcript and lets you mark segments as
   good/bad examples of a category (e.g. `objection_shopping`, `closing`), creating
   `call_tags` rows and immediately extracting a lesson from each.
3. **Extract** — an OpenAI chat model turns a tagged moment into a generalized
   `learned_rule` (situation → recommended response, plus what to avoid for bad
   examples), stored as `pending_review`.
4. **Review** — `npm run learn:review` walks pending lessons so you approve or reject
   each. Nothing is used live until approved.
5. **Retrieve** — `src/ai/retrieval.ts` fetches the top-N relevant **approved** lessons
   and they are appended as clearly-labeled supplementary guidance — into the Realtime
   session `instructions` at session start for live calls, or into the chat system prompt
   for the SMS path. This is strictly additive and wrapped in try/catch: if retrieval
   finds nothing or errors, the bot runs the core script unchanged.

### Retrieval: pgvector or category fallback

- With `LEARNING_USE_PGVECTOR=true`, lessons are embedded (OpenAI embeddings) and
  retrieved by semantic similarity via the `match_learned_rules` RPC.
- By default (`false`), retrieval uses a simple keyword→category match — no pgvector
  needed, so the build/app never depends on vector search being available.

### Why this design

Safe (human approval gate before anything goes live), reviewable (every lesson is a
readable row you can edit/reject), and cheap (no model retraining, no GPU, no dataset
curation). Lessons layer on top of the script and can never override the hard rules,
the 5-close sequence, or the MVR restriction.

> **v1 has no visual dashboard.** The CLI is a deliberate stopgap. A future
> Lovable-built dashboard pointed at the same Supabase tables (`training_calls`,
> `call_tags`, `learned_rules`) is the natural next step for nicer tagging/review UX —
> the `review.ts` functions are written to be called directly by such a UI.

## Local development

```bash
cp .env.example .env      # fill in your keys
npm install
npm run dev               # ts-node-dev with hot reload
# or
npm run build && npm start
```

Health check: `GET http://localhost:3000/health`.

See **SETUP.md** for full RingCentral, Supabase, and Render deployment steps.

## Notes on media transport

Call Control (answer / transfer / hang up) is fully wired and works on any Call
Control-enabled account. The **bidirectional live media stream** the Realtime bridge
needs — raw caller audio in, bot audio out — is **account/media-package dependent** on
RingCentral and cannot be fully verified from this environment. It is **not** a simple
public websocket like Twilio Media Streams; depending on your product it may come via
RingCentral's media streaming / audio-stream APIs or a SIP/WebRTC media path.

The bridge is therefore transport-agnostic (`src/ringcentral/audioBridge.ts`): the media
layer calls `onCallerAudioChunk(sessionId, base64)` for inbound audio and registers an
outbound sink via `registerBotAudioSink(sessionId, sink)` (both re-exported from
`src/routes/webhooks.ts`). Audio uses `OPENAI_REALTIME_AUDIO_FORMAT` (default
`g711_ulaw`, telephony-native) to avoid resampling; transcode at that boundary if your
media feed differs. See the extended caveat comment at the top of `audioBridge.ts`.

## Twilio voice path (Media Streams ↔ OpenAI Realtime)

Because a raw bidirectional media stream isn't guaranteed on every RingCentral account,
voice can instead run over **Twilio Media Streams**, which _is_ a simple public
websocket. RingCentral keeps the phone numbers and SMS; the RC number is **forwarded**
(configured in RC admin, not in code) to a Twilio number that answers and streams audio
to this service. Twilio media payloads are base64 `mulaw/8000` — identical to the
Realtime engine's default `g711_ulaw`, so **no transcoding** happens; the existing
`audioBridge.ts` is reused unchanged for state, DB records, and escalation.

### How it works

1. **Inbound webhook** — `POST /webhooks/twilio/voice` (`src/twilio/voiceWebhook.ts`).
   The `X-Twilio-Signature` is validated against the tenant's auth token; an invalid or
   unverifiable request gets `403`. Then a **fail-closed** decision (in order):
   - `voice_provider` must be `twilio` **and** `twilio_number` set, else TwiML `<Reject>`.
   - the called number (`To`) must equal `twilio_number`, else `<Reject>` — the bot never
     answers other numbers.
   - kill switch (`bot_enabled=false` / tenant inactive) → `<Dial>escalation_number</Dial>`
     if set, else `<Hangup>`. No AI runs.
   - otherwise `<Connect><Stream url="wss://<host>/twilio/media">` with the caller number
     passed as a custom `<Parameter>`.
2. **Media WebSocket** — `/twilio/media` (`src/twilio/mediaStream.ts`) runs on the **same
   HTTP server** (no extra port). On `start` it opens the realtime bridge and wires bot
   audio back as `media` frames; caller `media` frames are pushed into the model; barge-in
   (caller speaks over the bot) sends a `clear` frame to flush Twilio's buffer; `stop`,
   socket close, and socket error all tear the bridge down idempotently.
3. **Escalation** — Twilio can't blind-transfer to an RC extension, so escalation uses the
   Twilio REST API to redirect the live call to `<Dial>escalation_number</Dial>` (or a
   polite `<Say>`+`<Hangup>` if none is set). Wired via the bridge's `onEscalate` hook.
4. **RC gating** — when `voice_provider === 'twilio'`, the RingCentral telephony handler
   logs and skips answering entirely; the RC subscription stays active for SMS. Default
   `ringcentral` preserves the original behavior.

### Required RingCentral forwarding setup

In RingCentral admin, forward the bot's RC number/extension to the tenant's
`TWILIO_NUMBER`. No code change is needed for forwarding — RC dials Twilio, Twilio answers
and hits this service.

### Config reference

Per-tenant, dashboard-owned columns on `bot_config` (migration applied externally — the
bot never migrates): `twilio_number`, `voice_provider` (default `ringcentral`),
`escalation_number`. Credentials live in `api_credentials` (provider `twilio`:
`account_sid`, `auth_token`), **DB-first**; the `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`
env vars are a fallback **only** for the primary bot. `PUBLIC_BASE_URL` derives the
`wss://<host>/twilio/media` stream URL. See `.env.example` for all keys.

Tests: `npm test` (vitest) covers the webhook signature + fail-closed cases and the media
stream start/media/stop lifecycle.

## Future work (out of scope for v1)

- **Multi-tenant support** — currently single-brokerage / single-user.
- **Admin dashboard UI** — data lives in Supabase tables, viewable in its dashboard.
  A future Lovable-built dashboard over the learning tables (`training_calls`,
  `call_tags`, `learned_rules`) would replace the stopgap `learn:*` CLI for tagging
  and review.
- **Outbound call scheduling automation** — v1 handles inbound calls only; scheduled
  outbound follow-ups are a natural next step.
- **Distributed call state** — move `conversationStore` from in-memory to Redis to run
  more than one Render instance.
- **Full SMS script parity** — inbound SMS handling is scaffolded (stretch goal).
