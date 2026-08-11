"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import type { RunStatus, StepRunStatus } from "@/lib/types";

/** Small shared primitives — functional, not a design system. */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 ${className}`}
    >
      {children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonProps) {
  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-500 disabled:bg-blue-600/40",
    secondary:
      "border border-[var(--border)] hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40",
    danger: "border border-red-500/50 text-red-600 hover:bg-red-500/10 disabled:opacity-40",
  }[variant];

  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="block font-medium mb-1">{label}</span>
      {children}
      {hint ? <span className="block mt-1 text-xs text-[var(--muted)]">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm outline-none focus:border-blue-500";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-500/15 text-gray-600 dark:text-gray-300",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  paused: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  awaiting_approval: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  succeeded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-600 dark:text-red-300",
  skipped: "bg-gray-500/10 text-gray-500",
};

export function StatusPill({ status }: { status: RunStatus | StepRunStatus | string }) {
  const label = status === "awaiting_approval" ? "awaiting approval" : status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? STATUS_STYLES.pending
      }`}
    >
      {label}
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--muted)]">{children}</p>;
}
