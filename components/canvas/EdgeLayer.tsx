"use client";

import { Fragment } from "react";

import type { StepType } from "@/lib/types";

import { edgeMidpoint, edgePath, inputPort, outputPort, type Point } from "./geometry";
import type { CanvasEdge, CanvasNode } from "./useGraphEditor";

/**
 * The connections, drawn as one SVG under the nodes.
 *
 * `overflow: visible` and a zero-sized viewBox let the paths be drawn straight
 * in world coordinates — the same space the node positions live in — so the
 * viewport transform on the parent moves nodes and edges together and nothing
 * here has to know about panning or zoom.
 */

const BRANCH_COLOUR: Record<string, string> = {
  true: "#10b981",
  false: "#f43f5e",
  "": "var(--muted)",
};

export interface EdgeLayerProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** The connection currently being dragged out of a port, if any. */
  pending: { from: Point; to: Point } | null;
  editable: boolean;
  onDeleteEdge: (id: string) => void;
  onInsertOnEdge: (id: string, at: Point) => void;
}

export function EdgeLayer({
  nodes,
  edges,
  pending,
  editable,
  onDeleteEdge,
  onInsertOnEdge,
}: EdgeLayerProps) {
  const bySlug = new Map(nodes.map((node) => [node.slug, node]));

  return (
    <svg
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={1}
      height={1}
      aria-hidden
    >
      <defs>
        {Object.entries(BRANCH_COLOUR).map(([branch, colour]) => (
          <marker
            key={branch || "plain"}
            id={`arrow-${branch || "plain"}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colour} />
          </marker>
        ))}
      </defs>

      {edges.map((edge) => {
        const source = bySlug.get(edge.from);
        const destination = bySlug.get(edge.to);
        if (!source || !destination) return null;

        const from = outputPort(source, source.type as StepType, edge.branch);
        const to = inputPort(destination);
        const middle = edgeMidpoint(from, to);
        const colour = BRANCH_COLOUR[edge.branch] ?? BRANCH_COLOUR[""];

        return (
          <Fragment key={edge.id}>
            <path
              d={edgePath(from, to)}
              fill="none"
              stroke={colour}
              strokeWidth={2}
              markerEnd={`url(#arrow-${edge.branch || "plain"})`}
            />

            {editable ? (
              // Two controls per connection, revealed on hover: × removes it,
              // + splices a new step into it. The wide transparent path is the
              // hover target — a 2px line is far too thin to aim at.
              <g className="pointer-events-auto opacity-0 transition-opacity hover:opacity-100">
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={18}
                  style={{ cursor: "pointer" }}
                />
                <g transform={`translate(${middle.x - 20} ${middle.y})`}>
                  <circle
                    r={9}
                    fill="var(--surface)"
                    stroke={colour}
                    style={{ cursor: "pointer" }}
                    onClick={() => onInsertOnEdge(edge.id, middle)}
                  />
                  <text
                    y={4}
                    textAnchor="middle"
                    fontSize={13}
                    fill={colour}
                    style={{ cursor: "pointer", userSelect: "none" }}
                    onClick={() => onInsertOnEdge(edge.id, middle)}
                  >
                    +
                  </text>
                </g>
                <g transform={`translate(${middle.x + 20} ${middle.y})`}>
                  <circle
                    r={9}
                    fill="var(--surface)"
                    stroke="#ef4444"
                    style={{ cursor: "pointer" }}
                    onClick={() => onDeleteEdge(edge.id)}
                  />
                  <text
                    y={4}
                    textAnchor="middle"
                    fontSize={12}
                    fill="#ef4444"
                    style={{ cursor: "pointer", userSelect: "none" }}
                    onClick={() => onDeleteEdge(edge.id)}
                  >
                    ×
                  </text>
                </g>
              </g>
            ) : null}
          </Fragment>
        );
      })}

      {pending ? (
        <path
          d={edgePath(pending.from, pending.to)}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={2}
          strokeDasharray="5 4"
        />
      ) : null}
    </svg>
  );
}
