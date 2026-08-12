# Foreman — design write-up

## Schema reasoning

The schema is shaped by one requirement above all others: **cross-org isolation
must hold against ID guessing**. That means every tenant-owned row has to reach
the caller's membership in one or two joins, so `org_members` is the hub —
`organizations -> org_members -> workflows -> steps/triggers`, and
`workflows -> workflow_runs -> step_runs`. A table that could not reach
`org_members` could not be safely exposed at all.

Three decisions are worth calling out. **`workflow_runs.org_id` is denormalised**
from `workflows`: it keeps the usage aggregate a single-table scan and lets the
permission rule on runs join `org_members` in one hop instead of two.
**`step_runs` snapshots `position`, `step_name` and `step_type`** rather than only
pointing at `workflow_steps`, because runs are history — editing a workflow next
week must not rewrite what happened last week (the FK is `ON DELETE SET NULL`, so
history also survives step deletion). **`workflow_runs.context` is the run's
memory**: every step's output is merged in and persisted immediately, which is
what makes resumption possible and what `{{last.text}}` resolves against.

Quota is stored twice, deliberately. `organizations.quota_used` is the counter
enforcement reads and the engine increments; the required aggregation — the
`org_usage_current_period` view — recomputes usage, success count and average run
duration from `workflow_runs`. The UI subscribes to the view, so the number on
screen is derived from the runs themselves rather than trusted from a counter.

## How the two permission layers are enforced differently

They answer different questions, so they live in different places.

**Layer 1 — Hasura row rules (`nhost/metadata/**`).** *"May this caller touch this
row?"* Declarative, evaluated per row on every request, including subscriptions.
All 69 rules share one shape:

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

## How the approval-gate pause/resume is implemented

`executeRun(runId)` walks the workflow's steps in order and **skips any step
already in a terminal state** (`succeeded`, `skipped`, `failed`). That single
property does all the work.

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

---

# Appendix A — Verification

Executed against the live nhost project (`cdwilajfcvntdjqwhzlc`, eu-central-1)
and the deployed app at **https://foreman-two-sigma.vercel.app**, with a real
Groq key.

| Suite | Result | What it covers |
| --- | --- | --- |
| `npm run verify:live` | **12/12** | Full path: browser -> Hasura -> Action -> deployed handler -> engine -> subscription. The only suite that exercises the deployed wiring. |
| `npm run verify:acceptance` | **15/15** | The whole acceptance scenario, handlers driven with Hasura's exact payload. |
| `npm run verify:triggers` | **13/13** | Webhook, database-event, cron cadence, notify delivery, shared-secret rejection. |
| `npm run verify:layer2` | **11/11** | Owner-only step and trigger rules in both directions, plus reordering and step removal. |
| `npm run test:cross-org` | **13/13** | Attacks Org A by ID as a real Org B user. |
| `npm test` | **10/10** | Branch evaluation, template resolution, retry. |
| `npm run check:permissions` | 69 rules | Static audit: every Layer 1 rule joins `org_members` and pins its role. |

`verify:live`, abbreviated:

```
PASS  Hasura routes triggerWorkflowRun to the deployed handler
PASS  the deployed engine executes the steps and pauses at the gate
PASS  the branch was evaluated on the server — 3 succeeded, 1 skipped
PASS  a viewer cannot approve, through the real Action
PASS  an Org B owner cannot approve an Org A gate, through the real Action
PASS  an editor can approve, through the real Action
PASS  the run resumes on the deployed app and completes — status=succeeded
PASS  an unauthenticated webhook call starts a run
PASS  Hasura's Event Trigger starts a run with no button click
PASS  the notify step's message is delivered by the Event Trigger
```

**Cross-org isolation** is proven, not merely configured: reads by ID under
*every* role Org B can claim (owner, editor, viewer, user), listings filtered by
`org_id`, `step_runs` by run ID, a live websocket subscription to an Org A run
(zero rows), a direct insert into Org A (`check constraint of an insert/update
permission has failed`), and refusals from `triggerWorkflowRun`, `approveStep`
and `saveWorkflow` carrying real permission reasons rather than schema errors.
The suite deliberately reports a check as *inconclusive* rather than passed if a
request failed for the wrong reason.

**In the browser, on the deployed app:** pressing Run streams steps live, skips
the untaken branch, pauses at the gate, and — after *Approve and continue* —
resumes through `db_write` and `notify` to all seven steps green, no refresh. As
a viewer: no Run, no Save, no approve control.

# Appendix B — Bugs found by running it for real

1. **Runs created but never executed on Vercel** — the serious one, described
   above. Fire-and-forget after the response is unreliable on serverless.
2. **`workflow_steps (workflow_id, position)` was `DEFERRABLE`**, which Postgres
   refuses to use for `ON CONFLICT`, breaking every step upsert. The deferral was
   never needed: a position is a slot whose contents are rewritten, not a value
   that moves between rows.
3. **The quota never rolled over.** `quota_period_start` was stored but never
   advanced, so an org that hit its allowance was locked out permanently while
   the error advised waiting for a period that would never arrive.
4. **nhost rejects parentheses in `displayName`**, which broke user seeding.

Only the first was reachable through the UI, and only in production. That is why
the suites are split: `verify:acceptance` and `verify:triggers` prove the handler
logic anywhere, and `verify:live` proves the deployed wiring. Passing the first
two while failing the third is exactly the state that bug produced.

# Appendix C — Declared deviations

- **Action handlers are Next.js API routes, not nhost Functions.** The stack lists
  Functions; the handlers live in the Next.js app instead, so one deploy covers
  the frontend and the engine and the Layer 2 checks sit beside the UI that
  respects them. Functionally equivalent.
- **nhost Storage is unused** — no requirement needs file storage.
- **`notify` delivery is stubbed** unless `SLACK_WEBHOOK_URL` is set: the row is
  marked `stubbed` and logged rather than claiming to have been sent.
- **Seeded accounts can present all three roles.** nhost models allowed roles per
  user and globally; this app models them per organization. Granting all three
  makes the central claim testable — holding `owner` in the JWT buys nothing,
  because every rule still has to find a matching `org_members` row.
