/**
 * The workflow graph, as pure functions.
 *
 * This module deliberately does NOT import "server-only", unlike the rest of
 * lib/engine. Two callers need it and one of them is a test:
 *
 *   * app/api/actions/saveWorkflow/route.ts assigns each step's `position` from
 *     topologicalOrder(), so what the database stores is already a valid
 *     execution order.
 *   * lib/engine/executor.ts re-derives that same order at run time rather than
 *     trusting the column, because `owner` and `editor` can write
 *     workflow_steps and workflow_step_edges directly and a hand-written
 *     back-edge would otherwise skip the tail of a run in silence.
 *
 * Both running the identical sort is the point: an ordering the writer and the
 * reader disagree about is the kind of bug that only shows up in production.
 */

/**
 * A connection between two steps of the same workflow.
 *
 * `branch_key` is '' for an ordinary connection, or 'true'/'false' for one
 * leaving a conditional_branch's matching output. The conditional label lives
 * on the EDGE, not on the destination step: that is what lets one graph hold
 * two independent conditionals, which the old single `context.branch` flag
 * could not express.
 */
export interface GraphEdge {
  from_slug: string;
  to_slug: string;
  branch_key: "" | "true" | "false";
}

export type BranchValue = "true" | "false" | null;

/** Longest slug we will generate or accept. Matches the CHECK in the schema. */
export const MAX_SLUG_LENGTH = 64;

/**
 * Slugs must start with a letter.
 *
 * That is not cosmetic. RunContext.steps is keyed by slug AND by position, so
 * that configs written against the old list model ({{steps.0.output.text}})
 * keep resolving. A step named "2" would slugify to "2" and land on top of
 * position key 2. Requiring a leading letter makes the two key spaces disjoint.
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;

export const isValidSlug = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);

/** Derives a valid slug from a human name. Always returns something valid. */
export function slugify(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const prefixed = /^[a-z]/.test(base) ? base : base ? `step-${base}` : "";
  const candidate = prefixed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  return candidate || fallback;
}

/**
 * Makes `desired` unique against everything in `taken`, by appending -2, -3, …
 * The caller owns `taken`; this adds the result to it.
 */
export function uniqueSlug(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) {
    taken.add(desired);
    return desired;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${desired.slice(0, MAX_SLUG_LENGTH - tail.length)}${tail}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export class GraphCycleError extends Error {
  /** The steps that could never be reached — i.e. the ones in or after the loop. */
  readonly slugs: string[];

  constructor(slugs: string[]) {
    super(`The workflow has a loop: ${slugs.join(", ")}`);
    this.name = "GraphCycleError";
    this.slugs = slugs;
  }
}

/**
 * Kahn's algorithm, made deterministic: when several nodes are ready at once,
 * the one earliest in `nodes` wins. Callers pass `nodes` in the order they want
 * as the tiebreak — the author's layout in saveWorkflow, `position` in the
 * executor — so the same graph always produces the same run order.
 *
 * Throws GraphCycleError rather than returning a partial order, because a
 * partial order is exactly the silent-wrong-answer case: the steps left out
 * would be reported as skipped instead of as a broken workflow.
 */
export function topologicalOrder<T extends { slug: string }>(
  nodes: T[],
  edges: GraphEdge[],
): T[] {
  const rank = new Map<string, number>();
  nodes.forEach((node, index) => rank.set(node.slug, index));

  const indegree = new Map<string, number>(nodes.map((node) => [node.slug, 0]));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.slug, []]));

  for (const edge of edges) {
    // An edge naming a step that is not in `nodes` cannot constrain the order.
    // saveWorkflow rejects those outright; the executor tolerates them so a
    // half-applied save cannot wedge a run.
    if (!indegree.has(edge.from_slug) || !indegree.has(edge.to_slug)) continue;
    indegree.set(edge.to_slug, (indegree.get(edge.to_slug) ?? 0) + 1);
    outgoing.get(edge.from_slug)?.push(edge.to_slug);
  }

  const ready = nodes.filter((node) => indegree.get(node.slug) === 0).map((node) => node.slug);
  const bySlug = new Map(nodes.map((node) => [node.slug, node]));
  const ordered: T[] = [];

  while (ready.length) {
    // Smallest rank first. `ready` stays short in practice, so a scan beats the
    // dependency a real priority queue would cost.
    let pick = 0;
    for (let index = 1; index < ready.length; index += 1) {
      if ((rank.get(ready[index]) ?? 0) < (rank.get(ready[pick]) ?? 0)) pick = index;
    }
    const slug = ready.splice(pick, 1)[0];

    const node = bySlug.get(slug);
    if (node) ordered.push(node);

    for (const next of outgoing.get(slug) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (ordered.length !== nodes.length) {
    const stuck = nodes.filter((node) => (indegree.get(node.slug) ?? 0) > 0).map((n) => n.slug);
    throw new GraphCycleError(stuck);
  }

  return ordered;
}

/** Groups edges by their destination, which is what reachability is asked about. */
export function indexIncoming(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to_slug);
    if (list) list.push(edge);
    else incoming.set(edge.to_slug, [edge]);
  }
  return incoming;
}

/**
 * Decides whether a step runs, given what has already run.
 *
 * This is an OR-join: ONE active incoming connection is enough. An AND-join
 * would deadlock the ordinary diamond — a conditional whose two arms both feed
 * a later step — because by construction only one arm ever runs.
 *
 * A step with no incoming connections is a root and always runs. That is what
 * makes an empty edge list behave exactly like the old linear model, so a
 * caller that knows nothing about the graph still gets sensible execution.
 */
export function isReached(
  incoming: readonly GraphEdge[],
  succeeded: ReadonlySet<string>,
  branchOf: ReadonlyMap<string, BranchValue>,
): { reached: boolean; reason: string } {
  if (incoming.length === 0) return { reached: true, reason: "" };

  const active = incoming.some(
    (edge) =>
      succeeded.has(edge.from_slug) &&
      (edge.branch_key === "" || branchOf.get(edge.from_slug) === edge.branch_key),
  );
  if (active) return { reached: true, reason: "" };

  const described = incoming
    .map((edge) => (edge.branch_key ? `${edge.from_slug} (${edge.branch_key})` : edge.from_slug))
    .join(", ");
  return { reached: false, reason: `no active incoming connection from: ${described}` };
}
