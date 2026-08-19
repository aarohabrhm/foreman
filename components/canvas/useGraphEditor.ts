"use client";

import { useMemo, useReducer } from "react";

import {
  GraphCycleError,
  type GraphEdge,
  slugify,
  topologicalOrder,
  uniqueSlug,
} from "@/lib/engine/graph";
import { defaultStepConfig } from "@/lib/stepTemplates";
import type { EdgeBranchKey, StepType } from "@/lib/types";

import { GRID, snap, type Point } from "./geometry";

/**
 * The graph the canvas edits, and its undo history.
 *
 * Nodes are keyed by `slug`, the same identity the database and the templates
 * use, so a node keeps its id across a save/reload and `{{steps.<slug>.output}}`
 * in someone's config does not quietly start pointing at a different step.
 * Connections carry a client-side `id` only so React and the delete affordance
 * have something stable to hold on to; the server does not store it.
 */

export interface CanvasNode {
  slug: string;
  name: string;
  type: StepType;
  configJson: string;
  x: number;
  y: number;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  branch: EdgeBranchKey;
}

/** A detached piece of graph: what the clipboard holds, and what duplicate copies. */
export interface GraphFragment {
  nodes: CanvasNode[];
  edges: { from: string; to: string; branch: EdgeBranchKey }[];
}

export interface GraphState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * Every selected slug. An array rather than a single slug because the canvas
   * supports marquee and shift-click selection, and a group drag has to move
   * all of them together.
   */
  selected: string[];
}

interface EditorState {
  present: GraphState;
  past: GraphState[];
  future: GraphState[];
}

const EMPTY: GraphState = { nodes: [], edges: [], selected: [] };

/** History is capped so a long editing session cannot grow without bound. */
const HISTORY_LIMIT = 100;

/** How far a pasted or duplicated copy lands from its original. */
export const CLONE_OFFSET = GRID * 2;

let edgeCounter = 0;
const newEdgeId = () => `e${(edgeCounter += 1)}`;

export type EditorAction =
  | { type: "hydrate"; nodes: CanvasNode[]; edges: CanvasEdge[] }
  /** Snapshots the current state so a following run of "skip" actions undoes as one. */
  | { type: "checkpoint" }
  /** Replaces the selection outright. */
  | { type: "select"; slugs: string[] }
  /** Adds or removes one node from the selection — shift-click. */
  | { type: "toggleSelect"; slug: string }
  | { type: "selectAll" }
  | {
      type: "addNode";
      stepType: StepType;
      x: number;
      y: number;
      connectFrom?: { slug: string; branch: EdgeBranchKey };
    }
  | { type: "updateNode"; slug: string; patch: Partial<Omit<CanvasNode, "slug">> }
  | { type: "renameSlug"; slug: string; next: string }
  | { type: "deleteNode"; slug: string }
  /** Removes every selected node, and any connection touching one. */
  | { type: "deleteSelection" }
  /**
   * Moves a whole set of nodes at once. The canvas computes the absolute
   * destinations from the positions it captured at pointer-down, so a group
   * drag cannot accumulate rounding drift across a stream of moves.
   */
  | { type: "moveNodes"; positions: Map<string, Point>; history?: boolean }
  | { type: "nudgeSelection"; dx: number; dy: number }
  | { type: "connect"; from: string; to: string; branch: EdgeBranchKey }
  | { type: "deleteEdge"; id: string }
  | { type: "insertOnEdge"; id: string; stepType: StepType }
  /**
   * Drops a detached fragment into the graph — what both paste and duplicate
   * are. Slugs are re-issued here rather than by the caller, because only the
   * reducer knows which ones are already taken.
   */
  | { type: "insertGraph"; fragment: GraphFragment; offset: Point }
  | { type: "tidy"; positions: Map<string, Point> }
  | { type: "undo" }
  | { type: "redo" };

/** Actions that do not open a new undo entry of their own. */
const NON_HISTORIC = new Set<EditorAction["type"]>([
  "hydrate",
  "select",
  "toggleSelect",
  "selectAll",
  "undo",
  "redo",
  "checkpoint",
]);

