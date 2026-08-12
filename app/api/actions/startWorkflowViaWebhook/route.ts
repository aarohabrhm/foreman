import {
  ActionError,
  actionErrorResponse,
  readActionRequest,
  dispatchRun,
} from "@/lib/actions/handler";
import { tokensMatch } from "@/lib/actions/tokens";
import { createRun, loadWorkflowForRun } from "@/lib/engine/startRun";
import { adminGraphql } from "@/lib/nhost/admin";

export const maxDuration = 60;

interface Input {
  workflow_id?: string;
  token?: string;
  payload_json?: string | null;
}

/**
 * Hasura Action: startWorkflowViaWebhook(workflow_id, token, payload_json)
 *
 * The inbound endpoint external systems call to start a run — no user session
 * involved, so it is exposed to Hasura's unauthenticated `public` role and
 * authenticates with the trigger's own bearer token instead.
 *
 * Only the token's SHA-256 hash is stored, and only an owner can create a
 * webhook trigger in the first place (assertCanConfigureTrigger, Layer 2).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { input } = await readActionRequest<Input>(request);

    const workflowId = input.workflow_id?.trim();
    const token = input.token?.trim();
    if (!workflowId) throw new ActionError("workflow_id is required");
    if (!token) throw new ActionError("token is required");

    const trigger = await loadWebhookTrigger(workflowId);
    // One message for every failure mode: wrong id, wrong token, disabled
    // trigger. A caller probing ids must not be able to tell them apart.
    const rejected = new ActionError("Unknown workflow or token", 403, "webhook-rejected");

    if (!trigger?.token_hash || !trigger.is_enabled) throw rejected;
    if (!tokensMatch(token, trigger.token_hash)) throw rejected;

    const workflow = await loadWorkflowForRun(workflowId);
    if (!workflow) throw rejected;

    const runId = await createRun({
      workflow,
      triggerType: "webhook",
      triggeredBy: null,
      triggerPayload: parsePayload(input.payload_json),
    });

    dispatchRun(runId);

    return Response.json({ run_id: runId, status: "running" });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

async function loadWebhookTrigger(
  workflowId: string,
): Promise<{ id: string; token_hash: string | null; is_enabled: boolean } | null> {
  const data = await adminGraphql<{
    workflow_triggers: { id: string; token_hash: string | null; is_enabled: boolean }[];
  }>(
    `query WebhookTrigger($workflowId: uuid!) {
       workflow_triggers(
         where: {workflow_id: {_eq: $workflowId}, trigger_type: {_eq: "webhook"}},
         limit: 1
       ) { id token_hash is_enabled }
     }`,
    { workflowId },
  );
  return data.workflow_triggers[0] ?? null;
}

function parsePayload(raw: string | null | undefined): unknown {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ActionError("payload_json is not valid JSON");
  }
}
