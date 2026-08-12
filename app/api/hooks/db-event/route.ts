import { actionErrorResponse, assertCallerIsHasura, dispatchRun } from "@/lib/actions/handler";
import { createRun, loadWorkflowForRun } from "@/lib/engine/startRun";
import { adminGraphql } from "@/lib/nhost/admin";

export const maxDuration = 60;

interface WatchedRecord {
  id: string;
  org_id: string;
  label?: string | null;
  payload?: unknown;
}

/**
 * Hasura Event Trigger: watched_records INSERT -> start runs.
 *
 * A row change in a watched table auto-starts a run, with no button click and
 * no user session: every workflow in that row's organization with an enabled
 * `database_event` trigger is started, with the row itself as the trigger
 * payload (so `{{trigger.payload...}}` resolves inside step configs).
 *
 * A trigger's config may carry {"label": "..."} to respond to only some rows.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertCallerIsHasura(request);

    const body = (await request.json()) as {
      event?: { data?: { new?: WatchedRecord } };
    };
    const row = body.event?.data?.new;
    if (!row?.id || !row.org_id) return Response.json({ skipped: "no row in payload" });

    const candidates = await loadEventTriggeredWorkflows(row.org_id);
    const matching = candidates.filter((candidate) => {
      const wanted = candidate.trigger_config?.label;
      return !wanted || wanted === row.label;
    });

    const started: string[] = [];
    for (const candidate of matching) {
      const workflow = await loadWorkflowForRun(candidate.workflow_id);
      if (!workflow) continue;

      try {
        const runId = await createRun({
          workflow,
          triggerType: "database_event",
          triggeredBy: null,
          triggerPayload: { source: "watched_records", record: row },
        });
        dispatchRun(runId);
        started.push(runId);
      } catch (error) {
        // One workflow being out of quota must not stop the others.
        console.warn(
          `[foreman] database_event: could not start ${candidate.workflow_id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return Response.json({ started_runs: started });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

async function loadEventTriggeredWorkflows(
  orgId: string,
): Promise<{ workflow_id: string; trigger_config: { label?: string } | null }[]> {
  const data = await adminGraphql<{
    workflow_triggers: { workflow_id: string; config: { label?: string } | null }[];
  }>(
    `query EventTriggeredWorkflows($orgId: uuid!) {
       workflow_triggers(
         where: {
           trigger_type: {_eq: "database_event"},
           is_enabled: {_eq: true},
           workflow: {org_id: {_eq: $orgId}}
         }
       ) { workflow_id config }
     }`,
    { orgId },
  );
  return data.workflow_triggers.map((row) => ({
    workflow_id: row.workflow_id,
    trigger_config: row.config,
  }));
}
