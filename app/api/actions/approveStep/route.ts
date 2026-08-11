import {
  ActionError,
  actionErrorResponse,
  readActionRequest,
  runInBackground,
} from "@/lib/actions/handler";
import { assertCanApprove, loadMembership, notFound } from "@/lib/auth/layer2";
import { executeRun } from "@/lib/engine/executor";
import { adminGraphql } from "@/lib/nhost/admin";

export const maxDuration = 60;

interface Input {
  step_run_id?: string;
  note?: string | null;
}

interface PausedStepRun {
  id: string;
  status: string;
  step_name: string;
  workflow_run_id: string;
  step: { config: Record<string, unknown> | null } | null;
  run: { id: string; org_id: string; status: string };
}

/**
 * Hasura Action: approveStep(step_run_id, note)
 *
 * This is the Layer 2 case that cannot be a Hasura permission. Nothing is being
 * read or written at the moment of the decision — a run is sitting at `paused`
 * and someone is asking for it to continue. The handler therefore checks the
 * approver's role itself (assertCanApprove) and only then resumes execution.
 *
 * Note that step_runs grants no update permission to any role, so approving is
 * only possible through this handler: an editor cannot stamp approved_by with a
 * direct mutation and leave the run stuck at paused.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { input, userId } = await readActionRequest<Input>(request);

    if (!userId) throw new ActionError("Not signed in", 401, "unauthenticated");
    const stepRunId = input.step_run_id?.trim();
    if (!stepRunId) throw new ActionError("step_run_id is required");

    const stepRun = await loadPausedStepRun(stepRunId);
    const membership = stepRun ? await loadMembership(userId, stepRun.run.org_id) : null;
    if (!stepRun || !membership) throw notFound("Step", stepRunId);

    if (stepRun.status !== "awaiting_approval") {
      throw new ActionError(
        `Step "${stepRun.step_name}" is not awaiting approval (it is ${stepRun.status})`,
        409,
        "not-awaiting-approval",
      );
    }

    // ---- LAYER 2: the approval decision itself -----------------------------
    assertCanApprove(membership, stepRun.step?.config ?? null);

    const approvedAt = new Date().toISOString();
    await adminGraphql(
      `mutation ApproveStep($stepRunId: uuid!, $approvedBy: uuid!, $approvedAt: timestamptz!, $output: jsonb!) {
         update_step_runs_by_pk(
           pk_columns: {id: $stepRunId},
           _set: {status: "succeeded", approved_by: $approvedBy, approved_at: $approvedAt,
                  finished_at: $approvedAt, output: $output}
         ) { id }
       }`,
      {
        stepRunId,
        approvedBy: userId,
        approvedAt,
        output: {
          approved: true,
          approved_by: userId,
          approver_role: membership.role,
          note: input.note ?? null,
        },
      },
    );

    // Resume from where the run paused. executeRun() skips every step already in
    // a terminal state, so the gate we just stamped is stepped over and the next
    // step is the one that runs.
    await adminGraphql(
      `mutation ResumeRun($runId: uuid!) {
         update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {status: "running"}) { id }
       }`,
      { runId: stepRun.workflow_run_id },
    );

    runInBackground(executeRun(stepRun.workflow_run_id));

    return Response.json({
      run_id: stepRun.workflow_run_id,
      step_run_id: stepRunId,
      status: "running",
    });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

async function loadPausedStepRun(stepRunId: string): Promise<PausedStepRun | null> {
  const data = await adminGraphql<{ step_runs_by_pk: PausedStepRun | null }>(
    `query StepRunForApproval($stepRunId: uuid!) {
       step_runs_by_pk(id: $stepRunId) {
         id
         status
         step_name
         workflow_run_id
         step { config }
         run { id org_id status }
       }
     }`,
    { stepRunId },
  );
  return data.step_runs_by_pk;
}
