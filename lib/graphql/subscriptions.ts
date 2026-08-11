"use client";

import { createClient, type Client } from "graphql-ws";

import { graphqlWsUrl } from "@/lib/env";
import { nhost } from "@/lib/nhost/client";
import type { OrgRole } from "@/lib/types";

/**
 * Websocket transport for GraphQL subscriptions.
 *
 * One socket per acting role, shared by every subscription on the page (the run
 * view watches both the run and its step_runs). `connectionParams` is evaluated
 * on each connect, so a reconnect after a token refresh carries a fresh JWT.
 *
 * The role travels on the socket the same way it travels on queries: Hasura
 * still applies the Layer 1 rules, so a subscription cannot observe rows the
 * caller could not have queried.
 */

const clients = new Map<string, Client>();

export function subscriptionClient(role: OrgRole | "user"): Client {
  const existing = clients.get(role);
  if (existing) return existing;

  const client = createClient({
    url: graphqlWsUrl(),
    lazy: true,
    retryAttempts: 10,
    connectionParams: () => {
      const session = nhost.getUserSession();
      return {
        headers: {
          ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
          "x-hasura-role": role,
        },
      };
    },
  });

  clients.set(role, client);
  return client;
}

/** Drops every socket — used on sign-out so no stream outlives the session. */
export function closeSubscriptionClients(): void {
  for (const client of clients.values()) {
    void client.dispose();
  }
  clients.clear();
}
