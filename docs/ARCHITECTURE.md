# Architecture

How Foreman is put together, and why. This is the document to read before
changing the schema, the permission model, or the run engine.

For running the project, see the [README](../README.md). For contributing, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

**Contents**

- [The schema](#the-schema)
- [The two permission layers](#the-two-permission-layers)
- [How pause and resume work](#how-pause-and-resume-work)
- [Where the code lives](#where-the-code-lives)

---

## The schema

The schema is shaped by one requirement above all others: **cross-org isolation
must hold against ID guessing**. That means every tenant-owned row has to reach
the caller's membership in one or two joins, so `org_members` is the hub —
`organizations -> org_members -> workflows -> steps/triggers`, and
`workflows -> workflow_runs -> step_runs`. A table that could not reach
`org_members` could not be safely exposed at all.

Three decisions are worth calling out. **`workflow_runs.org_id` is denormalised**
from `workflows`: it keeps the usage aggregate a single-table scan and lets the
permission rule on runs join `org_members` in one hop instead of two.
**`step_runs` snapshots `position`, `step_name`, `step_type` and `step_slug`**
rather than only pointing at `workflow_steps`, because runs are history — editing
a workflow next week must not rewrite what happened last week (the FK is
`ON DELETE SET NULL`, so history also survives step deletion).
**`workflow_runs.context` is the run's memory**: every step's output is merged in
and persisted immediately, which is what makes resumption possible and what
`{{last.text}}` resolves against.

Quota is stored twice, deliberately. `organizations.quota_used` is the counter
enforcement reads and the engine increments; the `org_usage_current_period` view
recomputes usage, success count and average run duration from `workflow_runs`.
The UI subscribes to the view, so the number on screen is derived from the runs
themselves rather than trusted from a counter.

### The workflow graph

A workflow is a **directed acyclic graph**, not a list. `workflow_steps` carries
a stable per-workflow `slug` — the identity the canvas, the connections and the
templates all share — and `workflow_step_edges` carries the connections between
them.

The conditional label lives on the **edge leaving** a `conditional_branch`, not
on the destination step. That is what lets one workflow hold two independent
conditionals; a single per-run `branch` flag could not, because the second
conditional silently overwrote the first.

`workflow_step_edges` includes `workflow_id` in *both* of its composite foreign
keys, so a connection structurally cannot point at a step in another workflow —
and therefore not at another organization's step either. Cross-org isolation on
that table is a property of the schema rather than a rule that could be written
wrongly.

## The two permission layers

They answer different questions, so they live in different places.

**Layer 1 — Hasura row rules (`nhost/metadata/**`).** *"May this caller touch this
row?"* Declarative, evaluated per row on every request, including subscriptions.
All 80 rules share one shape:

```yaml
filter:
  org:
    members:
      user_id: { _eq: X-Hasura-User-Id }
      role:    { _eq: editor }
```

The role in the JWT grants nothing by itself. An editor in Org A who sends
`x-hasura-role: editor` at an Org B row matches zero membership rows and sees
nothing — same role, different org, no access. A viewer claiming `owner` gets the
same treatment: the claim only selects which rule applies; the rule still has to
find the membership. Role capabilities fall out of the same mechanism —
`viewer` has **no insert permission on `workflow_runs`**, which is the
database-level meaning of "a viewer cannot trigger a run", and `step_runs` is
read-only to everyone so nobody can fake progress or stamp an approval directly.

`npm run check:permissions` asserts this mechanically across the whole metadata
directory: every rule must join `org_members` *and* pin the role it is written
for. "Role alone is never sufficient" is easy to state and easy to break with one
careless rule.

**Layer 2 — application code (`lib/auth/layer2.ts`).** *"May this caller do this
thing?"* Five checks, each named after the question it answers, all in one file,
each called from an Action handler before any write:
`assertCanCreateStepType` (db_write/notify are owner-only),
`assertCanConfigureTrigger` (webhook triggers are owner-only),
`assertCanTriggerRun`, `assertCanApprove`, and `assertQuotaAvailable`.

These genuinely cannot be row rules. The **step-type restriction** is a property
of a whole submission — an entire workflow's steps arrive together, several of
which do not exist yet — which is why authoring goes through the `saveWorkflow`
Action rather than plain mutations. **Approval** is a decision about a run that is
mid-flight: at the moment it is made nothing is read or written; what follows is
the resumption of execution. There is no row for Hasura to filter.

Membership is read with the admin client, never as the caller: what a caller is
allowed to do must not be filtered by what they are allowed to see, or an
attacker learns the answer by making the question return nothing.

The layers are not collapsed, but no gap is left either — `workflow_steps` and
`workflow_triggers` also accept direct mutations, so the editor's rules there
carry an equivalent type restriction as a backstop. Layer 2 remains the
enforcement point: it is where the error message comes from and the only place
the rule is stated once for every call path.

## How pause and resume work

`executeRun(runId)` walks the workflow's steps in topological order and **skips
any step already in a terminal state** (`succeeded`, `skipped`, `failed`). That
single property does all the work.

**Pausing:** on reaching an `approval_gate` the engine sets the step to
`awaiting_approval`, the run to `paused`, persists `context`, and returns. No
timer, no held connection, no in-memory state — the run's entire position is
three database rows.

**Resuming:** `approveStep` runs `assertCanApprove`, stamps `approved_by` /
`approved_at`, flips the gate to `succeeded`, sets the run back to `running`, and
calls `executeRun` again. The loop re-enters from the top, steps over everything
terminal — including the gate it just stamped — and continues at the next step,
rebuilding state from `workflow_runs.context`. The request that resumes a run is
a different HTTP request from the one that paused it, often on a different
instance, possibly days later, and nothing in the design assumes otherwise. The
same property lets a webhook-triggered run and a manual run share one code path.

Progress reaches the browser because every transition is a database write and the
run view subscribes to `step_runs`. The Action returns the run id immediately, so
a workflow that takes a minute never blocks a Hasura Action.

**One caveat that is not obvious.** Returning early and continuing to execute via
`waitUntil` is *wrong on serverless*: once the response is sent the instance can
be frozen mid-run, leaving a run created but never executed, parked at `pending`
forever. That failed exactly so in production, and only intermittently, depending
on whether the instance stayed warm. So the Action instead dispatches the run to
`/api/hooks/execute` — a separate invocation whose entire job is that one run,
and which therefore cannot be frozen by an unrelated response.

## Where the code lives

```
app/
  api/actions/     4 Hasura Action handlers
  api/hooks/       execute, db-event, scheduled, notify
  workflows/       list and canvas builder screens
  runs/[runId]/    live run view
components/
  canvas/          the graph editor: nodes, edges, inspector, minimap
lib/
  auth/layer2.ts   every Layer 2 check, in one file
  engine/          executor, graph, retry, templating, one module per step type
  graphql/         client documents and the websocket transport
  nhost/           user client and server-only admin client
nhost/
  migrations/      SQL schema, applied in order
  metadata/        Layer 1 permissions, Actions, Event and cron triggers
scripts/           db:push, db:seed, permission audit
tests/             offline unit tests; tests/e2e needs live infrastructure
```

**The Action handlers are Next.js API routes rather than nhost Functions.** One
deploy therefore covers the frontend, the engine and the Layer 2 checks, and
those checks sit beside the UI that respects them.
