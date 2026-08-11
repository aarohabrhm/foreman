import type { StepType } from "@/lib/types";

/**
 * Everything a run accumulates as it executes, persisted on
 * `workflow_runs.context` after every step.
 *
 * Persisting it is what makes pause/resume work: the request that resumes an
 * approved run is a completely different HTTP request (often a different
 * serverless instance) from the one that paused it, and it rebuilds its state
 * from this column alone.
 */
export interface RunContext {
  /** Payload the trigger supplied (webhook body, watched row, cron tick). */
  trigger?: unknown;
  /** Output of every step that has run, keyed by position. */
  steps: Record<string, { name: string; type: StepType; output: unknown }>;
  /** Output of the most recent successful step — what `{{last}}` resolves to. */
  last?: unknown;
  /** Result of the most recent conditional_branch, gating later steps. */
  branch?: "true" | "false" | null;
}

export interface StepExecutionContext {
  runId: string;
  orgId: string;
  stepRunId: string;
  stepName: string;
  runContext: RunContext;
}

export type StepOutcome =
  | {
      kind: "value";
      output: unknown;
      attempts: number;
      /** Set by conditional_branch to gate subsequent steps. */
      branch?: "true" | "false";
    }
  | {
      kind: "pause";
      reason: string;
    };

export const emptyRunContext = (): RunContext => ({ steps: {}, branch: null });
