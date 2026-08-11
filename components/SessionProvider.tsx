"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import { useGraphQLQuery, useMounted } from "@/lib/hooks";
import { MY_MEMBERSHIPS } from "@/lib/graphql/operations";
import { closeSubscriptionClients } from "@/lib/graphql/subscriptions";
import { createLocalStore } from "@/lib/localStore";
import { nhost } from "@/lib/nhost/client";
import type { OrgRole } from "@/lib/types";

/**
 * Auth session plus organization context.
 *
 * The org a user is looking at determines the role they act in: the same person
 * can be an owner in one org and a viewer in another, so `role` is derived from
 * the active org's membership row and travels with every request as
 * `x-hasura-role`. It is a statement of which hat the user is wearing, not a
 * privilege — Hasura re-checks it against org_members on every operation.
 *
 * Both the nhost session and the active-org choice are external stores read via
 * useSyncExternalStore, so nothing is mirrored into state inside an effect.
 */

export interface Membership {
  id: string;
  org_id: string;
  role: OrgRole;
  invited_email: string;
  org: {
    id: string;
    name: string;
    quota_allowed: number;
    quota_used: number;
  };
}

interface SessionContextValue {
  ready: boolean;
  signedIn: boolean;
  userId: string | null;
  email: string | null;
  memberships: Membership[];
  membershipsError: string | null;
  activeOrgId: string | null;
  activeMembership: Membership | null;
  role: OrgRole | null;
  setActiveOrgId: (orgId: string) => void;
  reloadMemberships: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const activeOrgStore = createLocalStore("foreman.activeOrgId");

/** A primitive snapshot, so repeated reads stay referentially stable. */
const subscribeToSession = (listener: () => void) => nhost.sessionStorage.onChange(listener);
const readAccessToken = () => nhost.getUserSession()?.accessToken ?? null;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const mounted = useMounted();

  const accessToken = useSyncExternalStore(subscribeToSession, readAccessToken, () => null);
  const storedOrgId = useSyncExternalStore(
    activeOrgStore.subscribe,
    activeOrgStore.get,
    activeOrgStore.serverSnapshot,
  );

  const user = useMemo(
    () => (accessToken ? (nhost.getUserSession()?.user ?? null) : null),
    [accessToken],
  );

  const {
    data: membershipData,
    error: membershipsError,
    refetch,
  } = useGraphQLQuery<{ org_members: Membership[] }>(
    MY_MEMBERSHIPS,
    {},
    accessToken ? "user" : null,
  );

  const memberships = useMemo(() => membershipData?.org_members ?? [], [membershipData]);

  // Fall back to the first membership so a fresh sign-in lands somewhere useful.
  const activeOrgId =
    memberships.find((membership) => membership.org_id === storedOrgId)?.org_id ??
    memberships[0]?.org_id ??
    null;

  const setActiveOrgId = useCallback((orgId: string) => activeOrgStore.set(orgId), []);

  const signOut = useCallback(async () => {
    const session = nhost.getUserSession();
    try {
      if (session?.refreshToken) {
        await nhost.auth.signOut({ refreshToken: session.refreshToken });
      }
    } catch {
      /* clearing the local session is what matters */
    }
    closeSubscriptionClients();
    nhost.clearSession();
    activeOrgStore.remove();
  }, []);

  const activeMembership =
    memberships.find((membership) => membership.org_id === activeOrgId) ?? null;

  const value: SessionContextValue = {
    ready: mounted,
    signedIn: Boolean(accessToken),
    userId: user?.id ?? null,
    email: user?.email ?? null,
    memberships,
    membershipsError,
    activeOrgId,
    activeMembership,
    role: activeMembership?.role ?? null,
    setActiveOrgId,
    reloadMemberships: refetch,
    signOut,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside <SessionProvider>");
  return context;
}
