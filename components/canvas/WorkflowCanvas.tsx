"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui";
import { OWNER_ONLY_STEP_TYPES, STEP_LABELS } from "@/lib/stepTemplates";
import { STEP_TYPES, type EdgeBranchKey, type StepRunStatus, type StepType } from "@/lib/types";

import { EdgeLayer } from "./EdgeLayer";
import { Minimap } from "./Minimap";
import { StepNode } from "./StepNode";
import {
  GRID,
  NODE_HEIGHT,
  NODE_WIDTH,
  autoLayout,
  clampScale,
  outputPort,
  snap,
  toWorld,
  type Point,
  type Viewport,
} from "./geometry";
import {
  CLONE_OFFSET,
  type CanvasEdge,
  type CanvasNode,
  type EditorAction,
  type GraphFragment,
  type GraphProblems,
} from "./useGraphEditor";

/**
 * The canvas: a pan/zoom viewport over the workflow graph.
 *
 * There is one transformed layer holding the edge SVG and every node, so
 * panning and zooming are a single CSS transform and nothing below has to think
 * about screen coordinates. Pointer handling is centralised here — the node and
 * port components only report that a gesture started — because a drag has to
 * keep working when the pointer leaves the element that began it, which means
 * capturing it on the container.
 *
 * Dragging the background draws a selection marquee rather than panning, which
 * is the convention every node editor of this shape uses. Panning is then the
 * middle button, or space with the left button, or a trackpad two-finger
 * scroll — and always available, so the canvas is never stuck.
 */

interface DragState {
  kind: "pan" | "node" | "connect" | "marquee";
  pointerId: number;
  /** pan: viewport origin at gesture start. node: pointer offset inside the grabbed node. */
  origin: Point;
  start: Point;
  slug?: string;
  branch?: EdgeBranchKey;
  /** node: where every node being dragged sat when the gesture began. */
  from?: Map<string, Point>;
  /** marquee: the world-space corner the rubber band was pulled from. */
  anchor?: Point;
  /** marquee: what was already selected, when the band is being added to. */
  base?: string[];
}

export interface WorkflowCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selected: string[];
  selectedSet: Set<string>;
  selectionFragment: GraphFragment;
  problems: GraphProblems;
  dispatch: Dispatch<EditorAction>;
  canEdit: boolean;
  isOwner: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Live run status per slug, for painting progress onto the graph. */
  statusBySlug?: Record<string, StepRunStatus>;
}

