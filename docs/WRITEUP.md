# Foreman — design write-up

## Schema reasoning

The schema is shaped by one requirement above the others: **cross-org isolation
must hold against ID guessing**, which means every tenant-owned row has to be
able to reach the caller's membership in one or two joins. So `org_members` is
the hub — `organizations → org_members → workflows → steps/triggers`, and
`workflows → workflow_runs → step_runs` — and every Hasura rule walks that path.
A table that could not reach `org_members` could not be safely exposed at all.

Three decisions are worth calling out:

- **`workflow_runs.org_id` is denormalised** from `workflows`. It keeps the
  usage aggregate a single-table scan and lets the permission rule on runs join
  `org_members` in one hop instead of two. The FK to `organizations` keeps it
  honest.
- **`step_runs` snapshots `position`, `step_name`, `step_type`** instead of only
  pointing at `workflow_steps`. Runs are history; a workflow edited a week later
  must not rewrite what happened. It also means run history survives a step being
  deleted (the FK is `ON DELETE SET NULL`).
- **`workflow_runs.context` (jsonb) is the run's memory.** Every step's output is
  merged into it and persisted immediately, which is what makes resume possible
  (below) and what `{{last.text}}` / `{{steps.0.output.text}}` resolve against.

Quota is stored twice, deliberately: `organizations.quota_used` is the counter
the engine increments and enforcement reads, while the required aggregation —
the `org_usage_current_period` view — recomputes usage, success count and average
run duration from `workflow_runs`. The view is what the UI subscribes to, so the
number on screen is derived from the runs themselves rather than trusted from a
counter.

The one modelling compromise: `org_members.invited_email` duplicates the address
from `auth.users`. nhost owns that table and does not expose it to these custom
roles, and widening its permissions to make member lists work seemed a worse
trade than storing the address on the membership record that created it.

## The two permission layers

They answer different questions, so they live in different places.

### Layer 1 — Hasura row rules (`nhost/metadata/**`)

*"May this caller touch this row?"* — declarative, evaluated per row on every
request, including subscriptions.

Every rule joins `org_members` **and** pins the caller's role:

```yaml
filter:
  org:
    members:
      user_id: { _eq: X-Hasura-User-Id }
      role:    { _eq: editor }
```

The role in the JWT grants nothing on its own. An editor in Org A who sends
`x-hasura-role: editor` at an Org B row matches zero membership rows and sees
nothing — same role, different org, no access. A viewer who claims `owner` gets
the same treatment, because the claim only selects which rule applies; the rule
still has to find the membership. `npm run check:permissions` asserts this
mechanically across all 66 rules, and `npm run test:cross-org` proves it over the
wire with a real second account.

Role capabilities fall out of the same rules: `owner` writes membership,
`editor` creates and edits workflows and steps but cannot manage members or
delete workflows, and `viewer` has **no insert permission on `workflow_runs`** —
that absence is the database-level meaning of "a viewer cannot trigger a run".
`step_runs` is read-only to everyone, so nobody can fake progress or stamp an
approval by mutating rows directly.

