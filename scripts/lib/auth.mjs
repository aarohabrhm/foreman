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
    const message = payload?.message ?? payload?.error ?? response.statusText;
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
export async function ensureUser(email, password, displayName) {
  try {
    const created = await signUp(email, password, displayName);
    if (created?.session) return { session: created.session, created: true };
  } catch (error) {
    const alreadyExists =
      error.status === 409 ||
      /already.*(exist|in use)|email-already-in-use/i.test(error.payload?.error ?? error.message);
    if (!alreadyExists) throw error;
  }

  const signedIn = await signIn(email, password);
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

  return response.json();
}
