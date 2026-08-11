/** nhost Auth helpers for the seed and cross-org scripts. */

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} — copy .env.example to .env.local`);
  return value;
};

export function authBaseUrl() {
  const subdomain = requiredEnv("NEXT_PUBLIC_NHOST_SUBDOMAIN");
  const region = requiredEnv("NEXT_PUBLIC_NHOST_REGION");
  return `https://${subdomain}.auth.${region}.nhost.run/v1`;
}

async function authPost(path, body) {
  const response = await fetch(`${authBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = [payload?.message ?? payload?.error ?? response.statusText, payload?.reason]
      .filter(Boolean)
      .join(" — ");
    const error = new Error(`${path} failed (${response.status}): ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const signIn = (email, password) =>
  authPost("/signin/email-password", { email, password });

export const signUp = (email, password, displayName) =>
  authPost("/signup/email-password", {
    email,
    password,
    options: { displayName },
  });

/**
 * Creates the user if they do not exist, and returns their session either way.
 * Re-running the seed is therefore harmless.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * nhost rate-limits sign-up and sign-in per IP and does not return Retry-After,
 * so a 429 is waited out rather than treated as a failure. Seeding four accounts
 * in one go can otherwise trip the limit.
 */
async function withRateLimitBackoff(operation, label, attempts = 8) {
  let waitMs = 30_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error.status !== 429 || attempt === attempts) throw error;
      console.log(
        `  rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt}/${attempts - 1})`,
      );
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 2, 300_000);
    }
  }
  throw new Error(`Gave up on ${label} after ${attempts} attempts`);
}

export async function ensureUser(email, password, displayName) {
  try {
    const created = await withRateLimitBackoff(
      () => signUp(email, password, displayName),
      `sign-up for ${email}`,
    );
    if (created?.session) return { session: created.session, created: true };
  } catch (error) {
    const alreadyExists =
      error.status === 409 ||
      /already.*(exist|in use)|email-already-in-use/i.test(error.payload?.error ?? error.message);
    if (!alreadyExists) throw error;
  }

  const signedIn = await withRateLimitBackoff(
    () => signIn(email, password),
    `sign-in for ${email}`,
  );
  if (!signedIn?.session) {
    throw new Error(
      `Could not sign in as ${email}. If nhost requires email verification, disable it ` +
        "(Dashboard -> Settings -> Sign-In Methods -> Email and Password) and re-run.",
    );
  }
  return { session: signedIn.session, created: false };
}

/** GraphQL as a specific signed-in user, optionally acting in a specific role. */
export async function userGraphql(accessToken, query, variables = {}, role) {
  const subdomain = requiredEnv("NEXT_PUBLIC_NHOST_SUBDOMAIN");
  const region = requiredEnv("NEXT_PUBLIC_NHOST_REGION");

  const response = await fetch(`https://${subdomain}.hasura.${region}.nhost.run/v1/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(role ? { "x-hasura-role": role } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  // Not always JSON: a rate limit or an edge error can return an HTML page, and
  // a test that crashes on that reports nothing useful about isolation.
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      errors: [
        {
          message: `non-JSON response (HTTP ${response.status}): ${text.replace(/\s+/g, " ").slice(0, 120)}`,
        },
      ],
      httpStatus: response.status,
    };
  }
}