function reduceGraph(state: GraphState, action: EditorAction): GraphState {
  switch (action.type) {
    case "hydrate":
      return { nodes: action.nodes, edges: action.edges, selected: [] };

    case "select":
      return { ...state, selected: action.slugs };

    case "toggleSelect":
      return {
        ...state,
        selected: state.selected.includes(action.slug)
          ? state.selected.filter((slug) => slug !== action.slug)
          : [...state.selected, action.slug],
      };

    case "selectAll":
      return { ...state, selected: state.nodes.map((node) => node.slug) };

    case "addNode": {
      const taken = new Set(state.nodes.map((node) => node.slug));
      const label = defaultNodeName(action.stepType, state.nodes);
      const slug = uniqueSlug(slugify(label, `step-${state.nodes.length + 1}`), taken);
      const node: CanvasNode = {
        slug,
        name: label,
        type: action.stepType,
        configJson: defaultStepConfig(action.stepType),
        x: snap(action.x),
        y: snap(action.y),
      };

      const edges = action.connectFrom
        ? [
            ...state.edges,
            {
              id: newEdgeId(),
              from: action.connectFrom.slug,
              to: slug,
              branch: action.connectFrom.branch,
            },
          ]
        : state.edges;

      return { nodes: [...state.nodes, node], edges, selected: [slug] };
    }

    case "updateNode":
      return {
        ...state,
        nodes: state.nodes.map((node) =>
          node.slug === action.slug ? { ...node, ...action.patch } : node,
        ),
      };

    case "renameSlug": {
      // Connections reference slugs, so a rename has to carry them along or the
      // graph would silently come apart.
      const taken = new Set(state.nodes.map((node) => node.slug));
      taken.delete(action.slug);
      if (taken.has(action.next)) return state;

      return {
        nodes: state.nodes.map((node) =>
          node.slug === action.slug ? { ...node, slug: action.next } : node,
        ),
        edges: state.edges.map((edge) => ({
          ...edge,
          from: edge.from === action.slug ? action.next : edge.from,
          to: edge.to === action.slug ? action.next : edge.to,
        })),
        selected: state.selected.map((slug) => (slug === action.slug ? action.next : slug)),
      };
    }

    case "deleteNode":
      return removeNodes(state, new Set([action.slug]));

    case "deleteSelection":
      return state.selected.length ? removeNodes(state, new Set(state.selected)) : state;

    case "moveNodes": {
      if (!action.positions.size) return state;
      return {
        ...state,
        nodes: state.nodes.map((node) => {
          const point = action.positions.get(node.slug);
          return point ? { ...node, x: point.x, y: point.y } : node;
        }),
      };
    }

    case "nudgeSelection": {
      if (!state.selected.length) return state;
      const moving = new Set(state.selected);
      return {
        ...state,
        nodes: state.nodes.map((node) =>
          moving.has(node.slug) ? { ...node, x: node.x + action.dx, y: node.y + action.dy } : node,
        ),
      };
    }

    case "connect": {
      if (action.from === action.to) return state;
      const duplicate = state.edges.some(
        (edge) =>
          edge.from === action.from && edge.to === action.to && edge.branch === action.branch,
      );
      if (duplicate) return state;
      return {
        ...state,
        edges: [
          ...state.edges,
          { id: newEdgeId(), from: action.from, to: action.to, branch: action.branch },
        ],
      };
    }

    case "deleteEdge":
      return { ...state, edges: state.edges.filter((edge) => edge.id !== action.id) };

    case "insertOnEdge": {
      // Splices a new step into an existing connection: the original is
      // replaced by two, so the graph stays connected. The incoming half keeps
      // the original's branch label; the outgoing half is unconditional,
      // because the new step is not necessarily a conditional.
      const target = state.edges.find((edge) => edge.id === action.id);
      if (!target) return state;

      const source = state.nodes.find((node) => node.slug === target.from);
      const destination = state.nodes.find((node) => node.slug === target.to);
      if (!source || !destination) return state;

      const taken = new Set(state.nodes.map((node) => node.slug));
      const label = defaultNodeName(action.stepType, state.nodes);
      const slug = uniqueSlug(slugify(label, `step-${state.nodes.length + 1}`), taken);

      const node: CanvasNode = {
        slug,
        name: label,
        type: action.stepType,
        configJson: defaultStepConfig(action.stepType),
        x: snap((source.x + destination.x) / 2),
        y: snap((source.y + destination.y) / 2),
      };

      return {
        nodes: [...state.nodes, node],
        edges: [
          ...state.edges.filter((edge) => edge.id !== action.id),
          { id: newEdgeId(), from: target.from, to: slug, branch: target.branch },
          { id: newEdgeId(), from: slug, to: target.to, branch: "" as EdgeBranchKey },
        ],
        selected: [slug],
      };
    }

    case "insertGraph": {
      const { fragment, offset } = action;
      if (!fragment.nodes.length) return state;

      // Re-slug against what is actually taken, remembering the mapping so the
      // fragment's own connections can be rewritten to the new names. A copy of
      // "classify" therefore arrives as "classify-2" with its internal wiring
      // intact rather than pointing back at the original.
      const taken = new Set(state.nodes.map((node) => node.slug));
      const renamed = new Map<string, string>();
      const nodes = fragment.nodes.map((node) => {
        const slug = uniqueSlug(node.slug, taken);
        taken.add(slug);
        renamed.set(node.slug, slug);
        return { ...node, slug, x: snap(node.x + offset.x), y: snap(node.y + offset.y) };
      });

      // Only connections with BOTH ends in the fragment survive. A dangling end
      // would either re-parent the copy onto the original or point at nothing.
      const edges = fragment.edges.flatMap((edge) => {
        const from = renamed.get(edge.from);
        const to = renamed.get(edge.to);
        return from && to ? [{ id: newEdgeId(), from, to, branch: edge.branch }] : [];
      });

      return {
        nodes: [...state.nodes, ...nodes],
        edges: [...state.edges, ...edges],
        selected: nodes.map((node) => node.slug),
      };
    }

    case "tidy":
      return {
        ...state,
        nodes: state.nodes.map((node) => {
          const point = action.positions.get(node.slug);
          return point ? { ...node, x: point.x, y: point.y } : node;
        }),
      };

    default:
      return state;
  }
}

