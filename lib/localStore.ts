"use client";

/**
 * A localStorage key exposed as an external store, so components can read it
 * with useSyncExternalStore instead of copying it into state inside an effect.
 *
 * That matters here for hydration: the server has no localStorage, so the
 * server snapshot is null and React swaps in the real value after hydration
 * without a mismatch or a cascading re-render.
 */
export interface LocalStore {
  get: () => string | null;
  set: (value: string) => void;
  remove: () => void;
  subscribe: (listener: () => void) => () => void;
  serverSnapshot: () => null;
}

export function createLocalStore(key: string): LocalStore {
  const listeners = new Set<() => void>();
  let cached: string | null = null;
  let primed = false;

  const read = () => {
    if (typeof window === "undefined") return null;
    if (!primed) {
      cached = window.localStorage.getItem(key);
      primed = true;
    }
    return cached;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    // Cached so repeated calls return a stable value, as useSyncExternalStore requires.
    get: read,
    set: (value: string) => {
      cached = value;
      primed = true;
      window.localStorage.setItem(key, value);
      notify();
    },
    remove: () => {
      cached = null;
      primed = true;
      window.localStorage.removeItem(key);
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) {
          primed = false;
          listener();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    serverSnapshot: () => null,
  };
}
