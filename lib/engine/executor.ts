import "server-only";

import { executeConditionalBranch } from "@/lib/engine/steps/conditionalBranch";
import { executeDbWrite } from "@/lib/engine/steps/dbWrite";
import { executeHttpRequest } from "@/lib/engine/steps/httpRequest";
import { executeLlmCall } from "@/lib/engine/steps/llmCall";
import { executeNotify } from "@/lib/engine/steps/notify";
import { StepExecutionError } from "@/lib/engine/retry";
import { emptyRunContext, type RunContext, type StepOutcome } from "@/lib/engine/types";
import { adminGraphql } from "@/lib/nhost/admin";
import type { RunStatus, StepRunStatus, StepType } from "@/lib/types";

/**
 * The run engine.
 *
 * executeRun() is idempotent with respect to completed steps: it skips anything
 * already in a terminal state and picks up at the first that is not. That single
 * property is what makes all of the following work with the same code path —
 * a fresh manual run, a webhook-triggered run, and resuming a run that was
 * paused at an approval gate hours earlier in a different process.
 *
 * Every status transition is written to the database as it happens, because the
 * frontend learns about progress exclusively through a GraphQL subscription on
 * `step_runs`. Nothing is streamed back to the caller.
 */

const TERMINAL_STEP_STATUSES = new Set<StepRunStatus>(["succeeded", "skipped", "failed"]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["succeeded", "failed"]);

interface ExecutableStep {
  id: string;
  position: number;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
  branch_key: "true" | "false" | null;
}

interface RunRow {
  id: string;
  workflow_id: string;
  org_id: string;
  status: RunStatus;
  started_at: string | null;
  context: RunContext | null;
  workflow: { id: string; name: string; steps: ExecutableStep[] } | null;
  step_runs: { id: string; position: number; status: StepRunStatus }[];
}

const nowIso = () => new Date().toISOString();

const RUN_FOR_EXECUTION = `
  query RunForExecution($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      workflow_id
      org_id
      status
      started_at
      context
      workflow {
        id
        name
        steps(order_by: {position: asc}) {
          id
          position
          name
          type
          config
          branch_key
        }
      }
      step_runs(order_by: {position: asc}) {
        id
        position
        status
      }
    }
  }
`;

async function loadRun(runId: string): Promise<RunRow | null> {
  const data = await adminGraphql<{ workflow_runs_by_pk: RunRow | null }>(RUN_FOR_EXECUTION, {
    runId,
  });
  return data.workflow_runs_by_pk;
}

async function patchRun(runId: string, patch: Record<string, unknown>): Promise<void> {
  await adminGraphql(
    `mutation PatchRun($runId: uuid!, $patch: workflow_runs_set_input!) {
       update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: $patch) { id }
     }`,
    { runId, patch },
  );
}

/**
 * Creates the step_run row, or reuses the one already there for this position
 * (a resumed run re-enters the loop at the same coordinates).
 */
async function openStepRun(
  runId: string,
  step: ExecutableStep,
  patch: Record<string, unknown>,
): Promise<string> {
  const data = await adminGraphql<{ insert_step_runs_one: { id: string } }>(
    `mutation OpenStepRun($object: step_runs_insert_input!) {
       insert_step_runs_one(
         object: $object,
         on_conflict: {
           constraint: step_runs_workflow_run_id_position_key,
           update_columns: [status, input, output, error, started_at, finished_at, attempt_count, step_name, step_type, workflow_step_id]
         }
       ) { id }
     }`,
    {
      object: {
        workflow_run_id: runId,
        workflow_step_id: step.id,
        position: step.position,
        step_name: step.name,
        step_type: step.type,
        ...patch,
      },
    },
  );
  return data.insert_step_runs_one.id;
}

async function patchStepRun(stepRunId: string, patch: Record<string, unknown>): Promise<void> {
  await adminGraphql(
    `mutation PatchStepRun($stepRunId: uuid!, $patch: step_runs_set_input!) {
       update_step_runs_by_pk(pk_columns: {id: $stepRunId}, _set: $patch) { id }
     }`,
    { stepRunId, patch },
  );
}

/**
 * Moves a run to a terminal state and, if this call is the one that actually
 * made the transition, consumes one unit of the org's quota.
 *
 * The `status: {_nin: [...]}` guard means two concurrent finishers cannot both
 * increment: only one update reports affected_rows = 1.
 */
