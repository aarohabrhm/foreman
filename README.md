<div align="center">

# Foreman - An AI agent workflow builder
 
Compose ordered steps including real LLM calls trigger them four different ways, watch every step stream live and pause mid-run for human approval. Multi-tenant, with two independently enforced permission layers.
 
Built on **nhost** (PostgreSQL + Hasura + Auth) with a **Next.js** frontend and engine.
 
[![Live App](https://img.shields.io/badge/Live%20App-visit-2ea44f?style=for-the-badge)](https://foreman-two-sigma.vercel.app)
[![Design Write-up](https://img.shields.io/badge/Design%20Write--up-read-blue?style=for-the-badge)](docs/WRITEUP.md)
 
![Next.js](https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=next.js&logoColor=white)
![Hasura](https://img.shields.io/badge/Hasura-1EB4D4?style=flat-square&logo=hasura&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![nhost](https://img.shields.io/badge/nhost-0D2340?style=flat-square)
![GraphQL](https://img.shields.io/badge/GraphQL-E10098?style=flat-square&logo=graphql&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
 
</div>
<br>

## Contents

- [What it does](#what-it-does)
- [Architecture at a glance](#architecture-at-a-glance)
- [Quick start](#quick-start)
- [Full setup](#full-setup)
- [API keys, and what happens without them](#api-keys-and-what-happens-without-them)
- [Running locally: one important limitation](#running-locally-one-important-limitation)
- [Demo accounts](#demo-accounts)
- [Verifying it works](#verifying-it-works)
- [Deploying](#deploying)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## What it does

A **workflow** is an ordered list of steps belonging to an organization. Six step
types are supported:

| Step type | Behaviour |
| --- | --- |
| `llm_call` | Calls Groq for a real completion. Retried once on failure. |
| `http_request` | Calls any external API. Retried once, time-limited, response captured. |
| `db_write` | Writes a result into `db_write_results`. Owner-only to add. |
| `notify` | Enqueues a Slack message, delivered by a Hasura Event Trigger. Owner-only to add. |
| `conditional_branch` | Evaluates the previous step's output and sets the run's branch. Steps on the untaken side are recorded as `skipped`. |
| `approval_gate` | Pauses the run until an owner or editor approves. |

Four trigger types start a run:

| Trigger | Mechanism |
| --- | --- |
| Manual | Run button in the UI |
| Webhook | Public Hasura Action, authenticated by a per-trigger bearer token |
| Scheduled | Hasura cron trigger, with per-workflow cadence |
| Database event | Hasura Event Trigger on inserts into `watched_records` |

Two permission layers are enforced separately and never collapsed:

- **Layer 1** — 69 declarative Hasura row-permission rules. Every rule joins
  `org_members` *and* pins the caller's role, so the same role in a different
  organization matches zero rows.
- **Layer 2** — application code in [`lib/auth/layer2.ts`](lib/auth/layer2.ts):
  which step and trigger types a role may introduce, who may clear a specific
  approval gate, and whether the organization has quota left.

---

## Architecture at a glance

```
+-------------------------------+           +-------------------------------+
| Next.js app (Vercel)          |           | nhost project                 |
|                               |  queries  |                               |
|  Pages + live subscriptions   | --------> |  Hasura GraphQL               |
|                               | <-------- |   - Layer 1 row permissions   |
|                               |   live    |   - 4 Actions                 |
|                               |           |   - 2 Event Triggers          |
|  /api/actions/*  (4 handlers) | <-------- |   - 1 cron trigger            |
|  /api/hooks/*    (4 handlers) |   calls   |                               |
|   - Layer 2 checks            |           |  PostgreSQL                   |
|   - run engine                | --------> |   - schema + run state        |
|                               |   admin   |                               |
+-------------------------------+           +-------------------------------+
              |
              | Groq, Slack, any external API
              v
```

Three things worth knowing:

1. **The Action handlers live in the Next.js app**, so one deployment covers both
   the frontend and the engine.
2. **Run progress is never returned through the Action.** The engine writes
   `step_runs` rows; the browser watches them over a GraphQL subscription. Close
   the tab mid-run and nothing is lost.
3. **Execution happens in its own request** (`/api/hooks/execute`). Continuing
   work after responding is unreliable on serverless — see
   [docs/WRITEUP.md](docs/WRITEUP.md) for why this matters.

---

## Quick start

Assuming you already have an nhost project and its admin secret:

```bash
npm install
cp .env.example .env.local     # fill in the four required values
npm run db:push                # schema + Hasura metadata
npm run db:seed                # two orgs, four users, demo workflow
npm run dev                    # http://localhost:3000
```

Then read [Running locally: one important limitation](#running-locally-one-important-limitation)
before pressing Run.

---

## Full setup

### 1. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 22.14 or newer | Version 22+ is required — the scripts use `node --env-file=`. |
| npm | 11+ | Ships with Node. |
| An nhost project | free tier | Provides PostgreSQL, Hasura and Auth. Create one at [nhost.io](https://nhost.io). |

No database, Docker, or Hasura CLI installation is needed. The schema is applied
over Hasura's HTTP API by `scripts/db-push.mjs`.

### 2. Install

```bash
npm install
```

### 3. Environment variables

Copy the documented template and fill it in. `.env.local` is gitignored and must
never be committed.

```bash
cp .env.example .env.local
```

| Variable | Required | Where to get it |
| --- | --- | --- |
| `NEXT_PUBLIC_NHOST_SUBDOMAIN` | Yes | nhost dashboard, Overview |
| `NEXT_PUBLIC_NHOST_REGION` | Yes | nhost dashboard, Overview (e.g. `eu-central-1`) |
| `HASURA_GRAPHQL_ADMIN_SECRET` | Yes | nhost dashboard, Settings > Hasura |
| `ACTION_SECRET` | Yes | Invent one. Any long random string. |
| `GROQ_API_KEY` | No | [console.groq.com](https://console.groq.com) — see [API keys](#api-keys-and-what-happens-without-them) |
| `GROQ_MODEL` | No | Defaults to `openai/gpt-oss-20b` |
| `SLACK_WEBHOOK_URL` | No | A Slack incoming webhook |
| `SEED_PASSWORD` | No | Password for the demo accounts. Defaults to `Foreman!2026`. |

`ACTION_SECRET` is how the handlers know a request genuinely came from your
Hasura instance. The handlers are public URLs; anything arriving without the
matching secret is rejected with `401 Unauthorized caller`.

### 4. Configure the nhost project

Three settings in the nhost dashboard. All three are required, and each one
causes a distinct, confusing failure if missed.

**Settings > Environment Variables** — add both:

| Variable | Value |
| --- | --- |
| `ACTION_SECRET` | Exactly the same string as in `.env.local` |
| `ACTION_BASE_URL` | The public origin Hasura should call, e.g. `https://your-app.vercel.app` |

**Settings > Authentication > Allowed roles** — must include
`user, me, owner, editor, viewer`, with default role `user`.

The app sends `x-hasura-role: owner|editor|viewer` per request, and Hasura only
honours roles the JWT permits. Note that holding a role is still not access —
every permission rule additionally requires a matching `org_members` row.

**Settings > Sign-In Methods > Email and Password** — turn off "require verified
emails", so the seeded accounts can sign in immediately.

### 5. Create the schema and demo data

```bash
npm run db:push
npm run db:seed
```

`db:push` applies the SQL migrations and **merges** the Hasura metadata. The merge
matters: nhost tracks its own `auth` and `storage` tables in the same instance,
and a wholesale metadata replace would delete them. Both commands are safe to
re-run.

Expected tail of `db:push`:

```
11 table(s) tracked, 16 nhost-owned table(s) preserved, 4 action(s), 1 cron trigger(s).

Done — metadata is consistent.
```

If it instead prints a `PENDING` list, `ACTION_BASE_URL` is not yet set on the
nhost side. The schema and both permission layers are still applied; only the
Actions and triggers are inactive. Set the variable and re-run.

`db:seed` prints the demo accounts and a **webhook token shown exactly once** —
only its SHA-256 hash is stored. Copy it if you want to test the webhook trigger.

### 6. Run it

```bash
npm run dev
```

Open http://localhost:3000 and sign in as `a-owner@foreman.test`.

---

## API keys, and what happens without them

Both external integrations are **optional**. Neither is silently faked — when a
key is absent, Foreman says so in the data and in the logs.

### Groq (`llm_call` steps)

| | |
| --- | --- |
| **Required** | No |
| **Get a key** | [console.groq.com](https://console.groq.com), free tier |
| **Variable** | `GROQ_API_KEY` (optionally `GROQ_MODEL`) |
| **With a key** | Real chat completions, retried once on failure, token usage recorded on the step output. |
| **Without a key** | A disclosed stub: the step output contains `"stubbed": true`, an artificial delay stands in for the network call, and this is logged: |

```
[foreman] STUBBED llm_call "Classify the request" — GROQ_API_KEY is not set.
Set it in .env.local for real completions.
```

The stubbed answer still varies with the prompt, so a `conditional_branch` step
reading it is genuinely exercised rather than short-circuited. The rest of the
system behaves identically either way.

### Slack (`notify` steps)

| | |
| --- | --- |
| **Required** | No |
| **Get a URL** | A Slack incoming webhook for your workspace |
| **Variable** | `SLACK_WEBHOOK_URL` |
| **With a URL** | The Event Trigger posts the message and marks the row `sent`. Failures are marked `failed` and retried by Hasura. |
| **Without a URL** | The row is marked `stubbed` with a `delivered_at` timestamp, and the message is logged. Nothing claims to have been sent. |

### Everything else

`http_request` steps call whatever URL you configure and need no key. The demo
workflow posts to `https://postman-echo.com/post`, a public echo service.

---

## Running locally: one important limitation

**Browsing works locally. Starting a run does not, unless Hasura can reach your
machine.**

Hasura runs in the nhost cloud. When you press Run, Hasura has to call your
application back at `ACTION_BASE_URL`. It cannot reach `http://localhost:3000`,
because your laptop is not on the public internet.

| Works against `npm run dev` | Needs a publicly reachable app |
| --- | --- |
| Sign in, org switching | Pressing Run |
| Browsing workflows and past runs | Approving a paused step |
| The builder, saving workflows | The webhook, cron and database-event triggers |
| Live subscriptions on existing data | Alert delivery |

Two ways to get the full experience:

1. **Deploy it** (see [Deploying](#deploying)) and set `ACTION_BASE_URL` to the
   deployed origin. This is the simplest path.
2. **Tunnel to your machine**, for example:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   Then set `ACTION_BASE_URL` in nhost to the https URL the tunnel prints, and
   re-run `npm run db:push` so the Actions and triggers resolve it.

If the app is not reachable, a run is created and stays at `pending` — which is
exactly what the `PENDING` warning from `db:push` is telling you about.

---

## Demo accounts

Created by `npm run db:seed`. All use `SEED_PASSWORD` (default `Foreman!2026`).

| Account | Organization | Role |
| --- | --- | --- |
| `a-owner@foreman.test` | Northwind Support | owner |
| `a-editor@foreman.test` | Northwind Support | editor |
| `a-viewer@foreman.test` | Northwind Support | viewer |
| `b-owner@foreman.test` | Contoso Logistics | owner |

Start with `a-owner@foreman.test`. The seeded *Support triage* workflow is:

```
llm_call -> conditional_branch -> http_request (urgent branch)
                               -> http_request (routine branch)
         -> approval_gate -> db_write -> notify
```

---

## Verifying it works

Each suite prints one line per check and a total. Nothing is mocked; all of them
run against real infrastructure.

| Command | Expected | Needs |
| --- | --- | --- |
| `npm test` | 10/10 | Nothing — offline unit tests |
| `npm run check:permissions` | 69 rules audited | Nothing — static metadata audit |
| `npm run verify:live` | 12/12 | A deployed app. Strongest single check. |
| `npm run verify:acceptance` | 15/15 | `npm run dev` running |
| `npm run verify:triggers` | 13/13 | `npm run dev` running |
| `npm run verify:layer2` | 11/11 | `npm run dev` running |
| `npm run test:cross-org` | 13/13 | Deployed Actions |
| `npm run typecheck` | Silence | Nothing |
| `npm run lint` | Silence | Nothing |

`verify:live` is the most convincing, because it touches nothing but the public
GraphQL endpoint — proving the whole chain including the deployed handlers:

```
PASS  Hasura routes triggerWorkflowRun to the deployed handler
PASS  the deployed engine executes the steps and pauses at the gate
PASS  the branch was evaluated on the server — 3 succeeded, 1 skipped
PASS  a viewer cannot approve, through the real Action
PASS  an Org B owner cannot approve an Org A gate, through the real Action
PASS  an editor can approve, through the real Action
PASS  the run resumes on the deployed app and completes
PASS  an unauthenticated webhook call starts a run
PASS  Hasura's Event Trigger starts a run with no button click
PASS  the notify step's message is delivered by the Event Trigger

12/12 checks passed.
```

`test:cross-org` signs in as a genuine Org B user and attacks Org A by ID —
reads under every role it could claim, listings, a live subscription, triggering,
approving, and writing. It deliberately reports a check as inconclusive rather
than passed if the request failed for the wrong reason.

### Checking by hand

1. Sign in as `a-owner@foreman.test` and open *Support triage*.
2. Press **Run**. Steps stream live; one branch is `skipped`; the run stops at
   **paused / awaiting approval**.
3. Approve as `a-editor@foreman.test`. Execution resumes and the quota bar moves.
4. On the workflows page, press **Insert row** under "Database-event trigger" —
   a run starts with no button click on the workflow itself.
5. Sign in as `a-viewer@foreman.test`. No Run button, no approve control, and the
   mutations are refused server-side too.
6. Sign in as `b-owner@foreman.test`. Org A's workflow is not listed, and pasting
   its URL shows "not found".

---

## Deploying

The app is a stock Next.js project.

1. Import the repository into Vercel. **Set the Framework Preset to Next.js** —
   if it is left as "Other", Vercel publishes only the `public/` folder and every
   route returns 404.
2. Set these environment variables in Vercel:
   `NEXT_PUBLIC_NHOST_SUBDOMAIN`, `NEXT_PUBLIC_NHOST_REGION`,
   `HASURA_GRAPHQL_ADMIN_SECRET`, `ACTION_SECRET`, `GROQ_API_KEY`.
3. Deploy, then set `ACTION_BASE_URL` in **nhost** to the deployed origin.
4. Re-run `npm run db:push` so the Actions, Event Triggers and cron trigger
   resolve their webhook URLs.
5. Confirm with `npm run verify:live`.

The `NEXT_PUBLIC_*` variables are inlined at build time, so changing them
requires a rebuild, not just a restart.

---

## Project layout

```
app/
  api/actions/     4 Hasura Action handlers
  api/hooks/       execute, db-event, scheduled, notify
  workflows/       list and builder screens
  runs/[runId]/    live run view
components/        session/org context, header, quota bar, UI primitives
lib/
  auth/layer2.ts   Layer 2 - every step-level check, in one file
  engine/          executor, retry, templating, one module per step type
  graphql/         client documents and the websocket transport
  nhost/           user client and server-only admin client
nhost/
  migrations/      SQL schema, applied in order
  metadata/        Layer 1 permissions, Actions, Event and cron triggers
scripts/           db:push, db:seed, and the verification suites
tests/             offline unit tests
```

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `role "owner" is not allowed` | The nhost allowed-roles setting does not list the three role names. See step 4. |
| Pressing Run does nothing; run stays `pending` | Hasura cannot reach the app. Check `ACTION_BASE_URL` in nhost, and see [the local limitation](#running-locally-one-important-limitation). |
| `Unauthorized caller` in the logs | `ACTION_SECRET` differs between nhost and the app. They must match exactly. |
| `db:push` prints a `PENDING` list | `ACTION_BASE_URL` is unset on the nhost side. Schema and permissions still applied; set it and re-run. |
| Step output contains `"stubbed": true` | No `GROQ_API_KEY`. This is the disclosed fallback, not a failure. |
| A notification's status is `stubbed` | No `SLACK_WEBHOOK_URL`. Same, for alerts. |
| `429 Too Many Requests` on sign-in | nhost rate-limits authentication per IP. The scripts wait and retry automatically; a person switching accounts quickly should pre-sign-in in separate browser profiles. |
| `has used its quota for this period` | The organization's monthly allowance is exhausted. It resets at the start of the next period, or an owner can raise `quota_allowed`. |
| Every route on the deployed site returns 404 | Vercel's Framework Preset is not set to Next.js. See [Deploying](#deploying). |
| An `http_request` step fails with a 5xx | The external service is down. The engine retried once and reported the upstream status — working as intended. |

---

## Documentation

- [docs/WRITEUP.md](docs/WRITEUP.md) — schema reasoning, how the two permission
  layers are enforced differently, and how pause/resume is implemented.
- `.env.example` — every environment variable, documented inline.
