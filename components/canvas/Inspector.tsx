"use client";

import { useMemo } from "react";

import { Button, Empty, Field, inputClass } from "@/components/ui";
import { isValidSlug } from "@/lib/engine/graph";
import { OWNER_ONLY_STEP_TYPES, STEP_HINTS, STEP_LABELS, defaultStepConfig } from "@/lib/stepTemplates";
import { STEP_TYPES, type StepType } from "@/lib/types";

import type { CanvasNode } from "./useGraphEditor";

/**
 * The selected node's settings.
 *
 * These are the same fields the old list rows carried — name, type, and the raw
 * JSON config — moved off the canvas so a node stays small enough to read the
 * graph through. What is NOT here is the old "Runs on branch" select: branching
 * is expressed by which output port a connection leaves from, so the field has
 * no equivalent.
 */

export interface InspectorProps {
  node: CanvasNode | null;
  canEdit: boolean;
  isOwner: boolean;
  /** Slugs already in use, so a rename can be refused before it breaks the graph. */
  takenSlugs: string[];
  /**
   * How many steps are selected. `node` is null both when nothing is selected
   * and when several are, and those two need different panels.
   */
  selectedCount: number;
  onChange: (patch: Partial<Omit<CanvasNode, "slug">>) => void;
  onRenameSlug: (next: string) => void;
  onDelete: () => void;
  onDeleteSelection: () => void;
  onDuplicate: () => void;
}

export function Inspector({
  node,
  canEdit,
  isOwner,
  takenSlugs,
  selectedCount,
  onChange,
  onRenameSlug,
  onDelete,
  onDeleteSelection,
  onDuplicate,
}: InspectorProps) {
  const configError = useMemo(() => {
    if (!node) return null;
    try {
      JSON.parse(node.configJson || "{}");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid JSON";
    }
  }, [node]);

  const slugError = useMemo(() => {
    if (!node) return null;
    if (!isValidSlug(node.slug)) {
      return "Start with a letter; lowercase letters, digits, - and _ only.";
    }
    if (takenSlugs.filter((slug) => slug === node.slug).length > 1) return "Already used.";
    return null;
  }, [node, takenSlugs]);

  if (!node && selectedCount > 1) {
    // Several steps: nothing here can edit a name or a config, so the panel
    // offers only what makes sense on a set.
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <p className="text-sm font-medium">{selectedCount} steps selected</p>
        <p className="text-xs text-[var(--muted)]">
          Drag any one of them to move the whole set. Duplicating keeps the connections that run
          between them.
        </p>
        {canEdit ? (
          <div className="mt-auto space-y-2 pt-2">
            <Button onClick={onDuplicate} className="w-full">
              Duplicate {selectedCount} steps
            </Button>
            <Button variant="danger" onClick={onDeleteSelection} className="w-full">
              Delete {selectedCount} steps
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (!node) {
    return (
      <div className="p-4">
        <Empty>
          Select a step to edit it, or drag from a step&rsquo;s right-hand dot to connect it to
          another. Drag across the background to select several.
        </Empty>
      </div>
    );
  }

  const disabled = !canEdit;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <Field label="Name">
        <input
          value={node.name}
          onChange={(event) => onChange({ name: event.target.value })}
          disabled={disabled}
          className={inputClass}
        />
      </Field>

      <Field
        label="Reference id"
        hint="How other steps read this one's output: {{steps.SLUG.output}}"
      >
        <input
          value={node.slug}
          onChange={(event) => onRenameSlug(event.target.value)}
          disabled={disabled}
          spellCheck={false}
          className={`${inputClass} font-mono text-xs ${slugError ? "border-red-500" : ""}`}
        />
      </Field>
      {slugError ? <p className="-mt-2 text-xs text-red-600">{slugError}</p> : null}

      <Field label="Type">
        <select
          value={node.type}
          onChange={(event) =>
            onChange({
              type: event.target.value as StepType,
              // Changing the type replaces the config with that type's template:
              // the old keys would mean nothing to the new executor.
              configJson: defaultStepConfig(event.target.value as StepType),
            })
          }
          disabled={disabled}
          className={inputClass}
        >
          {STEP_TYPES.map((type) => (
            <option key={type} value={type} disabled={!isOwner && OWNER_ONLY_STEP_TYPES.includes(type)}>
              {STEP_LABELS[type]}
              {!isOwner && OWNER_ONLY_STEP_TYPES.includes(type) ? " (owner only)" : ""}
            </option>
          ))}
        </select>
      </Field>

      <p className="text-xs text-[var(--muted)]">{STEP_HINTS[node.type]}</p>

      <Field label="Config">
        <textarea
          value={node.configJson}
          onChange={(event) => onChange({ configJson: event.target.value })}
          disabled={disabled}
          rows={Math.min(20, node.configJson.split("\n").length + 1)}
          spellCheck={false}
          className={`${inputClass} font-mono text-xs ${configError ? "border-red-500" : ""}`}
        />
      </Field>
      {configError ? <p className="-mt-2 text-xs text-red-600">{configError}</p> : null}

      {node.type === "conditional_branch" ? (
        <p className="rounded-md border border-[var(--border)] p-2 text-xs text-[var(--muted)]">
          This step has two outputs. Drag from the <strong>true</strong> or{" "}
          <strong>false</strong> dot to choose which steps run on each side.
        </p>
      ) : null}

      {canEdit ? (
        <div className="mt-auto pt-2">
          <Button variant="danger" onClick={onDelete} className="w-full">
            Delete step
          </Button>
        </div>
      ) : null}
    </div>
  );
}