export function WorkflowCanvas({
  nodes,
  edges,
  selected,
  selectedSet,
  selectionFragment,
  problems,
  dispatch,
  canEdit,
  isOwner,
  canUndo,
  canRedo,
  statusBySlug,
}: WorkflowCanvasProps) {
  const surface = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 60, y: 60, scale: 1 });

  /**
   * The gesture in flight. This is a ref, not state, and deliberately so: the
   * pointer handlers read it, and React state would still hold its previous
   * value in a handler that fires before the re-render. Pointer events can
   * arrive faster than React re-renders — a quick flick, a synthesised event,
   * a busy frame — and a gesture that read stale state would simply be
   * dropped. `dragKind` mirrors it for the parts that only affect painting.
   */
  const dragRef = useRef<DragState | null>(null);
  const [dragKind, setDragKind] = useState<DragState["kind"] | null>(null);

  const beginDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDragKind(next?.kind ?? null);
  }, []);

  /**
   * The connection being dragged out of a port. Held in state rather than read
   * off the gesture ref, because the pending edge is drawn during render and a
   * ref is not a render input.
   */
  const [connecting, setConnecting] = useState<{
    slug: string;
    branch: EdgeBranchKey;
    at: Point;
  } | null>(null);
  /** The rubber band, in world coordinates, while one is being pulled. */
  const marqueeRef = useRef<{ a: Point; b: Point } | null>(null);
  const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);

  const setBand = useCallback((band: { a: Point; b: Point } | null) => {
    marqueeRef.current = band;
    setMarquee(band);
  }, []);
  /** Held space turns the left button into a pan, as in every drawing tool. */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** Palette shown after a connection is dropped on empty canvas. */
  const [pendingDrop, setPendingDrop] = useState<{
    screen: Point;
    world: Point;
    from: { slug: string; branch: EdgeBranchKey };
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The connection a step is about to be spliced into, via its + control. */
  const [insertTarget, setInsertTarget] = useState<string | null>(null);

  /**
   * Copy/paste is deliberately local to the canvas rather than the system
   * clipboard: the fragment is a live object graph, and round-tripping it
   * through text would mean inventing a serialisation and guarding against
   * pasted junk for no gain inside one editor.
   */
  const clipboard = useRef<GraphFragment | null>(null);

  const localPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = surface.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  // The minimap needs the surface's pixel size to draw the viewport rectangle.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Wheel is attached by hand rather than via onWheel, because zooming has to
  // preventDefault and React attaches wheel listeners passively.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };

      // A trackpad two-finger scroll pans; a pinch (which arrives as ctrl+wheel)
      // and a mouse wheel zoom. This is what a browser itself does, so the
      // gesture people already have in their hands is the right one.
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        setViewport((current) => ({ ...current, x: current.x - event.deltaX }));
        return;
      }

      setViewport((current) => {
        const next = clampScale(current.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
        if (next === current.scale) return current;
        // Keep the world point under the cursor pinned while the scale changes.
        const world = toWorld(point, current);
        return { scale: next, x: point.x - world.x * next, y: point.y - world.y * next };
      });
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) =>
    setViewport((current) => {
      const rect = surface.current?.getBoundingClientRect();
      const centre = { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
      const next = clampScale(current.scale * factor);
      if (next === current.scale) return current;
      const world = toWorld(centre, current);
      return { scale: next, x: centre.x - world.x * next, y: centre.y - world.y * next };
    });

  /** Frames a set of nodes: Fit uses all of them, Zoom to selection just some. */
  const frame = useCallback((subject: CanvasNode[]) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || !subject.length) return;

    const minX = Math.min(...subject.map((node) => node.x));
    const minY = Math.min(...subject.map((node) => node.y));
    const maxX = Math.max(...subject.map((node) => node.x + NODE_WIDTH));
    const maxY = Math.max(...subject.map((node) => node.y + NODE_HEIGHT));

    const padding = 60;
    const scale = clampScale(
      Math.min(
        (rect.width - padding * 2) / Math.max(1, maxX - minX),
        (rect.height - padding * 2) / Math.max(1, maxY - minY),
        1,
      ),
    );

    setViewport({
      scale,
      x: (rect.width - (maxX - minX) * scale) / 2 - minX * scale,
      y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale,
    });
  }, []);

  const centreOn = useCallback((world: Point) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    setViewport((current) => ({
      ...current,
      x: rect.width / 2 - world.x * current.scale,
      y: rect.height / 2 - world.y * current.scale,
    }));
  }, []);

  // ---- clipboard ----------------------------------------------------------

  const paste = useCallback(
    (fragment: GraphFragment | null) => {
      if (!canEdit || !fragment?.nodes.length) return;
      dispatch({
        type: "insertGraph",
        fragment,
        offset: { x: CLONE_OFFSET, y: CLONE_OFFSET },
      });
    },
    [canEdit, dispatch],
  );

  // ---- gestures -----------------------------------------------------------

  function beginBackgroundDrag(event: ReactPointerEvent<HTMLDivElement>) {
    // Only the background starts one of these; a node or a port handles its own.
    if (event.target !== event.currentTarget) return;
    setPendingDrop(null);
    setPaletteOpen(false);
    event.currentTarget.setPointerCapture(event.pointerId);

    // Middle button, space, or a modifier-free right-ish gesture pans. Plain
    // left-drag draws a marquee.
    const panning = event.button === 1 || spaceHeld;
    if (panning) {
      beginDrag({
        kind: "pan",
        pointerId: event.pointerId,
        origin: { x: viewport.x, y: viewport.y },
        start: { x: event.clientX, y: event.clientY },
      });
      return;
    }

    const world = toWorld(localPoint(event), viewport);
    // Shift keeps what is already selected, so a marquee can extend a selection.
    if (!event.shiftKey) dispatch({ type: "select", slugs: [] });
    setBand({ a: world, b: world });
    beginDrag({
      kind: "marquee",
      pointerId: event.pointerId,
      origin: { x: 0, y: 0 },
      start: { x: event.clientX, y: event.clientY },
      anchor: world,
      base: event.shiftKey ? selected : [],
    });
  }

  function beginNodeDrag(node: CanvasNode, event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();

    // Shift-click adds or removes a node without starting a drag: the gesture
    // is "adjust the selection", and moving the graph at the same time would
    // make it impossible to do precisely.
    if (event.shiftKey) {
      dispatch({ type: "toggleSelect", slug: node.slug });
      return;
    }

    // Dragging a node that is already part of a multi-selection moves the whole
    // selection; dragging an unselected one selects just it first.
    const group = selectedSet.has(node.slug) ? selected : [node.slug];
    if (!selectedSet.has(node.slug)) dispatch({ type: "select", slugs: [node.slug] });
    if (!canEdit) return;

    const world = toWorld(localPoint(event), viewport);
    const from = new Map<string, Point>();
    for (const candidate of nodes) {
      if (group.includes(candidate.slug)) from.set(candidate.slug, { x: candidate.x, y: candidate.y });
    }

    // One checkpoint per gesture, so the whole drag undoes in a single step.
    dispatch({ type: "checkpoint" });
    surface.current?.setPointerCapture(event.pointerId);
    beginDrag({
      kind: "node",
      pointerId: event.pointerId,
      slug: node.slug,
      origin: { x: world.x - node.x, y: world.y - node.y },
      start: { x: event.clientX, y: event.clientY },
      from,
    });
  }

  function beginConnect(
    node: CanvasNode,
    branch: EdgeBranchKey,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.stopPropagation();
    if (!canEdit) return;

    const point = localPoint(event);
    surface.current?.setPointerCapture(event.pointerId);
    setConnecting({ slug: node.slug, branch, at: toWorld(point, viewport) });
    beginDrag({
      kind: "connect",
      pointerId: event.pointerId,
      slug: node.slug,
      branch,
      origin: { x: 0, y: 0 },
      start: { x: event.clientX, y: event.clientY },
    });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (drag.kind === "pan") {
      setViewport((current) => ({
        ...current,
        x: drag.origin.x + (event.clientX - drag.start.x),
        y: drag.origin.y + (event.clientY - drag.start.y),
      }));
      return;
    }

    if (drag.kind === "marquee" && drag.anchor) {
      setBand({ a: drag.anchor, b: toWorld(localPoint(event), viewport) });
      return;
    }

    if (drag.kind === "node" && drag.slug && drag.from) {
      const world = toWorld(localPoint(event), viewport);
      const anchor = drag.from.get(drag.slug);
      if (!anchor) return;

      // Snap the grabbed node to the grid, then move everything else by the
      // same delta. Snapping each node independently would slowly crush a
      // group's relative spacing every time it was dragged.
      const dx = snap(world.x - drag.origin.x) - anchor.x;
      const dy = snap(world.y - drag.origin.y) - anchor.y;

      const positions = new Map<string, Point>();
      for (const [slug, point] of drag.from) positions.set(slug, { x: point.x + dx, y: point.y + dy });
      dispatch({ type: "moveNodes", positions, history: false });
      return;
    }

    if (drag.kind === "connect") {
      const at = toWorld(localPoint(event), viewport);
      setConnecting((current) => (current ? { ...current, at } : current));
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    // The release itself carries a position, so a band is resolved against
    // where the pointer actually ended rather than the last move we happened
    // to render. A press and release with no move in between is a click on the
    // background, and correctly selects nothing.
    const band =
      drag.kind === "marquee" && drag.anchor
        ? { a: drag.anchor, b: toWorld(localPoint(event), viewport) }
        : marqueeRef.current;

    if (drag.kind === "marquee" && band) {
      const left = Math.min(band.a.x, band.b.x);
      const right = Math.max(band.a.x, band.b.x);
      const top = Math.min(band.a.y, band.b.y);
      const bottom = Math.max(band.a.y, band.b.y);

      // Touch, not containment: a band that clips a node takes it. Requiring
      // full enclosure means a careful sweep still misses the node at the edge.
      const caught = nodes
        .filter(
          (node) =>
            node.x < right &&
            node.x + NODE_WIDTH > left &&
            node.y < bottom &&
            node.y + NODE_HEIGHT > top,
        )
        .map((node) => node.slug);

      dispatch({ type: "select", slugs: [...new Set([...(drag.base ?? []), ...caught])] });
      setBand(null);
    }

    if (drag.kind === "connect" && drag.slug) {
      // The pointer is captured by the surface, so the release never lands on
      // the port itself — ask the document what is actually under the cursor.
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const dropped = target?.closest<HTMLElement>("[data-port-input], [data-node]");
      const to = dropped?.dataset.portInput ?? dropped?.dataset.node;

      if (to && to !== drag.slug) {
        dispatch({
          type: "connect",
          from: drag.slug,
          to,
          branch: drag.branch ?? "",
        });
      } else if (!to) {
        // Dropped on empty canvas: offer to create the next step right there,
        // already wired up. This is the fastest way to build a graph.
        const world = toWorld(localPoint(event), viewport);
        setPendingDrop({
          screen: localPoint(event),
          world: { x: snap(world.x), y: snap(world.y - NODE_HEIGHT / 2) },
          from: { slug: drag.slug, branch: drag.branch ?? "" },
        });
      }
    }

    beginDrag(null);
    setConnecting(null);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (event.key === " " && !spaceHeld) {
      // Held space is a pan modifier, and must not also scroll the page.
      event.preventDefault();
      setSpaceHeld(true);
      return;
    }

    if (meta && key === "z") {
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "redo" : "undo" });
      return;
    }
    if (meta && key === "y") {
      event.preventDefault();
      dispatch({ type: "redo" });
      return;
    }
    if (meta && key === "a") {
      event.preventDefault();
      dispatch({ type: "selectAll" });
      return;
    }
    if (meta && key === "c") {
      if (selectionFragment.nodes.length) clipboard.current = selectionFragment;
      return;
    }
    if (meta && key === "v") {
      event.preventDefault();
      paste(clipboard.current);
      return;
    }
    if (meta && key === "d") {
      event.preventDefault();
      paste(selectionFragment);
      return;
    }
    if (event.key === "Escape") {
      setPendingDrop(null);
      setPaletteOpen(false);
      dispatch({ type: "select", slugs: [] });
      return;
    }

    if (!selected.length || !canEdit) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "deleteSelection" });
      return;
    }

    // Arrow keys nudge the selection. This is the canvas successor to the old
    // list's up/down buttons: the graph stays fully editable from the keyboard,
    // which a drag-only canvas would not be.
    const step = event.shiftKey ? GRID * 5 : GRID;
    const delta: Record<string, Point> = {
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
    };
    const move = delta[event.key];
    if (move) {
      event.preventDefault();
      dispatch({ type: "nudgeSelection", dx: move.x, dy: move.y });
    }
  }

  const addStep = (type: StepType, at?: Point) => {
    const rect = surface.current?.getBoundingClientRect();
    const centre = toWorld({ x: (rect?.width ?? 400) / 2, y: (rect?.height ?? 300) / 2 }, viewport);
    dispatch({
      type: "addNode",
      stepType: type,
      x: at?.x ?? snap(centre.x - NODE_WIDTH / 2),
      y: at?.y ?? snap(centre.y - NODE_HEIGHT / 2),
    });
    setPaletteOpen(false);
  };

  const pendingEdge = (() => {
    if (!connecting) return null;
    const source = nodes.find((node) => node.slug === connecting.slug);
    if (!source) return null;
    return { from: outputPort(source, source.type, connecting.branch), to: connecting.at };
  })();

  const cycle = new Set(problems.cycle);
  const orphans = new Set(problems.orphans);
  const selectedNodes = nodes.filter((node) => selectedSet.has(node.slug));

  return (
    <div className="relative h-full w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)]">
      {/* --- toolbar --- */}
      <div className="absolute left-2 top-2 z-20 flex flex-wrap items-center gap-1">
        {canEdit ? (
          <div className="relative">
            <Button onClick={() => setPaletteOpen((open) => !open)}>+ Add step</Button>
            {paletteOpen ? (
              <StepMenu
                isOwner={isOwner}
                onPick={(type) => addStep(type)}
                onDismiss={() => setPaletteOpen(false)}
              />
            ) : null}
          </div>
        ) : null}
        <Button onClick={() => zoomBy(1.2)} title="Zoom in">
          +
        </Button>
        <Button onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
          −
        </Button>
        <Button
          onClick={() => frame(selectedNodes.length ? selectedNodes : nodes)}
          title={
            selectedNodes.length
              ? "Zoom to the selected steps"
              : "Fit the whole workflow in view"
          }
        >
          {selectedNodes.length ? "Zoom to selection" : "Fit"}
        </Button>
        {canEdit ? (
          <>
            <Button
              onClick={() =>
                dispatch({
                  type: "tidy",
                  positions: autoLayout(
                    nodes,
                    edges.map((edge) => ({ from_slug: edge.from, to_slug: edge.to })),
                  ),
                })
              }
              title="Lay the graph out left to right"
            >
              Tidy up
            </Button>
            <Button
              onClick={() => paste(selectionFragment)}
              disabled={!selected.length}
              title="Duplicate the selected steps (Ctrl+D)"
            >
              Duplicate
            </Button>
            <Button onClick={() => dispatch({ type: "undo" })} disabled={!canUndo} title="Undo">
              ↶
            </Button>
            <Button onClick={() => dispatch({ type: "redo" })} disabled={!canRedo} title="Redo">
              ↷
            </Button>
          </>
        ) : null}
      </div>

      {problems.cycle.length ? (
        <p className="absolute bottom-2 left-2 z-20 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-300">
          These steps loop back on themselves and cannot run: {problems.cycle.join(", ")}
        </p>
      ) : null}

      <div className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-end gap-2">
        {selected.length > 1 ? (
          <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-[var(--muted)] dark:bg-white/10">
            {selected.length} selected
          </span>
        ) : null}
        <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-[var(--muted)] dark:bg-white/10">
          {Math.round(viewport.scale * 100)}%
        </span>
        <div className="pointer-events-auto">
          <Minimap nodes={nodes} viewport={viewport} surface={size} onNavigate={centreOn} />
        </div>
      </div>

      {/* --- surface --- */}
      <div
        ref={surface}
        tabIndex={0}
        role="application"
        aria-label="Workflow graph"
        onPointerDown={beginBackgroundDrag}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key === " ") setSpaceHeld(false);
        }}
        onBlur={() => setSpaceHeld(false)}
        className="h-full w-full outline-none"
        style={{
          cursor:
            dragKind === "pan" ? "grabbing" : spaceHeld ? "grab" : "default",
          // A dot grid, drawn in screen space and offset by the pan, so it
          // reads as the canvas moving underneath rather than a static texture.
          backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
          backgroundSize: `${GRID * viewport.scale}px ${GRID * viewport.scale}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          <EdgeLayer
            nodes={nodes}
            edges={edges}
            pending={pendingEdge}
            editable={canEdit}
            onDeleteEdge={(id) => dispatch({ type: "deleteEdge", id })}
            onInsertOnEdge={(id) => {
              setPendingDrop(null);
              setInsertTarget(id);
            }}
          />

          {nodes.map((node) => (
            <StepNode
              key={node.slug}
              node={node}
              selected={selectedSet.has(node.slug)}
              invalid={cycle.has(node.slug)}
              orphaned={orphans.has(node.slug)}
              status={statusBySlug?.[node.slug]}
              editable={canEdit}
              onPointerDown={(event) => beginNodeDrag(node, event)}
              onPortPointerDown={(branch, event) => beginConnect(node, branch, event)}
            />
          ))}

          {marquee ? (
            <div
              className="pointer-events-none absolute rounded-sm border border-sky-500 bg-sky-500/10"
              style={{
                left: Math.min(marquee.a.x, marquee.b.x),
                top: Math.min(marquee.a.y, marquee.b.y),
                width: Math.abs(marquee.b.x - marquee.a.x),
                height: Math.abs(marquee.b.y - marquee.a.y),
              }}
            />
          ) : null}
        </div>
      </div>

      {/* Palette shown where a connection was dropped, so the new step arrives
          already wired to the port it came from. */}
      {pendingDrop ? (
        <div
          className="absolute z-30"
          style={{ left: pendingDrop.screen.x, top: pendingDrop.screen.y }}
        >
          <StepMenu
            isOwner={isOwner}
            heading="Connect to a new step"
            onPick={(type) => {
              dispatch({
                type: "addNode",
                stepType: type,
                x: pendingDrop.world.x,
                y: pendingDrop.world.y,
                connectFrom: pendingDrop.from,
              });
              setPendingDrop(null);
            }}
            onDismiss={() => setPendingDrop(null)}
          />
        </div>
      ) : null}

      {insertTarget ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/20">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg">
            <StepMenu
              isOwner={isOwner}
              heading="Insert a step into this connection"
              inline
              onPick={(type) => {
                dispatch({ type: "insertOnEdge", id: insertTarget, stepType: type });
                setInsertTarget(null);
              }}
              onDismiss={() => setInsertTarget(null)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepMenu({
  isOwner,
  heading,
  inline = false,
  onPick,
  onDismiss,
}: {
  isOwner: boolean;
  heading?: string;
  inline?: boolean;
  onPick: (type: StepType) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className={
        inline
          ? "w-64"
          : "absolute left-0 top-full mt-1 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
      }
      onPointerDown={(event) => event.stopPropagation()}
    >
      {heading ? (
        <p className="px-2 py-1 text-xs font-medium text-[var(--muted)]">{heading}</p>
      ) : null}
      {STEP_TYPES.map((type) => {
        const blocked = !isOwner && OWNER_ONLY_STEP_TYPES.includes(type);
        return (
          <button
            key={type}
            disabled={blocked}
            onClick={() => onPick(type)}
            title={blocked ? "Only an owner may add this step type" : undefined}
            className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/5"
          >
            {STEP_LABELS[type]}
            {blocked ? <span className="text-xs text-[var(--muted)]"> (owner only)</span> : null}
          </button>
        );
      })}
      <button
        onClick={onDismiss}
        className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/5"
      >
        Cancel
      </button>
    </div>
  );
}
