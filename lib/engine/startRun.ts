import "server-only";

import { assertQuotaAvailable } from "@/lib/auth/layer2";
import { adminGraphql } from "@/lib/nhost/admin";
import type { TriggerType } from "@/lib/types";

/**
 * Creating a run — shared by every trigger type.
 *
 * Manual, webhook, scheduled and database-event triggers all differ only in how
 * the caller is authorized and what payload they carry; from here on they are
 * the same run.
 */

export interface WorkflowForRun {
  id: string;
  name: string;
  org_id: string;
  org: { id: string; name: string; quota_used: number; quota_allowed: number };
}

export async function loadWorkflowForRun(workflowId: string): Promise<WorkflowForRun | null> {
  const data = await adminGraphql<{ workflows_by_pk: WorkflowForRun | null }>(
    `query WorkflowForRun($workflowId: uuid!) {
       workflows_by_pk(id: $workflowId) {
         id
         name
         org_id
         org { id name quota_used quota_allowed }
       }
     }`,
    { workflowId },
  );
  return data.workflows_by_pk;
}

export interface CreateRunOptions {
  workflow: WorkflowForRun;
  triggerType: TriggerType;
  triggeredBy?: string | null;
  /** Whatever started the run — webhook body, watched row, cron tick. */
  triggerPayload?: unknown;
}

/** First day of the current month, UTC — the start of a quota period. */
function currentPeriodStart(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-01`;
}

/**
 * Rolls the org's quota period forward if the stored one has elapsed.
 *
 * The quota is "calls used per period", so it has to actually reset — otherwise
 * an org that hits its allowance is locked out permanently and the "wait for the
 * next period" advice is a lie. The update is conditional on the stored period
 * being older than the current one, so concurrent runs cannot double-reset, and
 * whoever wins reports affected_rows = 1.
 */
async function rollQuotaPeriodIfElapsed(org: WorkflowForRun["org"]): Promise<WorkflowForRun["org"]> {
  const periodStart = currentPeriodStart();

  const data = await adminGraphql<{ update_organizations: { affected_rows: number } }>(
    `mutation RollQuotaPeriod($orgId: uuid!, $periodStart: date!) {
       update_organizations(
         where: {id: {_eq: $orgId}, quota_period_start: {_lt: $periodStart}},
         _set: {quota_period_start: $periodStart, quota_used: 0}
       ) { affected_rows }
     }`,
    { orgId: org.id, periodStart },
  );

  return data.update_organizations.affected_rows > 0 ? { ...org, quota_used: 0 } : org;
}

export async function createRun({
  workflow,
  triggerType,
  triggeredBy = null,
  triggerPayload = null,
}: CreateRunOptions): Promise<string> {
  const org = await rollQuotaPeriodIfElapsed(workflow.org);
  assertQuotaAvailable(org);

  const data = await adminGraphql<{ insert_workflow_runs_one: { id: string } }>(
    `mutation CreateRun($object: workflow_runs_insert_input!) {
       insert_workflow_runs_one(object: $object) { id }
     }`,
    {
      object: {
        workflow_id: workflow.id,
        org_id: workflow.org_id,
        trigger_type: triggerType,
        triggered_by: triggeredBy,
        status: "pending",
        input: triggerPayload ?? {},
        context: { steps: {}, branch: null, trigger: triggerPayload ?? null },
      },
    },
  );

  return data.insert_workflow_runs_one.id;
}
