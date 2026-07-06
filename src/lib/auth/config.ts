export function authConfig() {
  return {
    provider: process.env.AUTH_PROVIDER ?? "gitlab",
    ownerAllowlist: (process.env.OWNER_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionSecret: process.env.AUTH_SESSION_SECRET ?? "",
    clientId: process.env.GITLAB_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
  };
}

/** In production, fail fast if owner auth is not fully configured. */
export function assertAuthConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const c = authConfig();
  const missing: string[] = [];
  if (!c.sessionSecret || c.sessionSecret.length < 32)
    missing.push("AUTH_SESSION_SECRET (>=32 chars)");
  if (!c.clientId) missing.push("GITLAB_OAUTH_CLIENT_ID");
  if (!c.clientSecret) missing.push("GITLAB_OAUTH_CLIENT_SECRET");
  if (c.ownerAllowlist.length === 0) missing.push("OWNER_ALLOWLIST");
  if (missing.length) {
    throw new Error(
      `Owner auth misconfigured — refusing to boot with data reachable. Missing: ${missing.join(", ")}`,
    );
  }
}
