import assert from "node:assert/strict";
import { test } from "node:test";

import { executeConditionalBranch } from "@/lib/engine/steps/conditionalBranch";
import { StepExecutionError, withRetry } from "@/lib/engine/retry";
import { renderTemplate, resolvePath } from "@/lib/engine/template";
import type { RunContext, StepExecutionContext } from "@/lib/engine/types";

/**
 * Offline tests for the pure parts of the engine — the pieces that decide what
 * the acceptance scenario actually does (which branch is taken, what an
 * http_request sends, whether a flaky call is retried). Anything that talks to
 * Hasura or Groq is covered end-to-end instead, by running a real workflow.
 */

const context = (runContext: Partial<RunContext>): StepExecutionContext => ({
  runId: "run-1",
  orgId: "org-1",
  stepRunId: "step-run-1",
  stepName: "test step",
  runContext: { steps: {}, branch: null, ...runContext },
});

test("resolvePath walks dotted and indexed paths", () => {
  const data = { steps: { "0": { output: { choices: [{ text: "hello" }] } } } };
  assert.equal(resolvePath(data, "steps.0.output.choices[0].text"), "hello");
  assert.equal(resolvePath(data, "steps.9.output"), undefined);
  assert.equal(resolvePath(data, "nothing.here.at.all"), undefined);
});

test("a config that is only a reference keeps the referenced type", () => {
  const runContext = { last: { text: "URGENT", usage: { total_tokens: 12 } } };
  const rendered = renderTemplate({ body: "{{last}}", note: "re: {{last.text}}" }, runContext);

  assert.deepEqual(rendered.body, runContext.last, "an exact reference must not stringify");
  assert.equal(rendered.note, "re: URGENT", "an embedded reference interpolates");
});

test("templates render inside nested objects and arrays", () => {
  const rendered = renderTemplate(
    { headers: { "x-summary": "{{last.text}}" }, tags: ["a", "{{last.text}}"] },
    { last: { text: "ROUTINE" } },
  );
  assert.equal(rendered.headers["x-summary"], "ROUTINE");
  assert.deepEqual(rendered.tags, ["a", "ROUTINE"]);
});

test("missing template values render as empty rather than 'undefined'", () => {
  assert.equal(renderTemplate("value: {{last.missing}}", { last: {} }), "value: ");
});

test("conditional_branch reads the previous step's output and sets the branch", async () => {
  const config = { left: "{{last.text}}", operator: "contains", right: "urgent" };

  const urgent = await executeConditionalBranch(
    config,
    context({ last: { text: "URGENT — the service is down" } }),
  );
  assert.equal(urgent.kind, "value");
  assert.equal(urgent.kind === "value" && urgent.branch, "true");

  const routine = await executeConditionalBranch(
    config,
    context({ last: { text: "ROUTINE — informational" } }),
  );
  assert.equal(routine.kind === "value" && routine.branch, "false");
});

test("conditional_branch supports numeric and regex comparisons", async () => {
  const gt = await executeConditionalBranch(
    { left: "{{last.score}}", operator: "gt", right: 0.5 },
    context({ last: { score: 0.9 } }),
  );
  assert.equal(gt.kind === "value" && gt.branch, "true");

  const matches = await executeConditionalBranch(
    { left: "{{last.text}}", operator: "matches", right: "^URGENT" },
    context({ last: { text: "URGENT: outage" } }),
  );
  assert.equal(matches.kind === "value" && matches.branch, "true");
});

test("conditional_branch rejects an unknown operator instead of guessing", async () => {
  await assert.rejects(
    () => executeConditionalBranch({ operator: "sort-of-equals" }, context({})),
    /unknown operator/i,
  );
});

test("withRetry retries once and reports the attempt count", async () => {
  let calls = 0;
  const { value, attempts } = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient upstream failure");
      return "second time lucky";
    },
    { delayMs: 1 },
  );

  assert.equal(value, "second time lucky");
  assert.equal(attempts, 2);
  assert.equal(calls, 2);
});

test("withRetry gives up after the configured attempts and preserves the message", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error("upstream is down");
        },
        { attempts: 2, delayMs: 1 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof StepExecutionError);
      assert.equal(error.attempts, 2);
      assert.match(error.message, /upstream is down/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("withRetry does not retry a call that succeeds first time", async () => {
  let calls = 0;
  const { attempts } = await withRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
});
