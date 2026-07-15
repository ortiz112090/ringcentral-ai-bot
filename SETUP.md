# Setup Guide — RingCentral AI Voice Bot

This walks you through everything from zero to a live bot answering calls. Estimated
time: ~45 minutes.

---

## 0. Prerequisites

- Node.js 20+ and npm.
- Accounts/keys for: RingCentral (with a phone number), OpenAI, Supabase.
- **OpenAI Realtime API access** on your OpenAI account (the GPT-4o Realtime model must
  be available to your key) — this powers the live voice pipeline.
- A GitHub repo (you'll push this project and connect it to Render).

---

## 1. Resume the Supabase project & run migrations

The Supabase project (**ref `hawjzggkndvxylzxvwvx`**) is currently **paused**.

1. Open the [Supabase dashboard](https://supabase.com/dashboard), select the project,
   and click **Resume / Restore** to unpause it. Wait until it reports healthy.
2. Get your credentials from **Project Settings → API**:
   - `SUPABASE_URL` (e.g. `https://hawjzggkndvxylzxvwvx.supabase.co`)
   - `SUPABASE_SERVICE_ROLE_KEY` (the **service_role** secret — server-side only!).
3. Run the schema. Either:
   - **SQL editor:** open `supabase/migrations/0001_init.sql`, paste it into the
     Supabase SQL editor, and run it, then do the same with
     `supabase/migrations/0002_learning_system.sql` and
     `supabase/migrations/0003_realtime_migration.sql`; **or**
   - **CLI:** `supabase link --project-ref hawjzggkndvxylzxvwvx && supabase db push`
     (applies all migrations in order).
4. Confirm the tables now exist: `calls`, `leads`, `call_transcripts` (from 0001) and
   `training_calls`, `call_tags`, `learned_rules` (from 0002). Migration 0003 adds the
   `calls.realtime_session_id` column (additive; no data change).

> The `leads.license_number` column holds sensitive PII. It's collected only for
> quoting and is **never** used to run an MVR. Consider Supabase Vault / pgcrypto
> before heavy production use.

### pgvector (optional — for semantic lesson retrieval)

Migration 0002 runs `create extension if not exists vector` and creates an embedding
column + `match_learned_rules` RPC. pgvector is available on standard Supabase
projects, so this normally just works. If your instance rejects the extension:

- Comment out the `create extension ... vector;` line, the `embedding vector(1536)`
  column, its `ivfflat` index, and the `match_learned_rules` function in 0002, then run
  the rest.
- Leave `LEARNING_USE_PGVECTOR=false` (the default). The learning system then retrieves
  lessons by category match instead of embeddings — no vector search required.

To enable semantic retrieval, set `LEARNING_USE_PGVECTOR=true` (and keep the pgvector
objects). See `.env.example` for the related `OPENAI_EMBEDDING_MODEL` and
`LEARNING_RETRIEVAL_LIMIT` settings.

---

## 2. Create the RingCentral app

1. Go to the [RingCentral Developer Console](https://developers.ringcentral.com/) and
   create a new app:
   - **App type:** REST API app / Server-only (no UI).
   - **Auth:** *JWT auth flow* (server-to-server). This is the preferred flow.
2. **Permissions / scopes** — enable:
   - **Call Control** (answer, transfer, play media)
   - **Read Call Log** / **Read Presence** (call state)
   - **SMS** (for the optional text script + soft-close contact texts)
   - **Webhook Subscriptions** (a.k.a. Subscriptions / Push notifications)
3. Note your **Client ID** and **Client Secret**.
4. Create a **JWT credential** for your user under **Credentials → JWT**, and copy
   the token. This becomes `RINGCENTRAL_JWT`.
5. Server URLs:
   - Production: `https://platform.ringcentral.com`
   - Sandbox: `https://platform.devtest.ringcentral.com`
6. Decide the **escalation extension** — the extension or phone number of the human
   queue calls should transfer to. This becomes `ESCALATION_QUEUE_EXTENSION`.

---

## 3. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

```bash
cp .env.example .env
```

| Variable | Where it comes from |
|---|---|
| `RINGCENTRAL_CLIENT_ID` / `_SECRET` | RingCentral app credentials |
| `RINGCENTRAL_SERVER_URL` | prod or sandbox URL |
| `RINGCENTRAL_JWT` | JWT credential you created |
| `ESCALATION_QUEUE_EXTENSION` | your human queue extension |
| `RINGCENTRAL_WEBHOOK_VERIFICATION_TOKEN` | any random string you choose |
| `OPENAI_API_KEY` | OpenAI dashboard (must have Realtime API access) |
| `OPENAI_REALTIME_MODEL` | defaults to `gpt-4o-realtime-preview`; override if OpenAI ships a newer realtime model |
| `OPENAI_REALTIME_VOICE` | realtime voice — see note below (defaults to `alloy`) |
| `OPENAI_REALTIME_AUDIO_FORMAT` | audio codec, defaults to `g711_ulaw` (telephony-native) |
| `OPENAI_CHAT_MODEL` | chat model for SMS + lesson extraction (defaults to `gpt-4o`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | step 1 |
| `AGENT_NAME` / `BROKERAGE_NAME` | your agent's display name + brokerage |
| `PUBLIC_BASE_URL` | your deployed Render URL (set after step 5) |

> **Choosing `OPENAI_REALTIME_VOICE`.** The Realtime API offers several voices (e.g.
> `alloy`, `echo`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`). Pick one that
> fits your brand — `alloy` is a neutral default. It only affects how the bot *sounds*,
> not what it says. Change it and redeploy to try another.

---

## 4. Run locally (optional smoke test)

```bash
npm install
npm run build
npm start
```

Then hit the health check:

```bash
curl http://localhost:3000/health
# {"status":"ok","ts":"..."}
```

To exercise webhooks locally, expose your port with a tunnel (e.g. `ngrok http 3000`)
and set `PUBLIC_BASE_URL` to the tunnel URL so the subscription points back to you.

---

## 5. Deploy to Render

1. Push this project to a GitHub repo:
   ```bash
   git init && git add . && git commit -m "Initial commit"
   git remote add origin git@github.com:you/ringcentral-ai-bot.git
   git push -u origin main
   ```
2. In the [Render dashboard](https://dashboard.render.com/) → **New → Blueprint**,
   connect the repo. Render reads `render.yaml` and creates the web service:
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Health check: `/health`
3. In the service's **Environment** tab, fill in every `sync:false` secret from your
   `.env` (Client ID/Secret, JWT, API keys, Supabase service key, agent/brokerage
   names, escalation extension, verification token).
4. After the first deploy, copy the service URL
   (e.g. `https://ringcentral-ai-bot.onrender.com`) and set it as `PUBLIC_BASE_URL`,
   then trigger a redeploy. On boot the service auto-creates the RingCentral webhook
   subscription pointing at `PUBLIC_BASE_URL/webhooks/ringcentral`.

---

## 6. Verify the webhook subscription

- Check the Render logs for `Webhook subscription active`.
- RingCentral will first send a validation handshake (a `Validation-Token` header),
  which the service echoes automatically.
- Subscriptions expire after 7 days; the service re-creates one on each restart. For a
  long-lived deployment, redeploy/restart weekly or add a renewal cron (future work).

---

## 7. End-to-end test

1. From any phone, call your RingCentral number.
2. The bot should answer with the SR22 opener within a second or two.
3. Talk through the script: say you haven't been helped, that you need it ASAP, give a
   ZIP / DOB / license number.
4. Ask "can I talk to a real person?" — the bot should say it's transferring you and
   route the call to `ESCALATION_QUEUE_EXTENSION`.
5. In Supabase, open the `calls` table — you should see a row with the outcome,
   `script_stage_reached`, and the full `transcript` JSON. Check `leads` for the
   captured info.

---

## 8. Learning system CLI (ingest → tag → review)

The learning system has no dashboard yet — you drive it with three CLI commands. They
run the compiled output, so **build first**:

```bash
npm run build
```

### a. Ingest a real call

From an audio recording (transcribed via OpenAI STT):

```bash
npm run learn:ingest -- --audio ./recordings/call-2026-07-10.mp3 --notes "good shopping rebuttal"
```

From an already-typed transcript (one utterance per line, `Caller:` / `Agent:` labels):

```
Caller: I want to shop around first before I commit.
Agent: Totally fair — what budget are you trying to hit? I work with over 60 carriers.
Caller: Maybe like 90 a month.
Agent: Let me see what I can do at that number.
```

```bash
npm run learn:ingest -- --transcript ./transcripts/shopping-call.txt
```

Each command prints the new **training call id** to use in the next step.

> Audio note: OpenAI transcription is single-stream (no speaker separation), and
> RingCentral recordings are typically single-channel — so an ingested audio call
> lands as one block of text. You split it into caller/agent lines yourself in the
> tagging step. Dual-channel recordings could be transcribed per-channel later.

### b. Tag good/bad moments (auto-extracts a lesson)

```bash
npm run learn:tag -- --call 12
```

This prints the transcript turn-by-turn, then interactively asks you to mark segments
as good/bad examples with a category (e.g. `objection_shopping`, `closing`, `rapport`).
Each tag immediately calls an OpenAI chat model to distill a generalized lesson into
`learned_rules` with status `pending_review`.

### c. Review the approval queue

```bash
npm run learn:review
```

Walks each pending lesson and lets you **(a)pprove / (r)eject / (s)kip / (q)uit**. Only
**approved** lessons are ever retrieved into live calls. Approved lessons take effect on
the next call automatically — no redeploy needed.

---

## Troubleshooting

- **No call answered:** confirm the webhook subscription is active (logs), the app has
  Call Control permission, and `PUBLIC_BASE_URL` is correct and public.
- **401 on webhook:** `RINGCENTRAL_WEBHOOK_VERIFICATION_TOKEN` in Render must match the
  value used when the subscription was created (redeploy to recreate).
- **Supabase errors in logs:** the project is probably still paused, or the
  service-role key is wrong.
- **Bot always escalates:** check `OPENAI_API_KEY` and that your account has Realtime
  API access — the bridge falls back to a safe human transfer whenever the Realtime
  WebSocket fails to connect or the model errors mid-call.
- **Call answers but there's silence / no bot audio:** the live media stream is not
  wired. Call Control alone can't stream raw audio — you must connect your RingCentral
  account's media stream to the bridge (`onCallerAudioChunk` / `registerBotAudioSink`,
  see README "Notes on media transport" and `src/ringcentral/audioBridge.ts`). Watch the
  logs for the "no RingCentral media sink attached" warning.
- **RingCentral login fails on boot:** verify the JWT and that the app uses the JWT
  auth flow; the service stays up (health passes) so you can fix creds and redeploy.
