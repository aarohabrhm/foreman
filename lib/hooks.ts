"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { subscriptionClient } from "@/lib/graphql/subscriptions";
import { userGraphql } from "@/lib/nhost/client";
import type { OrgRole } from "@/lib/types";

/**
 * Minimal data-fetching hooks over the nhost client and graphql-ws.
 *
 * The app has a handful of operations and needs exact control over the
 * `x-hasura-role` header on every one of them, so this is deliberately a thin
 * layer rather than a full GraphQL client.
 *
 * Both hooks key their result on the request they came from and derive
 * loading/live during render, so nothing calls setState from an effect body and
 * a result from a superseded request can never be shown against a new one.
 */

/** True after hydration — hydration-safe, and without a mounted-flag effect. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export interface QueryState<TData> {
  data: TData | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

export function useGraphQLQuery<TData>(
  query: string,
  variables: Record<string, unknown> | null,
  role: OrgRole | "user" | null,
): QueryState<TData> {
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data: TData | null;
    error: string | null;
  } | null>(null);

  const serialisedVariables = JSON.stringify(variables ?? {});
  const key = `${role ?? ""}|${query}|${serialisedVariables}|${nonce}`;

  useEffect(() => {
    if (!role) return;

    let cancelled = false;
    userGraphql<TData>(query, JSON.parse(serialisedVariables), role === "user" ? undefined : role)
      .then((data) => {
        if (!cancelled) setResult({ key, data, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setResult({
            key,
            data: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, query, serialisedVariables, role]);

  const settled = result?.key === key ? result : null;
  const refetch = useCallback(() => setNonce((value) => value + 1), []);

  return {
    data: settled?.data ?? null,
    error: settled?.error ?? null,
    loading: Boolean(role) && !settled,
    refetch,
  };
}

export interface SubscriptionState<TData> {
  data: TData | null;
  error: string | null;
  /** True once this subscription has delivered at least one payload. */
  live: boolean;
}

export function useGraphQLSubscription<TData>(
  query: string,
  variables: Record<string, unknown> | null,
  role: OrgRole | "user" | null,
): SubscriptionState<TData> {
  const [payload, setPayload] = useState<{
    key: string;
    data: TData | null;
    error: string | null;
  } | null>(null);

  const serialisedVariables = JSON.stringify(variables ?? {});
  const enabled = Boolean(role && variables);
  const key = `${role ?? ""}|${query}|${serialisedVariables}`;

  useEffect(() => {
    if (!enabled || !role) return;

    const unsubscribe = subscriptionClient(role).subscribe<TData>(
      { query, variables: JSON.parse(serialisedVariables) },
      {
        next: (message) => {
          if (message.errors?.length) {
            setPayload({
              key,
              data: null,
              error: message.errors.map((entry) => entry.message).join("; "),
            });
            return;
          }
          if (message.data) setPayload({ key, data: message.data, error: null });
        },
        error: (cause) => setPayload({ key, data: null, error: describe(cause) }),
        complete: () => {},
      },
    );

    return () => unsubscribe();
  }, [key, query, serialisedVariables, role, enabled]);

  const current = payload?.key === key ? payload : null;

  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    live: Boolean(current?.data),
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (Array.isArray(cause)) {
    return cause.map((entry) => String((entry as { message?: string }).message ?? entry)).join("; ");
  }
  if (cause && typeof cause === "object") {
    const maybe = cause as { message?: string; reason?: string };
    if (maybe.message) return maybe.message;
    if (maybe.reason) return maybe.reason;
  }
  return String(cause);
}
