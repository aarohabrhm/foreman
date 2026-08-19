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
export interface RunStepEntry {
  name: string;
  type: StepType;
  output: unknown;
  /**
   * Set by conditional_branch. A labelled outgoing connection is matched
   * against THIS step's value, not a shared one, which is what lets a workflow
   * hold two independent conditionals — and what lets a resumed run rebuild
   * which branches were taken before it paused.
   */
  branch?: "true" | "false" | null;
}

export interface RunContext {
  /** Payload the trigger supplied (webhook body, watched row, cron tick). */
  trigger?: unknown;
  /**
   * Output of every step that has run, keyed by slug — and also by position, so
   * configs written against the old list model ({{steps.0.output.text}}) keep
   * resolving. Slugs are required to start with a letter, so the two key spaces
   * cannot collide.
   */
  steps: Record<string, RunStepEntry>;
  /** Output of the most recent successful step — what `{{last}}` resolves to. */
  last?: unknown;
  /**
   * Result of the most recent conditional_branch. This NO LONGER GATES
   * ANYTHING — the connections do — and is kept only so that `{{branch}}` in an
   * existing config still resolves.
   */
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
      /** Set by conditional_branch. Matched against its labelled connections. */
      branch?: "true" | "false";
    }
  | {
      kind: "pause";
      reason: string;
    };

export const emptyRunContext = (): RunContext => ({ steps: {}, branch: null });
