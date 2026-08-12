import type { StepType, TriggerType } from "@/lib/types";

/**
 * Starting configs for the builder.
 *
 * Step config is edited as JSON — deliberately, because it keeps every step type
 * editable without a bespoke form per type, and it is what the engine actually
 * receives. Templates like `{{last.text}}` resolve against the run context
 * (see lib/engine/template.ts).
 */

export const STEP_LABELS: Record<StepType, string> = {
  llm_call: "LLM call",
  http_request: "HTTP request",
  db_write: "Database write",
  notify: "Notify",
  conditional_branch: "Conditional branch",
  approval_gate: "Approval gate",
};

export const STEP_HINTS: Record<StepType, string> = {
  llm_call: "Calls Groq. Retried once on failure.",
  http_request: "Calls any external API. Retried once on failure.",
  db_write: "Writes into db_write_results. Owner-only.",
  notify: "Enqueues a Slack message, delivered by a Hasura Event Trigger. Owner-only.",
  conditional_branch:
    "Sets the run's branch. Later steps tagged true/false run only on the matching side.",
  approval_gate: "Pauses the run until an owner or editor approves it.",
};

/** Step types only an owner may add — mirrors assertCanCreateStepType (Layer 2). */
export const OWNER_ONLY_STEP_TYPES: StepType[] = ["db_write", "notify"];

/** Trigger types only an owner may configure — mirrors assertCanConfigureTrigger. */
export const OWNER_ONLY_TRIGGER_TYPES: TriggerType[] = ["webhook"];

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  manual: "Manual (Run button)",
  webhook: "Webhook (external systems)",
  scheduled: "Scheduled (cron)",
  database_event: "Database event (watched_records)",
};

export function defaultStepConfig(type: StepType): string {
  const templates: Record<StepType, unknown> = {
    llm_call: {
      system: "You triage inbound support requests. Answer with one word: URGENT or ROUTINE.",
      prompt: "Classify this request: {{trigger.text}}",
      temperature: 0,
      max_tokens: 32,
    },
    http_request: {
      method: "POST",
      url: "https://postman-echo.com/post",
      body: { classification: "{{last.text}}" },
    },
    db_write: {
      label: "triage-result",
      payload: { classification: "{{last.text}}" },
    },
    notify: {
      channel: "slack",
      message: "Workflow reached the notify step: {{last.text}}",
    },
    conditional_branch: {
      left: "{{last.text}}",
      operator: "contains",
      right: "URGENT",
    },
    approval_gate: {
      instructions: "Review the classification before the result is written.",
      approver_roles: ["owner", "editor"],
    },
  };

  return JSON.stringify(templates[type], null, 2);
}

export function defaultTriggerConfig(type: TriggerType): string {
  const templates: Record<TriggerType, unknown> = {
    manual: {},
    webhook: {},
    scheduled: { every_minutes: 60 },
    database_event: { label: "support-ticket" },
  };
  return JSON.stringify(templates[type], null, 2);
}