/** Drops a set of nodes, and every connection that touched one of them. */
function removeNodes(state: GraphState, going: Set<string>): GraphState {
  return {
    nodes: state.nodes.filter((node) => !going.has(node.slug)),
    edges: state.edges.filter((edge) => !going.has(edge.from) && !going.has(edge.to)),
    selected: state.selected.filter((slug) => !going.has(slug)),
  };
}

function reduce(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      present: previous,
      past: state.past.slice(0, -1),
      future: [state.present, ...state.future],
    };
  }

  if (action.type === "redo") {
    const next = state.future[0];
    if (!next) return state;
    return {
      present: next,
      past: [...state.past, state.present],
      future: state.future.slice(1),
    };
  }

  if (action.type === "checkpoint") {
    return {
      present: state.present,
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      future: [],
    };
  }

  const present = reduceGraph(state.present, action);
  if (present === state.present) return state;

  // A drag sends one checkpoint at pointer-down and then a stream of
  // history-less moves, so the whole gesture undoes in a single step.
  const historic =
    !NON_HISTORIC.has(action.type) &&
    !(action.type === "moveNodes" && action.history === false);

  return {
    present,
    past: historic ? [...state.past, state.present].slice(-HISTORY_LIMIT) : state.past,
    future: historic ? [] : state.future,
  };
}

function defaultNodeName(type: StepType, nodes: CanvasNode[]): string {
  const base = STEP_NAME[type];
  const used = new Set(nodes.map((node) => node.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

const STEP_NAME: Record<StepType, string> = {
  llm_call: "LLM call",
  http_request: "HTTP request",
  db_write: "Database write",
  notify: "Notify",
  conditional_branch: "Conditional branch",
  approval_gate: "Approval gate",
};

export interface GraphProblems {
  /** Steps caught in a loop. The graph cannot be saved while this is non-empty. */
  cycle: string[];
  /** Reachable-but-pointless steps: nothing connects to them and they lead nowhere. */
  orphans: string[];
}

export function useGraphEditor() {
  const [state, dispatch] = useReducer(reduce, {
    present: EMPTY,
    past: [],
    future: [],
  });

  const { nodes, edges, selected } = state.present;

  /**
   * Validation runs on every render rather than at save time, so a loop is
   * visible on the canvas as it is drawn instead of coming back as a server
   * error after the fact.
   */
  const problems = useMemo<GraphProblems>(() => {
    const asEdges: GraphEdge[] = edges.map((edge) => ({
      from_slug: edge.from,
      to_slug: edge.to,
      branch_key: edge.branch,
    }));

    let cycle: string[] = [];
    try {
      topologicalOrder(nodes, asEdges);
    } catch (error) {
      if (error instanceof GraphCycleError) cycle = error.slugs;
      else throw error;
    }

    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    const orphans =
      nodes.length > 1 ? nodes.filter((n) => !connected.has(n.slug)).map((n) => n.slug) : [];

    return { cycle, orphans };
  }, [nodes, edges]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedSet.has(node.slug)),
    [nodes, selectedSet],
  );

  /**
   * The Inspector edits exactly one node, so it is only handed one when the
   * selection is unambiguous. Two selected steps have no single name, type or
   * config to put in the fields.
   */
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;

  /** The selection as a detached fragment — what copy and duplicate hand around. */
  const selectionFragment = useMemo<GraphFragment>(() => {
    const inside = new Set(selectedNodes.map((node) => node.slug));
    return {
      nodes: selectedNodes.map((node) => ({ ...node })),
      edges: edges
        .filter((edge) => inside.has(edge.from) && inside.has(edge.to))
        .map((edge) => ({ from: edge.from, to: edge.to, branch: edge.branch })),
    };
  }, [selectedNodes, edges]);

  return {
    nodes,
    edges,
    selected,
    selectedSet,
    selectedNodes,
    selectedNode,
    selectionFragment,
    problems,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    // useReducer's dispatch is already referentially stable.
    dispatch,
    /** Grid step for arrow-key nudging, so the keyboard and the mouse agree. */
    gridStep: GRID,
  };
}
