"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import { STEP_LABELS } from "@/lib/stepTemplates";
import type { EdgeBranchKey, StepRunStatus, StepType } from "@/lib/types";

import { NODE_HEIGHT, NODE_WIDTH, outputPorts } from "./geometry";
import type { CanvasNode } from "./useGraphEditor";

/**
 * One step, as a node on the canvas.
 *
 * The output ports ARE the branching UI: a conditional_branch renders two,
 * labelled `true` and `false`, and which port a connection is dragged from is
 * what sets that connection's branch. Every other type renders one.
 */

/** A colour per step type, so the graph is readable before any label is. */
const ACCENT: Record<StepType, string> = {
  llm_call: "#8b5cf6",
  http_request: "#0ea5e9",
  db_write: "#f59e0b",
  notify: "#ec4899",
  conditional_branch: "#14b8a6",
  approval_gate: "#eab308",
};

const GLYPH: Record<StepType, string> = {
  llm_call: "✳",
  http_request: "⇄",
  db_write: "▤",
  notify: "◈",
  conditional_branch: "⑂",
  approval_gate: "⏸",
};

/** Ring colour while a run is in flight, matching StatusPill's vocabulary. */
const STATUS_RING: Partial<Record<StepRunStatus, string>> = {
  running: "#3b82f6",
  awaiting_approval: "#f59e0b",
  succeeded: "#10b981",
  failed: "#ef4444",
  skipped: "#9ca3af",
};

export interface StepNodeProps {
  node: CanvasNode;
  selected: boolean;
  invalid: boolean;
  orphaned: boolean;
  status?: StepRunStatus;
  editable: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPortPointerDown: (branch: EdgeBranchKey, event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function StepNode({
  node,
  selected,
  invalid,
  orphaned,
  status,
  editable,
  onPointerDown,
  onPortPointerDown,
}: StepNodeProps) {
  const accent = ACCENT[node.type];
  const ring = invalid ? "#ef4444" : status ? STATUS_RING[status] : undefined;
  const ports = outputPorts(node.type);

  return (
    <div
      data-node={node.slug}
      onPointerDown={onPointerDown}
      style={{
        left: node.x,
        top: node.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        borderColor: ring ?? (selected ? accent : undefined),
        boxShadow: selected ? `0 0 0 2px ${accent}55` : undefined,
      }}
      className={`absolute select-none rounded-lg border bg-[var(--surface)] ${
        ring || selected ? "" : "border-[var(--border)]"
      } ${editable ? "cursor-grab active:cursor-grabbing" : "cursor-default"} ${
        orphaned ? "opacity-70" : ""
      }`}
    >
      {/* Accent rail — the type is legible at any zoom, before the text is. */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-lg"
        style={{ background: accent }}
      />

      <div className="flex h-full flex-col justify-center gap-0.5 px-3 pl-4">
        <div className="flex items-center gap-1.5">
          <span aria-hidden style={{ color: accent }} className="text-sm leading-none">
            {GLYPH[node.type]}
          </span>
          <span className="truncate text-sm font-medium">{node.name}</span>
        </div>
        <span className="truncate text-xs text-[var(--muted)]">{STEP_LABELS[node.type]}</span>
        {status ? (
          <span className="truncate text-[10px] uppercase tracking-wide" style={{ color: ring }}>
            {status === "awaiting_approval" ? "awaiting approval" : status}
          </span>
        ) : null}
      </div>

      {/* Input port. Sized generously — it is a drop target for a dragged
          connection, and a fiddly one makes the whole canvas feel broken. */}
      <div
        data-port-input={node.slug}
        title="Input"
        className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--border)] bg-[var(--background)]"
      />

      {ports.map((branch, index) => {
        const offset = (NODE_HEIGHT / (ports.length + 1)) * (index + 1);
        return (
          <div key={branch || "out"} className="absolute -right-2" style={{ top: offset - 8 }}>
            <div
              onPointerDown={editable ? (event) => onPortPointerDown(branch, event) : undefined}
              data-port-output={node.slug}
              title={branch ? `Output when ${branch}` : "Output"}
              style={{ borderColor: accent }}
              className={`h-4 w-4 rounded-full border-2 bg-[var(--background)] ${
                editable ? "cursor-crosshair hover:scale-125" : ""
              } transition-transform`}
            />
            {branch ? (
              <span
                className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-[10px] font-medium"
                style={{ color: accent }}
              >
                {branch}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
