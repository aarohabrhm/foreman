# Foreman — AI agent workflow builder

Build multi-step AI workflows, trigger them four ways, watch them execute live,
and pause them for human approval — on nhost (Postgres + Hasura + Auth) with a
Next.js frontend.

- **Step types**: `llm_call` (Groq), `http_request`, `db_write`, `notify`,
  `conditional_branch`, `approval_gate`
- **Trigger types**: manual, webhook (Hasura Action), scheduled (Hasura cron),
  database event (Hasura Event Trigger)
- **Two permission layers**, enforced differently — see
  [docs/WRITEUP.md](docs/WRITEUP.md)

---

## How it fits together

```
Next.js (app/)                      nhost project
┌───────────────────────┐           ┌──────────────────────────────────┐
│ pages + subscriptions │──────────▶│ Hasura GraphQL                   │
│                       │  queries  │  · row-level permissions (L1)    │
│                       │◀──────────│  · Actions ─────────┐            │
│                       │   live    │  · Event/cron triggers│          │
│ /api/actions/*        │◀──────────┼──────────────────────┘          │
│ /api/hooks/*          │  webhook  │ Postgres                         │
│  · Layer 2 checks     │──────────▶│  (admin writes run state)        │
│  · run engine         │   admin   └──────────────────────────────────┘
└───────────────────────┘
```

The Action handlers live in the Next.js app, so one deploy covers the frontend
and the engine. A run's progress is never streamed back through the Action: the
engine writes `step_runs` rows and the browser watches them over a GraphQL
subscription.

---

## Setup

### 1. What you need

| Thing | Why | Required? |
| --- | --- | --- |
| An nhost project (free tier) | Postgres + Hasura + Auth | yes |
| Its Hasura **admin secret** | applying migrations; server-side run state | yes |
| A **Groq** API key | real `llm_call` steps | no — see below |
| A Slack incoming webhook | real `notify` delivery | no — see below |

Without `GROQ_API_KEY`, `llm_call` steps run a **clearly-logged stub** with an
artificial delay (`[foreman] STUBBED llm_call …`) whose output still varies with
the prompt, so `conditional_branch` is genuinely exercised. Without
`SLACK_WEBHOOK_URL`, `notify` marks the notification row `stubbed` and logs it.
Neither is silently faked.

### 2. Clone and configure

```bash
npm install
cp .env.example .env.local     # then fill it in
```

`.env.local` (never committed) needs at minimum:

```
NEXT_PUBLIC_NHOST_SUBDOMAIN=...      # nhost dashboard -> Overview
NEXT_PUBLIC_NHOST_REGION=...         # e.g. eu-central-1
HASURA_GRAPHQL_ADMIN_SECRET=...      # nhost dashboard -> Settings -> Hasura
ACTION_SECRET=<any long random string>
GROQ_API_KEY=                        # optional
```

### 3. Configure the nhost project

Three settings in the nhost dashboard, all required:

1. **Settings → Environment Variables** — add:
   - `ACTION_SECRET` — the *same* value as in `.env.local`. Hasura sends it with
     every Action and Event Trigger; handlers reject requests without it.
   - `ACTION_BASE_URL` — the public origin Hasura should call, e.g.
     `https://your-app.vercel.app`. For local development this must be a public
     tunnel to `http://localhost:3000` (e.g. `cloudflared tunnel --url
     http://localhost:3000`), because Hasura is in the cloud and cannot reach
     your laptop otherwise.
2. **Settings → Authentication → Allowed roles** — must include
   `user, me, owner, editor, viewer`, with default role `user`. The app sends
   `x-hasura-role: owner|editor|viewer` per request; Hasura only honours roles
   the JWT allows. (Holding the role is still not access — every permission rule
   also requires a matching `org_members` row.)
3. **Settings → Sign-In Methods → Email and Password** — turn *off* "require
   verified emails" so the seed accounts can sign in.

### 4. Push the schema and seed

```bash
npm run db:push      # SQL migrations + Hasura metadata (tables, relationships,
                     # both permission layers, Actions, Event/cron triggers)
npm run db:seed      # two orgs, four users, the demo workflow, a webhook token
npm run dev
```

`db:push` **merges** metadata: it swaps in only the objects under `nhost/`, so
nhost's own `auth`/`storage` tracking is left untouched. Both commands are safe
to re-run.

The seed prints the accounts (all with the same password, `SEED_PASSWORD`,
default `Foreman!2026`):

| Account | Org | Role |
| --- | --- | --- |
| `a-owner@foreman.test` | Northwind Support (A) | owner |
| `a-editor@foreman.test` | Northwind Support (A) | editor |
| `a-viewer@foreman.test` | Northwind Support (A) | viewer |
| `b-owner@foreman.test` | Contoso Logistics (B) | owner |

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run db:push` | Apply SQL migrations, merge Hasura metadata |
| `npm run db:seed` | Create the demo orgs, users, workflow and webhook token |
| `npm run verify:acceptance` | Run the whole acceptance scenario and assert it (needs `npm run dev`) |
| `npm run verify:triggers` | Verify the webhook, database-event, cron and notify handlers |
| `npm run test:cross-org` | **Attack Org A as a real Org B user** and assert every attempt fails |
| `npm run check:permissions` | Static audit: every Layer 1 rule joins `org_members` and pins its role |
| `npm test` | Offline tests for branch evaluation, templating and retry |
| `npm run typecheck` / `npm run lint` | Types and lint |

---

## Deploying

The app is a stock Next.js project — import the repo into Vercel, set the same
environment variables from `.env.local` (the `NEXT_PUBLIC_*` ones plus
`HASURA_GRAPHQL_ADMIN_SECRET`, `ACTION_SECRET`, `GROQ_API_KEY`), and deploy.
Then set `ACTION_BASE_URL` in **nhost** to the deployed origin so Hasura can
reach `/api/actions/*` and `/api/hooks/*`.

---

## Walking through the acceptance scenario

1. **Sign in as `a-owner@foreman.test`.** The header shows the org and your role.
   The seeded *Support triage* workflow is `llm_call → conditional_branch →
   http_request (urgent branch) / http_request (routine branch) → approval_gate
   → db_write`.
2. **Press Run.** You land on the live run view: steps flip from `running` to
   `succeeded` with no refresh, the branch the LLM chose executes and the other
   side is marked `skipped`, then the run stops at **paused / awaiting approval**.
3. **Approve it.** As the owner, or sign in as `a-editor@foreman.test` and
   approve there — execution resumes at the next step and the quota bar ticks up.
4. **Trigger it without the UI.** Use the `curl` command the builder shows after
   saving a webhook trigger (or the token printed by `npm run db:seed`); a second
   run appears. Inserting a `watched_records` row from the workflows page starts
   one via the Event Trigger instead.
5. **Sign in as `a-viewer@foreman.test`.** No Run button, no approve control —
   and the mutations are refused server-side too.
6. **Sign in as `b-owner@foreman.test`.** Org A's workflow is not listed, and
   pasting its URL shows "not found". `npm run test:cross-org` proves the same
   thing by ID against reads, listings, the live subscription, triggering,
   approving and writing.

---

## Troubleshooting

- **"role 'owner' is not allowed"** — the nhost allowed-roles setting in step 3
  is missing.
- **Actions time out / nothing happens on Run** — `ACTION_BASE_URL` on the nhost
  side is unset or not publicly reachable.
- **"Unauthorized caller"** in the logs — `ACTION_SECRET` differs between nhost
  and the app.
- **`llm_call` output says `"stubbed": true`** — `GROQ_API_KEY` is unset. That is
  the disclosed fallback, not a failure.
