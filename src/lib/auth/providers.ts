import { authConfig } from "./config";

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
  /** Returns a stable identity string (e.g. GitLab numeric id). */
  fetchIdentity(accessToken: string): Promise<string>;
}

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
    if (!res.ok) throw new Error(`GitLab token exchange failed (${res.status})`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  },
  async fetchIdentity(accessToken) {
    const res = await fetch(`${GITLAB}/api/v4/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`GitLab user fetch failed (${res.status})`);
    const data = (await res.json()) as { id: number };
    return String(data.id);
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
