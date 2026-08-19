import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GraphCycleError,
  type GraphEdge,
  indexIncoming,
  isReached,
  slugify,
  topologicalOrder,
  uniqueSlug,
} from "@/lib/engine/graph";

/**
 * The graph rules, tested away from the database.
 *
 * These decide which steps of a workflow run at all, so the cases below are the
 * ones the old linear model got wrong or could not express: two independent
 * conditionals, a diamond that rejoins, and a skip that has to propagate down
 * one arm without touching the other.
 */

const edge = (from: string, to: string, branch: GraphEdge["branch_key"] = ""): GraphEdge => ({
  from_slug: from,
  to_slug: to,
  branch_key: branch,
});

const node = (slug: string) => ({ slug });

test("slugify produces a valid slug, and always starts with a letter", () => {
  assert.equal(slugify("Classify the request", "step-1"), "classify-the-request");
  assert.equal(slugify("  Is it URGENT?  ", "step-1"), "is-it-urgent");
  // A leading digit would collide with RunContext.steps' position keys.
  assert.equal(slugify("2nd attempt", "step-1"), "step-2nd-attempt");
  assert.equal(slugify("...", "step-4"), "step-4");
});

test("uniqueSlug suffixes collisions rather than merging two steps", () => {
  const taken = new Set<string>();
  assert.equal(uniqueSlug("check", taken), "check");
  assert.equal(uniqueSlug("check", taken), "check-2");
  assert.equal(uniqueSlug("check", taken), "check-3");
});

test("topologicalOrder puts every step after its predecessors", () => {
  // Submitted deliberately out of order: the graph, not the array, decides.
  const nodes = [node("notify"), node("classify"), node("check")];
  const edges = [edge("classify", "check"), edge("check", "notify")];

  assert.deepEqual(
    topologicalOrder(nodes, edges).map((entry) => entry.slug),
    ["classify", "check", "notify"],
  );
});

test("independent steps keep the order they were submitted in", () => {
  // With no edges at all every node is a root, so the result is the input —
  // which is what makes an edgeless save behave exactly like the old list.
  const nodes = [node("a"), node("b"), node("c")];
  assert.deepEqual(
    topologicalOrder(nodes, []).map((entry) => entry.slug),
    ["a", "b", "c"],
  );
});

test("a diamond keeps both arms before the step they rejoin at", () => {
  const nodes = [node("gate"), node("urgent"), node("check"), node("routine")];
  const edges = [
    edge("check", "urgent", "true"),
    edge("check", "routine", "false"),
    edge("urgent", "gate"),
    edge("routine", "gate"),
  ];

  const order = topologicalOrder(nodes, edges).map((entry) => entry.slug);
  assert.equal(order[0], "check");
  assert.equal(order.at(-1), "gate");
  assert.ok(order.indexOf("urgent") < order.indexOf("gate"));
  assert.ok(order.indexOf("routine") < order.indexOf("gate"));
});

test("a cycle is refused, and names the steps caught in it", () => {
  assert.throws(
    () => topologicalOrder([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]),
    (error: unknown) => {
      assert.ok(error instanceof GraphCycleError);
      assert.deepEqual(error.slugs.sort(), ["a", "b"]);
      return true;
    },
  );

  assert.throws(
    () =>
      topologicalOrder(
        [node("a"), node("b"), node("c")],
        [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      ),
    GraphCycleError,
  );
});

test("an edge naming an unknown step cannot constrain the order", () => {
  // saveWorkflow rejects these; the executor tolerates them so a partially
  // applied save cannot wedge a run that is already in flight.
  const order = topologicalOrder([node("a"), node("b")], [edge("ghost", "b"), edge("a", "b")]);
  assert.deepEqual(
    order.map((entry) => entry.slug),
    ["a", "b"],
  );
});

test("a step with no incoming connection is a root and runs", () => {
  const incoming = indexIncoming([]);
  assert.equal(isReached(incoming.get("classify") ?? [], new Set(), new Map()).reached, true);
});

test("a labelled connection is active only on the matching side", () => {
  const edges = [edge("check", "urgent", "true"), edge("check", "routine", "false")];
  const incoming = indexIncoming(edges);
  const succeeded = new Set(["check"]);
  const branchOf = new Map([["check", "true" as const]]);

  assert.equal(isReached(incoming.get("urgent") ?? [], succeeded, branchOf).reached, true);

  const routine = isReached(incoming.get("routine") ?? [], succeeded, branchOf);
  assert.equal(routine.reached, false);
  assert.match(routine.reason, /check \(false\)/);
});

test("a rejoining step is reached from whichever arm actually ran", () => {
  const incoming = indexIncoming([edge("urgent", "gate"), edge("routine", "gate")]);

  // Only the urgent arm ran; an AND-join would deadlock here.
  const succeeded = new Set(["urgent"]);
  assert.equal(isReached(incoming.get("gate") ?? [], succeeded, new Map()).reached, true);
});

test("a skip propagates: an unreached step never becomes a source", () => {
  const incoming = indexIncoming([edge("check", "routine", "false"), edge("routine", "log")]);
  const succeeded = new Set(["check"]);
  const branchOf = new Map([["check", "true" as const]]);

  // routine is skipped, so it is not in `succeeded`, so log is unreachable too.
  assert.equal(isReached(incoming.get("routine") ?? [], succeeded, branchOf).reached, false);
  assert.equal(isReached(incoming.get("log") ?? [], succeeded, branchOf).reached, false);
});

test("two independent conditionals do not interfere", () => {
  // The single global `context.branch` flag could not do this: the second
  // conditional used to overwrite the first, so `first-yes` would be judged
  // against the wrong answer.
  const incoming = indexIncoming([
    edge("check-one", "first-yes", "true"),
    edge("check-two", "second-yes", "true"),
  ]);
  const succeeded = new Set(["check-one", "check-two"]);
  const branchOf = new Map([
    ["check-one", "true" as const],
    ["check-two", "false" as const],
  ]);

  assert.equal(isReached(incoming.get("first-yes") ?? [], succeeded, branchOf).reached, true);
  assert.equal(isReached(incoming.get("second-yes") ?? [], succeeded, branchOf).reached, false);
});
