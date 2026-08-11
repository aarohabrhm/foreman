import "server-only";

import { withRetry } from "@/lib/engine/retry";
import { renderTemplate } from "@/lib/engine/template";
import type { StepExecutionContext, StepOutcome } from "@/lib/engine/types";

export interface HttpRequestConfig {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
  /** Treat non-2xx as success instead of retrying. */
  allow_error_status?: boolean;
}

const MAX_CAPTURED_BODY = 20_000;

/** Generic call to any external API, retried once on failure. */
export async function executeHttpRequest(
  config: HttpRequestConfig,
  context: StepExecutionContext,
): Promise<StepOutcome> {
  const rendered = renderTemplate(config, context.runContext);
  const url = (rendered.url ?? "").trim();
  if (!url) throw new Error("http_request step has no url");

  const method = (rendered.method ?? "GET").toUpperCase();
  const timeoutMs = rendered.timeout_ms ?? 15_000;

  const { value, attempts } = await withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const hasBody = method !== "GET" && method !== "HEAD" && rendered.body !== undefined;
        const response = await fetch(url, {
          method,
          headers: {
            ...(hasBody ? { "content-type": "application/json" } : {}),
            ...(rendered.headers ?? {}),
          },
          body: hasBody
            ? typeof rendered.body === "string"
              ? rendered.body
              : JSON.stringify(rendered.body)
            : undefined,
          signal: controller.signal,
        });

        const text = (await response.text()).slice(0, MAX_CAPTURED_BODY);
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON — keep the raw text */
        }

        if (!response.ok && !rendered.allow_error_status) {
          throw new Error(`${method} ${url} responded ${response.status}`);
        }

        return { url, method, status: response.status, ok: response.ok, body };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      onRetry: (error, attempt) =>
        console.warn(
          `[foreman] http_request "${context.stepName}" attempt ${attempt} failed, retrying:`,
          error instanceof Error ? error.message : error,
        ),
    },
  );

  return { kind: "value", attempts, output: value };
}
