"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useSession } from "@/components/SessionProvider";
import { UsageIndicator } from "@/components/UsageIndicator";

export function AppHeader() {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  if (!session.ready || pathname === "/sign-in" || pathname === "/sign-up") return null;

  return (
    <header className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/workflows" className="font-semibold tracking-tight">
          Foreman
        </Link>

        {session.signedIn ? (
          <>
            {session.memberships.length > 0 ? (
              <select
                aria-label="Organization"
                value={session.activeOrgId ?? ""}
                onChange={(event) => session.setActiveOrgId(event.target.value)}
                className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm"
              >
                {session.memberships.map((membership) => (
                  <option key={membership.org_id} value={membership.org_id}>
                    {membership.org.name}
                  </option>
                ))}
              </select>
            ) : null}

            {session.role ? (
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium dark:bg-white/10">
                {session.role}
              </span>
            ) : null}

            <div className="ml-auto flex items-center gap-3">
              <UsageIndicator />
              <span className="hidden text-xs text-[var(--muted)] sm:inline">{session.email}</span>
              <button
                onClick={async () => {
                  await session.signOut();
                  router.push("/sign-in");
                }}
                className="text-sm underline underline-offset-4"
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <Link href="/sign-in" className="ml-auto text-sm underline underline-offset-4">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
