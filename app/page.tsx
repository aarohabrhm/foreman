"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useSession } from "@/components/SessionProvider";

export default function HomePage() {
  const router = useRouter();
  const { ready, signedIn } = useSession();

  useEffect(() => {
    if (!ready) return;
    router.replace(signedIn ? "/workflows" : "/sign-in");
  }, [ready, signedIn, router]);

  return <p className="text-sm text-[var(--muted)]">Loading…</p>;
}
