"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import { NODE_HEIGHT, NODE_WIDTH, type Point, type Viewport } from "./geometry";
import type { CanvasNode } from "./useGraphEditor";

/**
 * A bird's-eye view of the whole graph, with the current viewport drawn on it.
 *
 * The point of it is orientation: once a workflow is bigger than one screen,
 * panning blind is disorienting, and this is the cheapest way to answer "where
 * am I and what else is out there". Clicking or dragging on it re-centres the
 * canvas, so it doubles as coarse navigation.
 *
 * It is deliberately not interactive beyond that — no dragging nodes from here.
 * At this scale a node is a few pixels wide and any edit would be a mis-click.
 */

const WIDTH = 168;
const HEIGHT = 112;
const PADDING = 8;

export interface MinimapProps {
  nodes: CanvasNode[];
  viewport: Viewport;
  /** Size of the canvas surface in screen pixels, to draw the viewport rectangle. */
  surface: { width: number; height: number };
  /** Called with a world point that should become the centre of the view. */
  onNavigate: (centre: Point) => void;
  statusColour?: (slug: string) => string | undefined;
}

export function Minimap({ nodes, viewport, surface, onNavigate, statusColour }: MinimapProps) {
  if (!nodes.length) return null;

  // The world region the map covers: everything the graph occupies, unioned
  // with what is currently on screen, so the viewport rectangle can never slide
  // off the map when panning into empty space.
  const viewLeft = -viewport.x / viewport.scale;
  const viewTop = -viewport.y / viewport.scale;
  const viewWidth = surface.width / viewport.scale;
  const viewHeight = surface.height / viewport.scale;

  const minX = Math.min(...nodes.map((node) => node.x), viewLeft);
  const minY = Math.min(...nodes.map((node) => node.y), viewTop);
  const maxX = Math.max(...nodes.map((node) => node.x + NODE_WIDTH), viewLeft + viewWidth);
  const maxY = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT), viewTop + viewHeight);

  const scale = Math.min(
    (WIDTH - PADDING * 2) / Math.max(1, maxX - minX),
    (HEIGHT - PADDING * 2) / Math.max(1, maxY - minY),
  );

  const toMap = (point: Point): Point => ({
    x: PADDING + (point.x - minX) * scale,
    y: PADDING + (point.y - minY) * scale,
  });

  const navigate = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onNavigate({
      x: minX + (event.clientX - rect.left - PADDING) / scale,
      y: minY + (event.clientY - rect.top - PADDING) / scale,
    });
  };

  const view = toMap({ x: viewLeft, y: viewTop });

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      onPointerDown={(event) => {
        // Capture so a press-and-sweep keeps steering the canvas after the
        // pointer leaves the map.
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        navigate(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) navigate(event);
      }}
      className="cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)]/90 shadow-sm backdrop-blur"
      aria-hidden
    >
      {nodes.map((node) => {
        const point = toMap(node);
        return (
          <rect
            key={node.slug}
            x={point.x}
            y={point.y}
            width={Math.max(2, NODE_WIDTH * scale)}
            height={Math.max(2, NODE_HEIGHT * scale)}
            rx={1}
            fill={statusColour?.(node.slug) ?? "var(--muted)"}
            opacity={0.7}
          />
        );
      })}

      <rect
        x={view.x}
        y={view.y}
        width={viewWidth * scale}
        height={viewHeight * scale}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth={1}
        opacity={0.5}
      />
    </svg>
  );
}
