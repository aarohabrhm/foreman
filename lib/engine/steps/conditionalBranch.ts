import { renderTemplate } from "@/lib/engine/template";
import type { StepExecutionContext, StepOutcome } from "@/lib/engine/types";

export interface ConditionalBranchConfig {
  /** Usually a template such as "{{last.text}}". */
  left?: unknown;
  operator?: string;
  right?: unknown;
}

/**
 * if/else on the previous step's output.
 *
 * Comparison is data-driven — no expression evaluation — and the result is
 * recorded as the run's current branch. Steps tagged `branch_key: 'true'` or
 * `'false'` then run or are marked `skipped` accordingly.
 */
export async function executeConditionalBranch(
  config: ConditionalBranchConfig,
  context: StepExecutionContext,
): Promise<StepOutcome> {
  const rendered = renderTemplate(config, context.runContext);
  const operator = (rendered.operator ?? "contains").toLowerCase();
  const left = rendered.left;
  const right = rendered.right;

  const result = evaluate(operator, left, right);

  return {
    kind: "value",
    attempts: 1,
    branch: result ? "true" : "false",
    output: { result, operator, left, right },
  };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(asText(value));
}

function evaluate(operator: string, left: unknown, right: unknown): boolean {
  switch (operator) {
    case "equals":
      return asText(left).trim() === asText(right).trim();
    case "not_equals":
      return asText(left).trim() !== asText(right).trim();
    case "contains":
      return asText(left).toLowerCase().includes(asText(right).toLowerCase());
    case "not_contains":
      return !asText(left).toLowerCase().includes(asText(right).toLowerCase());
    case "matches":
      return new RegExp(asText(right), "i").test(asText(left));
    case "gt":
      return asNumber(left) > asNumber(right);
    case "gte":
      return asNumber(left) >= asNumber(right);
    case "lt":
      return asNumber(left) < asNumber(right);
    case "lte":
      return asNumber(left) <= asNumber(right);
    case "truthy":
      return Boolean(left) && asText(left).trim() !== "" && asText(left) !== "false";
    case "falsy":
      return !left || asText(left).trim() === "" || asText(left) === "false";
    default:
      throw new Error(`conditional_branch: unknown operator '${operator}'`);
  }
}