async function finishRun(
  runId: string,
  orgId: string,
  status: Extract<RunStatus, "succeeded" | "failed">,
  error: string | null,
): Promise<void> {
  const data = await adminGraphql<{ update_workflow_runs: { affected_rows: number } }>(
    `mutation FinishRun($runId: uuid!, $status: String!, $error: String, $finishedAt: timestamptz!) {
       update_workflow_runs(
         where: {id: {_eq: $runId}, status: {_nin: ["succeeded", "failed"]}},
         _set: {status: $status, error: $error, finished_at: $finishedAt}
       ) { affected_rows }
     }`,
    { runId, status, error, finishedAt: nowIso() },
  );

  if (data.update_workflow_runs.affected_rows === 1) {
    await adminGraphql(
      `mutation ConsumeQuota($orgId: uuid!) {
         update_organizations_by_pk(pk_columns: {id: $orgId}, _inc: {quota_used: 1}) {
           id
           quota_used
         }
       }`,
      { orgId },
    );
  }
}

function normaliseContext(context: RunContext | null): RunContext {
  if (!context || typeof context !== "object") return emptyRunContext();
  return { ...emptyRunContext(), ...context, steps: context.steps ?? {} };
}

function applyOutcome(
  context: RunContext,
  step: ExecutableStep,
  outcome: Extract<StepOutcome, { kind: "value" }>,
): RunContext {
  return {
    ...context,
    steps: {
      ...context.steps,
      [step.position]: { name: step.name, type: step.type, output: outcome.output },
    },
    last: outcome.output,
    branch: outcome.branch ?? context.branch ?? null,
  };
}

async function dispatch(
  step: ExecutableStep,
  runId: string,
  orgId: string,
  stepRunId: string,
  context: RunContext,
): Promise<StepOutcome> {
  const executionContext = {
    runId,
    orgId,
    stepRunId,
    stepName: step.name,
    runContext: context,
  };
  const config = step.config ?? {};

  switch (step.type) {
    case "llm_call":
      return executeLlmCall(config, executionContext);
    case "http_request":
      return executeHttpRequest(config, executionContext);
    case "db_write":
      return executeDbWrite(config, executionContext);
    case "notify":
      return executeNotify(config, executionContext);
    case "conditional_branch":
      return executeConditionalBranch(config, executionContext);
    case "approval_gate":
      return { kind: "pause", reason: "awaiting approval" };
    default:
      throw new Error(`Unknown step type '${step.type as string}'`);
  }
}

export async function executeRun(runId: string): Promise<RunStatus> {
  const run = await loadRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return run.status;
  if (!run.workflow) throw new Error(`Run ${runId} has no workflow`);

  await patchRun(runId, {
    status: "running",
    started_at: run.started_at ?? nowIso(),
    error: null,
  });

  let context = normaliseContext(run.context);
  const alreadyDone = new Map(run.step_runs.map((entry) => [entry.position, entry.status]));

  for (const step of run.workflow.steps) {
    const previousStatus = alreadyDone.get(step.position);
    if (previousStatus && TERMINAL_STEP_STATUSES.has(previousStatus)) continue;

    // A step tagged with a branch only runs on the matching side of the most
    // recent conditional_branch; the other side is recorded as skipped so the
    // live view shows what the branch decided rather than silently omitting it.
    if (step.branch_key && context.branch !== step.branch_key) {
      await openStepRun(runId, step, {
        status: "skipped",
        output: {
          skipped_because: `branch is ${context.branch ?? "unset"}, step requires ${step.branch_key}`,
        },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
      continue;
    }

    const stepRunId = await openStepRun(runId, step, {
      status: "running",
      input: step.config ?? {},
      error: null,
      output: null,
      started_at: nowIso(),
      finished_at: null,
    });

    if (step.type === "approval_gate") {
      // Pause: the run stops here and the request returns. Resuming is a
      // separate call (approveStep -> executeRun) after the Layer 2 role check.
      await patchStepRun(stepRunId, { status: "awaiting_approval" });
      await patchRun(runId, { status: "paused", context });
      return "paused";
    }

    try {
      const outcome = await dispatch(step, runId, run.org_id, stepRunId, context);
      if (outcome.kind === "pause") {
        await patchStepRun(stepRunId, { status: "awaiting_approval" });
        await patchRun(runId, { status: "paused", context });
        return "paused";
      }

      context = applyOutcome(context, step, outcome);
      await patchStepRun(stepRunId, {
        status: "succeeded",
        output: outcome.output ?? null,
        attempt_count: outcome.attempts,
        finished_at: nowIso(),
      });
      await patchRun(runId, { context });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = error instanceof StepExecutionError ? error.attempts : 1;

      await patchStepRun(stepRunId, {
        status: "failed",
        error: { message, step: step.name },
        attempt_count: attempts,
        finished_at: nowIso(),
      });
      await finishRun(runId, run.org_id, "failed", `Step "${step.name}" failed: ${message}`);
      return "failed";
    }
  }

  await finishRun(runId, run.org_id, "succeeded", null);
  return "succeeded";
}
