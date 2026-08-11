import "server-only";

import { renderTemplate } from "@/lib/engine/template";
import type { StepExecutionContext, StepOutcome } from "@/lib/engine/types";
import { adminGraphql } from "@/lib/nhost/admin";

export interface NotifyConfig {
  channel?: string;
  message?: string;
}

/**
 * Slack/email alert, delivered by a Hasura Event Trigger.
 *
 * The step itself only enqueues: it inserts a `notifications` row and returns.
 * Hasura's Event Trigger on that table then calls /api/hooks/notify, which
 * delivers the message and stamps the row. Delivery is therefore asynchronous
 * and retried by Hasura, and a slow Slack endpoint cannot stall the run.
 *
 * Adding this step type to a workflow is owner-only — see
 * assertCanCreateStepType in lib/auth/layer2.ts.
 */
export async function executeNotify(
  config: NotifyConfig,
  context: StepExecutionContext,
): Promise<StepOutcome> {
  const rendered = renderTemplate(config, context.runContext);
  const message = (rendered.message ?? "").trim() || `Workflow step "${context.stepName}" reached`;
  const channel = rendered.channel ?? "slack";

  const data = await adminGraphql<{ insert_notifications_one: { id: string } }>(
    `mutation EnqueueNotification($object: notifications_insert_input!) {
       insert_notifications_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: context.orgId,
        workflow_run_id: context.runId,
        step_run_id: context.stepRunId,
        channel,
        message,
      },
    },
  );

  return {
    kind: "value",
    attempts: 1,
    output: {
      notification_id: data.insert_notifications_one.id,
      channel,
      message,
      delivery: "queued — delivered asynchronously by the Hasura Event Trigger",
    },
  };
}
