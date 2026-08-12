import {
  ActionError,
  actionErrorResponse,
  readActionRequest,
  dispatchRun,
} from "@/lib/actions/handler";
import { assertCanTriggerRun, loadMembership, notFound } from "@/lib/auth/layer2";
import { createRun, loadWorkflowForRun } from "@/lib/engine/startRun";

export const maxDuration = 60;

interface Input {
  workflow_id?: string;
  input_json?: string | null;
}

/**
 * Hasura Action: triggerWorkflowRun(workflow_id, input_json)
 *
 *   1. verify the caller is owner/editor in the workflow's org   (Layer 2)
 *   2. verify the org's quota is not exhausted                   (Layer 2)
 *   3. create the run, then execute its steps in order
 *   4. return the run id immediately — progress is published through the
 *      step_runs subscription, not this response
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { input, userId } = await readActionRequest<Input>(request);

    if (!userId) throw new ActionError("Not signed in", 401, "unauthenticated");
    const workflowId = input.workflow_id?.trim();
    if (!workflowId) throw new ActionError("workflow_id is required");

    // Loaded with admin rights, then authorized explicitly: an unknown id and an
    // id belonging to another org must be indistinguishable from out here.
    const workflow = await loadWorkflowForRun(workflowId);
    const membership = workflow ? await loadMembership(userId, workflow.org_id) : null;
    if (!workflow || !membership) throw notFound("Workflow", workflowId);

    assertCanTriggerRun(membership);

    const runId = await createRun({
      workflow,
      triggerType: "manual",
      triggeredBy: userId,
      triggerPayload: parseInputJson(input.input_json),
    });

    dispatchRun(runId);

    return Response.json({ run_id: runId, status: "running" });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

function parseInputJson(raw: string | null | undefined): unknown {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ActionError("input_json is not valid JSON");
  }
}
