import "server-only";

import Groq from "groq-sdk";

import { serverEnv } from "@/lib/env";
import { withRetry } from "@/lib/engine/retry";
import { renderTemplate } from "@/lib/engine/template";
import type { StepExecutionContext, StepOutcome } from "@/lib/engine/types";

export interface LlmCallConfig {
  prompt?: string;
  system?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

let client: Groq | null = null;

function groq(apiKey: string): Groq {
  if (!client) client = new Groq({ apiKey });
  return client;
}

/**
 * Real Groq chat completion, retried once on failure.
 *
 * When GROQ_API_KEY is absent the call is stubbed: the output is clearly marked
 * `stubbed: true`, a line is logged, and an artificial delay stands in for the
 * network round trip. Nothing else about the run changes, so the acceptance
 * scenario (including the conditional_branch that reads this output) behaves the
 * same either way.
 */
export async function executeLlmCall(
  config: LlmCallConfig,
  context: StepExecutionContext,
): Promise<StepOutcome> {
  const rendered = renderTemplate(config, context.runContext);
  const prompt = (rendered.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("llm_call step has no prompt");
  }

  const apiKey = serverEnv.groqApiKey();
  const model = rendered.model || serverEnv.groqModel();

  if (!apiKey) {
    console.warn(
      `[foreman] STUBBED llm_call "${context.stepName}" — GROQ_API_KEY is not set. ` +
        "Set it in .env.local for real completions.",
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    return {
      kind: "value",
      attempts: 1,
      output: {
        stubbed: true,
        model,
        prompt,
        text: stubbedCompletion(prompt),
      },
    };
  }

  const { value, attempts } = await withRetry(
    async () => {
      const completion = await groq(apiKey).chat.completions.create({
        model,
        temperature: rendered.temperature ?? 0.2,
        max_tokens: rendered.max_tokens ?? 512,
        messages: [
          ...(rendered.system ? [{ role: "system" as const, content: rendered.system }] : []),
          { role: "user" as const, content: prompt },
        ],
      });

      const text = completion.choices[0]?.message?.content ?? "";
      if (!text) throw new Error("Groq returned an empty completion");

      return {
        stubbed: false,
        model: completion.model,
        prompt,
        text,
        usage: completion.usage
          ? {
              prompt_tokens: completion.usage.prompt_tokens,
              completion_tokens: completion.usage.completion_tokens,
              total_tokens: completion.usage.total_tokens,
            }
          : null,
      };
    },
    {
      onRetry: (error, attempt) =>
        console.warn(
          `[foreman] llm_call "${context.stepName}" attempt ${attempt} failed, retrying:`,
          error instanceof Error ? error.message : error,
        ),
    },
  );

  return { kind: "value", attempts, output: value };
}

/**
 * Deterministic stand-in that still varies with the prompt, so a
 * conditional_branch reading it is exercised rather than short-circuited.
 */
function stubbedCompletion(prompt: string): string {
  const urgent = /\b(urgent|outage|down|critical|asap|breach|failure)\b/i.test(prompt);
  return urgent
    ? "URGENT — this request describes a service-impacting problem and needs immediate attention."
    : "ROUTINE — this request is informational and can be handled in the normal queue.";
}
