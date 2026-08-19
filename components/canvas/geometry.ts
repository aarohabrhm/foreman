import type { StepType } from "@/lib/types";

/**
 * Canvas geometry, in one place.
 *
 * Everything here works in WORLD coordinates — the coordinate space the node
 * positions are stored in. The viewport transform is applied once, by a CSS
 * transform on the layer that holds the nodes and the edge SVG, so nothing else
 * has to know about panning or zoom. The only place the two spaces meet is
 * toWorld(), which turns a pointer event back into world coordinates.
 */

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 78;

/** Nodes land on this grid, so a hand-dragged graph still lines up. */
export const GRID = 20;

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export const snap = (value: number): number => Math.round(value / GRID) * GRID;

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Screen coordinates (relative to the canvas element) -> world coordinates. */
export function toWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

/**
 * A conditional_branch has two outputs, stacked; everything else has one,
 * centred. The output ports ARE the branch labels — dragging from the lower
 * port is what produces a connection with branch_key 'false'.
 */
export const outputPorts = (type: StepType): ("" | "true" | "false")[] =>
  type === "conditional_branch" ? ["true", "false"] : [""];

export function inputPort(node: Point): Point {
  return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
}

export function outputPort(node: Point, type: StepType, branch: string): Point {
  const ports = outputPorts(type);
  const index = Math.max(0, ports.indexOf(branch as "" | "true" | "false"));
  // Evenly spaced down the right edge: one port sits at the middle, two at a
  // third and two thirds.
  const step = NODE_HEIGHT / (ports.length + 1);
  return { x: node.x + NODE_WIDTH, y: node.y + step * (index + 1) };
}

/**
 * A horizontal cubic bezier. The control-point offset grows with the gap so
 * short hops stay tight, but is clamped so a long connection does not swing out
 * into a balloon.
 */
export function edgePath(from: Point, to: Point): string {
  const distance = Math.abs(to.x - from.x);
  const curve = Math.min(160, Math.max(40, distance / 2));
  return `M ${from.x} ${from.y} C ${from.x + curve} ${from.y}, ${to.x - curve} ${to.y}, ${to.x} ${to.y}`;
}

/** Where the +/× controls on a connection sit — the curve's visual middle. */
export function edgeMidpoint(from: Point, to: Point): Point {
  // t = 0.5 on the cubic above, which is not the same as the straight-line
  // midpoint once the control points pull the curve sideways.
  const curve = Math.min(160, Math.max(40, Math.abs(to.x - from.x) / 2));
  return {
    x: (from.x + 3 * (from.x + curve) + 3 * (to.x - curve) + to.x) / 8,
    y: (from.y + 3 * from.y + 3 * to.y + to.y) / 8,
  };
}

/**
 * Left-to-right layered layout, used for a workflow that has never been opened
 * on the canvas (every coordinate still 0) and by the "Tidy up" button.
 *
 * Each node is placed one column right of its deepest predecessor, then rows
 * are spread within the column. Nodes arrive already topologically ordered, so
 * one forward pass is enough.
 */
export function autoLayout(
  nodes: { slug: string }[],
  edges: { from_slug: string; to_slug: string }[],
): Map<string, Point> {
  const column = new Map<string, number>();
  for (const node of nodes) column.set(node.slug, 0);

  for (const node of nodes) {
    for (const edge of edges) {
      if (edge.from_slug !== node.slug) continue;
      const next = (column.get(node.slug) ?? 0) + 1;
      if (next > (column.get(edge.to_slug) ?? 0)) column.set(edge.to_slug, next);
    }
  }

  const rows = new Map<number, number>();
  const placed = new Map<string, Point>();
  for (const node of nodes) {
    const col = column.get(node.slug) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    placed.set(node.slug, { x: col * 260, y: row * 130 });
  }

  // Centre each column vertically against the tallest one, so a branch reads as
  // splitting away from the trunk rather than hanging below it.
  const tallest = Math.max(1, ...rows.values());
  for (const node of nodes) {
    const point = placed.get(node.slug);
    const col = column.get(node.slug) ?? 0;
    const height = rows.get(col) ?? 1;
    if (point) point.y += ((tallest - height) * 130) / 2;
  }

  return placed;
}
