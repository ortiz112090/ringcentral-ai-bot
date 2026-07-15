# RingCentral AI Voice Bot — SR22 Auto Insurance

An AI voice agent that answers inbound RingCentral calls, runs an SR22 auto-insurance
follow-up sales script (powered by Anthropic Claude), transcribes/synthesizes speech
with OpenAI, and logs every call and lead to Supabase. Deployable to Render as a
long-running web service.

## What it does

1. RingCentral sends an inbound-call webhook to this service.
2. The bot answers the call and greets the caller using the SR22 follow-up script.
3. Caller audio → OpenAI STT → text.
4. Text + conversation state → Claude, which returns the next line to say **and** a
   structured control block (current stage, close-attempt count, escalate flag,
   captured lead fields, terminal outcome).
5. Claude's line → OpenAI TTS → audio played back to the caller.
6. On an escalation trigger (human requested, out-of-script question, or 5 failed
   closes on an unclear situation) the call is transferred to a human queue extension.
7. Every call outcome, transcript, and lead detail is written to Supabase — even if
   the AI errors mid-call, in which case the caller is safely escalated to a human.

## Architecture

```
Inbound call ──► RingCentral ──► POST /webhooks/ringcentral (Express)
                                        │
                                        ▼
                                  callHandler (orchestrator)
                     ┌──────────────┬──────────────┬───────────────┐
                     ▼              ▼              ▼               ▼
              OpenAI STT     Claude (script    OpenAI TTS     RingCentral
             (speech→text)   state machine)   (text→speech)   Call Control
                                     │                         (answer /
                                     ▼                          transfer /
                               Supabase (calls,                 play audio)
                               leads, transcripts)
```

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
│       └── 0001_init.sql        # calls, leads, call_transcripts tables + enums
└── src/
    ├── index.ts                # Express entrypoint, startup + graceful shutdown
    ├── config.ts               # Env var loader (fails fast on missing secrets)
    ├── logger.ts               # Tiny JSON logger
    ├── callHandler.ts          # Per-call orchestration (the "brain")
    ├── ai/
    │   ├── systemPrompt.ts     # Builds Claude system prompt from the sales script (+ approved lessons)
    │   ├── conversation.ts     # Claude call + JSON control-block parsing
    │   ├── anthropicClient.ts  # Shared Anthropic client (reused by conversation + learning)
    │   └── retrieval.ts        # Learning system: fetch + format approved lessons at call time
    ├── speech/
    │   └── openai.ts           # OpenAI STT (transcribe) + TTS (synthesize) + embeddings
    ├── ringcentral/
    │   ├── client.ts           # RingCentral SDK JWT auth + REST helpers
    │   └── telephony.ts        # Answer / transfer / play audio / SMS / subscription
    ├── db/
    │   ├── supabase.ts         # Supabase service-role client
    │   ├── queries.ts          # Call + lead read/write (failure-tolerant)
    │   ├── learningQueries.ts  # Learning-system table read/write (failure-tolerant)
    │   └── types.ts            # Domain/DB types (incl. learning tables)
    ├── learning/
    │   ├── ingest.ts           # Ingest audio (STT) or text transcript into training_calls
    │   ├── tagging.ts          # Create call_tags (mark good/bad moments)
    │   ├── extractLessons.ts   # Claude distills a tag into a pending learned_rule
    │   ├── review.ts           # Approve/reject queue (reusable, dashboard-ready)
    │   └── cli.ts              # ingest / tag / review CLI (npm run learn:*)
    ├── routes/
    │   ├── health.ts           # GET /health
    │   └── webhooks.ts         # POST /webhooks/ringcentral (calls + SMS)
    └── state/
        └── conversationStore.ts # In-memory per-call state, keyed by session id
```

## Sales script & safety rules

The full decision tree lives in `../sales_script_flow.md` and is compiled into
Claude's system prompt in `src/ai/systemPrompt.ts`. Key encoded rules:

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
"lessons" and inject the relevant ones into Claude's system prompt at call time as
supplementary few-shot guidance. This keeps the core sales script fixed and every
behavior change human-reviewed.

### Data flow

```
ingest ──► tag ──► extract lesson ──► review/approve ──► retrieve at call time
(audio/    (mark    (Claude distills   (human approves    (top-N approved lessons
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
3. **Extract** — Claude turns a tagged moment into a generalized `learned_rule`
   (situation → recommended response, plus what to avoid for bad examples), stored as
   `pending_review`.
4. **Review** — `npm run learn:review` walks pending lessons so you approve or reject
   each. Nothing is used live until approved.
5. **Retrieve** — during a live call, `src/ai/retrieval.ts` fetches the top-N relevant
   **approved** lessons and `buildSystemPrompt` appends them as clearly-labeled
   supplementary guidance. This is strictly additive and wrapped in try/catch: if
   retrieval finds nothing or errors, the bot runs the core script unchanged.

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

Call Control (answer / transfer / play) is fully wired. Streaming the caller's live
audio to STT and pushing TTS bytes back is account/media-package dependent on
RingCentral; `src/ringcentral/telephony.ts` documents exactly where the generated
audio URL is handed to the `play` endpoint, and `processCallerAudio()` in
`src/routes/webhooks.ts` is the single entry point for a captured audio turn.

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
