import { actionErrorResponse, assertCallerIsHasura, dispatchRun } from "@/lib/actions/handler";
import { createRun, loadWorkflowForRun } from "@/lib/engine/startRun";
import { adminGraphql } from "@/lib/nhost/admin";

export const maxDuration = 60;

const DEFAULT_INTERVAL_MINUTES = 60;

/**
 * Hasura cron trigger -> scheduled runs.
 *
 * Hasura's own scheduler ticks this endpoint (see nhost/metadata/cron_triggers.yaml);
 * each workflow's `scheduled` trigger then declares its cadence in config as
 * {"every_minutes": N}, and a workflow starts only when its last scheduled run
 * is older than that. One cron trigger therefore serves every workflow, and
 * cadence is data rather than metadata that must be rewritten per workflow.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertCallerIsHasura(request);

    const due = await loadScheduledTriggers();
    const now = Date.now();
    const started: string[] = [];

    for (const trigger of due) {
      const intervalMinutes = Number(trigger.config?.every_minutes) || DEFAULT_INTERVAL_MINUTES;
      const lastRunAt = trigger.last_scheduled_run_at
        ? new Date(trigger.last_scheduled_run_at).getTime()
        : null;

      if (lastRunAt !== null && now - lastRunAt < intervalMinutes * 60_000) continue;

      const workflow = await loadWorkflowForRun(trigger.workflow_id);
      if (!workflow) continue;

      try {
        const runId = await createRun({
          workflow,
          triggerType: "scheduled",
          triggeredBy: null,
          triggerPayload: { source: "cron", every_minutes: intervalMinutes, at: new Date().toISOString() },
        });
        dispatchRun(runId);
        started.push(runId);
      } catch (error) {
        console.warn(
          `[foreman] scheduled: could not start ${trigger.workflow_id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return Response.json({ started_runs: started });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

interface ScheduledTrigger {
  workflow_id: string;
  config: { every_minutes?: number } | null;
  last_scheduled_run_at: string | null;
}

async function loadScheduledTriggers(): Promise<ScheduledTrigger[]> {
  const data = await adminGraphql<{
    workflow_triggers: {
      workflow_id: string;
      config: { every_minutes?: number } | null;
      workflow: { runs: { created_at: string }[] } | null;
    }[];
  }>(
    `query ScheduledTriggers {
       workflow_triggers(
         where: {trigger_type: {_eq: "scheduled"}, is_enabled: {_eq: true}}
       ) {
         workflow_id
         config
         workflow {
           runs(
             where: {trigger_type: {_eq: "scheduled"}},
             order_by: {created_at: desc},
             limit: 1
           ) { created_at }
         }
       }
     }`,
  );

  return data.workflow_triggers.map((row) => ({
    workflow_id: row.workflow_id,
    config: row.config,
    last_scheduled_run_at: row.workflow?.runs[0]?.created_at ?? null,
  }));
}
