"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, ErrorNote, Field, inputClass } from "@/components/ui";
import { nhost } from "@/lib/nhost/client";

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await nhost.auth.signUpEmailPassword({ email: email.trim(), password });

      // nhost returns a null session when email verification is required.
      if (response.body.session) {
        router.replace("/workflows");
      } else {
        setNotice("Check your email to verify the account, then sign in.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        You will be able to create an organization and become its owner.
      </p>

      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </Field>

          <ErrorNote>{error}</ErrorNote>
          {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? "Creating…" : "Create account"}
          </Button>
        </form>
      </Card>

      <p className="mt-4 text-center text-sm text-[var(--muted)]">
        Already have an account?{" "}
        <Link href="/sign-in" className="underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}