`user` (nhost's default role) exists only to bootstrap: it can read its own
`org_members` rows and the orgs they point at, so the app can build the org
switcher before it knows what role to act in.

### Layer 2 — application code (`lib/auth/layer2.ts`)

*"May this caller do this thing?"* — questions with no row to filter, so they
cannot be expressed as Hasura permissions. All five live in one file, each named
after the question it answers, each called from an Action handler before any
write:

| Function | Rule | Called from |
| --- | --- | --- |
| `assertCanCreateStepType` | only an owner may add `db_write` or `notify` | `saveWorkflow` |
| `assertCanConfigureTrigger` | only an owner may configure a `webhook` trigger | `saveWorkflow` |
| `assertCanTriggerRun` | only owner/editor may start a run | `triggerWorkflowRun` |
| `assertCanApprove` | who may clear a specific approval gate | `approveStep` |
| `assertQuotaAvailable` | the org has quota left | run creation |

Why these genuinely are not row rules: **step-type restriction** is a property of
a whole submission — an entire workflow's steps arrive together, several of which
do not exist yet — which is why authoring goes through the `saveWorkflow` Action
rather than plain mutations. **Approval** is a decision about a run that is
mid-flight: at the moment it is made nothing is being read or written; what
follows is the *resumption of execution*. There is no row for Hasura to filter.

Membership is read with the admin client, never as the caller. What a caller is
allowed to do must not be filtered by what they are allowed to see, or an
attacker learns the answer by making the question return nothing.

The layers are not collapsed, but they are not left with gaps either:
`workflow_steps` and `workflow_triggers` also accept direct GraphQL mutations, so
the editor's rules there carry an equivalent type restriction as a
defence-in-depth backstop. Layer 2 remains the enforcement point — it is where
the error message comes from, and the only place the rule is stated once for all
call paths.

## Pause and resume at an approval gate

`executeRun(runId)` walks the workflow's steps in order and **skips any step
already in a terminal state** (`succeeded`, `skipped`, `failed`). That single
property does all the work.

Pausing: on reaching an `approval_gate` the engine sets the step to
`awaiting_approval`, sets the run to `paused`, persists `context`, and returns.
No timer, no held connection, no in-memory state — the run's entire position is
three database rows.

Resuming: `approveStep` runs `assertCanApprove`, stamps `approved_by` /
`approved_at` and flips the step to `succeeded`, sets the run back to `running`,
and calls `executeRun` again. The loop re-enters from the top, steps over
everything terminal — including the gate it just stamped — and continues at the
next step, rebuilding its state from `workflow_runs.context`. The request that
resumes a run is a completely different HTTP request from the one that paused it,
often on a different serverless instance, and nothing in the design assumes
otherwise. The same property is what lets a webhook-triggered run and a manual
run share one code path.

Progress reaches the browser because every transition is a database write and the
run view subscribes to `step_runs`. The Action itself returns the run id
immediately and keeps executing in the background (`waitUntil` on Vercel), so a
workflow that takes a minute never blocks a Hasura Action — and a client that
closes the tab misses nothing.

## Verification

Executed against the live nhost project (`cdwilajfcvntdjqwhzlc`, eu-central-1)
with a real Groq key.

**`npm run verify:acceptance` — 15/15.** Drives the Action handlers with exactly
the payload Hasura sends and watches progress over a real subscription:

```
PASS  viewer cannot trigger a run — Role 'viewer' cannot trigger runs
PASS  Org B owner cannot trigger Org A's workflow — Workflow f7f65bc4… not found
PASS  owner can trigger a run
      live: 0. Classify the request      -> running -> succeeded
      live: 1. Is it urgent?             -> running -> succeeded
      live: 2. Page the on-call service  -> running -> succeeded
      live: 3. Log to the routine queue  -> skipped
      live: 4. Human approval            -> awaiting_approval
PASS  run reaches the approval gate and pauses
PASS  llm_call produced a real completion — "URGENT"
PASS  conditional_branch ran exactly one side — branch=true
PASS  live subscription observed the steps without polling — 5 transitions
PASS  Org B owner cannot approve Org A's gate
PASS  an Org A viewer cannot approve the gate
PASS  an Org A editor can approve the gate
PASS  the run resumes and completes
PASS  the gate records who approved it
PASS  the db_write step ran after approval
PASS  quota is consumed once for the run — 0 -> 1 of 25
```

**`npm run test:cross-org` — 8/13 passed, 5 inconclusive.** Signs in as a real
Org B user and attacks Org A by ID. Proven: reads by ID under *every* role B can
claim (owner, editor, viewer, user), listings filtered by `org_id`, `step_runs`
by run ID, a live websocket subscription to an Org A run (zero rows), and a
direct insert into Org A (`check constraint of an insert/update permission has
failed`). The five inconclusive checks go through Hasura Actions, which are not
in the GraphQL schema until `ACTION_BASE_URL` is configured on the Hasura side;
`verify:acceptance` covers those same denials by calling the handlers directly.
They are reported as inconclusive rather than as passes, because "the field does
not exist" is not evidence that a permission check ran.

**`npm test` — 10/10** offline tests over branch evaluation, template resolution
and the retry wrapper. **`npm run check:permissions` — 69 rules audited**, all
joining `org_members` and pinning the caller's role.

**UI, in a real browser.** As the Org A owner: org switcher, role badge, a live
quota bar reading 1/25, the workflow with its six steps and three triggers, and
a run view showing every step with the live indicator, the skipped branch and
the approval timestamp. As the Org A viewer: the same workflow, read-only — no
New workflow, no Save, no Run, no database-event panel. No app console errors
and no hydration warnings.

Two bugs this found, both fixed: `workflow_steps (workflow_id, position)` was
created `DEFERRABLE`, which Postgres refuses to use for `ON CONFLICT` — the
deferral was never needed, since a position is a slot whose contents are
rewritten rather than a value that moves between rows. And nhost rejects
parentheses in `displayName`.
