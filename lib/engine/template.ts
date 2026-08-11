/**
 * `{{path}}` substitution for step configs.
 *
 * Steps need to consume earlier output — an http_request whose body includes the
 * LLM's answer, a conditional_branch reading it, and so on. This resolves dotted
 * paths against the run context; it never evaluates code.
 *
 *   "{{last.text}}"                    -> the value at that path, type preserved
 *   "Summary: {{steps.0.output.text}}" -> interpolated into the string
 */

const TEMPLATE_PATTERN = /\{\{\s*([\w.[\]-]+)\s*\}\}/g;

export function resolvePath(context: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current: unknown = context;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Recursively renders every string in a config value against the context. */
export function renderTemplate<T>(value: T, context: unknown): T {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([\w.[\]-]+)\s*\}\}$/);
    if (exact) {
      // A config that is nothing but a reference keeps the referenced type,
      // so `{"body": "{{last.output}}"}` sends an object, not "[object Object]".
      return resolvePath(context, exact[1]) as T;
    }
    return value.replace(TEMPLATE_PATTERN, (_match, path: string) =>
      stringify(resolvePath(context, path)),
    ) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplate(item, context)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderTemplate(item, context),
      ]),
    ) as T;
  }

  return value;
}
