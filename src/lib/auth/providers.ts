import { authConfig } from "./config";

/**
 * A provider identity, normalized at the boundary (#35 Phase A).
 *
 * `subject` is the provider's stable id and is what a User row keys on — it
 * survives a rename, which `username` does not. `username` and `email` exist
 * only so provisioning can match an invitation the owner typed by hand; both
 * are lowercased + trimmed here so every consumer compares like for like, and
 * both are optional because a provider may withhold them.
 */
export interface AuthProfile {
  subject: string;
  username?: string;
  email?: string;
}

export interface AuthProvider {
  buildAuthorizeUrl(a: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(a: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string>;
  /** Returns the normalized profile for the signed-in identity. */
  fetchProfile(accessToken: string): Promise<AuthProfile>;
}

/** Lowercase + trim an optional identity field, collapsing "" to undefined so
 *  an absent value can never match an accidentally-empty allowlist row. */
function normalizeIdentity(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  return v ? v : undefined;
}

/**
 * @deprecated #35 Phase A — the env `OWNER_ALLOWLIST` check. Superseded by the
 * database Allowlist (`provisionFromProfile`); still wired up only so the OAuth
 * callback keeps compiling until it is rewritten. Deleted with its last caller.
 */
export function isOwner(identity: string, allowlist: string[]): boolean {
  const id = identity.trim().toLowerCase();
  if (!id) return false;
  return allowlist.some((a) => a.trim().toLowerCase() === id);
}

const GITLAB = "https://gitlab.com";

const gitlabProvider: AuthProvider = {
  buildAuthorizeUrl({ redirectUri, state, codeChallenge }) {
    const { clientId } = authConfig();
    const u = new URL(`${GITLAB}/oauth/authorize`);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "read_user");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },
  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const { clientId, clientSecret } = authConfig();
    const res = await fetch(`${GITLAB}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok)
      throw new Error(`GitLab token exchange failed (${res.status})`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  },
  async fetchProfile(accessToken) {
    const res = await fetch(`${GITLAB}/api/v4/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`GitLab user fetch failed (${res.status})`);
    const data = (await res.json()) as {
      id: number;
      username?: string;
      email?: string;
    };
    return {
      subject: String(data.id),
      username: normalizeIdentity(data.username),
      email: normalizeIdentity(data.email),
    };
  },
};

export function getAuthProvider(): AuthProvider {
  const { provider } = authConfig();
  switch (provider) {
    case "gitlab":
      return gitlabProvider;
    default:
      throw new Error(`Unsupported AUTH_PROVIDER: ${provider}`);
  }
}
