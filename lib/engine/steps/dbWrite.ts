import "server-only";

import { renderTemplate } from "@/lib/engine/template";
import type { StepExecutionContext, StepOutcome } from "@/lib/engine/types";
import { adminGraphql } from "@/lib/nhost/admin";

export interface DbWriteConfig {
  label?: string;
  payload?: unknown;
}

/**
 * Saves a result into our own tables (`db_write_results`).
 *
 * Adding this step type to a workflow is owner-only — see
 * assertCanCreateStepType in lib/auth/layer2.ts.
 */
export async function executeDbWrite(
  config: DbWriteConfig,
  context: StepExecutionContext,
): Promise<StepOutcome> {
  const rendered = renderTemplate(config, context.runContext);

  const data = await adminGraphql<{
    insert_db_write_results_one: { id: string; created_at: string };
  }>(
    `mutation WriteResult($object: db_write_results_insert_input!) {
       insert_db_write_results_one(object: $object) { id created_at }
     }`,
    {
      object: {
        org_id: context.orgId,
        workflow_run_id: context.runId,
        step_run_id: context.stepRunId,
        label: rendered.label ?? context.stepName,
        payload: rendered.payload ?? {},
      },
    },
  );

  return {
    kind: "value",
    attempts: 1,
    output: {
      record_id: data.insert_db_write_results_one.id,
      label: rendered.label ?? context.stepName,
      written_at: data.insert_db_write_results_one.created_at,
    },
  };
}
