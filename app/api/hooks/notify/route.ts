import { actionErrorResponse, assertCallerIsHasura } from "@/lib/actions/handler";
import { serverEnv } from "@/lib/env";
import { adminGraphql } from "@/lib/nhost/admin";

/**
 * Hasura Event Trigger: notifications INSERT -> deliver the message.
 *
 * This is how the `notify` step type is implemented. Hasura owns the delivery
 * attempt (and its retries); the step itself only enqueues a row, so a slow or
 * failing Slack endpoint never stalls a workflow run.
 *
 * With SLACK_WEBHOOK_URL unset, delivery is a disclosed stub: the row is marked
 * `stubbed` and a line is logged. Nothing pretends the message was sent.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertCallerIsHasura(request);

    const body = (await request.json()) as {
      event?: { data?: { new?: { id?: string; message?: string; channel?: string } } };
    };
    const row = body.event?.data?.new;
    if (!row?.id) return Response.json({ skipped: "no row in payload" });

    const webhookUrl = serverEnv.slackWebhookUrl();

    if (!webhookUrl) {
      console.warn(
        `[foreman] STUBBED notify (${row.channel ?? "slack"}) — SLACK_WEBHOOK_URL is not set. ` +
          `Message was: ${row.message}`,
      );
      await markDelivered(row.id, "stubbed", null);
      return Response.json({ delivered: false, stubbed: true });
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: row.message ?? "" }),
      });
      if (!response.ok) {
        throw new Error(`Slack responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      await markDelivered(row.id, "sent", null);
      return Response.json({ delivered: true });
    } catch (deliveryError) {
      const message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
      await markDelivered(row.id, "failed", message);
      // 500 lets Hasura's own retry policy take over.
      return Response.json({ delivered: false, error: message }, { status: 500 });
    }
  } catch (error) {
    return actionErrorResponse(error);
  }
}

async function markDelivered(
  notificationId: string,
  status: "sent" | "stubbed" | "failed",
  error: string | null,
): Promise<void> {
  await adminGraphql(
    `mutation MarkNotification($id: uuid!, $status: String!, $error: String, $at: timestamptz!) {
       update_notifications_by_pk(
         pk_columns: {id: $id},
         _set: {status: $status, error: $error, delivered_at: $at}
       ) { id }
     }`,
    { id: notificationId, status, error, at: new Date().toISOString() },
  );
}
