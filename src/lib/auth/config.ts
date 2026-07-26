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
  if (
    !process.env.GUEST_IP_HASH_SALT ||
    process.env.GUEST_IP_HASH_SALT.length < 16
  )
    missing.push("GUEST_IP_HASH_SALT (>=16 chars)");
  const encKey = process.env.TOKEN_ENC_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(encKey))
    missing.push("TOKEN_ENC_KEY (64 hex chars)");
  if (missing.length) {
    throw new Error(
      `Owner auth misconfigured — refusing to boot with data reachable. Missing: ${missing.join(", ")}`,
    );
  }
  assertLLMConfig();
}

/**
 * In production, fail fast if the selected LLM provider is not fully
 * configured. Provider selection is env-only (`LLM_PROVIDER`, default
 * `anthropic`); each provider has its own required keys.
 */
export function assertLLMConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  const missing: string[] = [];
  if (provider === "openai-compatible") {
    // New provider, no lazy precedent: a missing base URL/model is a deploy
    // misconfig the app can't function with at all, so fail fast at boot.
    if (!process.env.LLM_BASE_URL) missing.push("LLM_BASE_URL");
    if (!process.env.LLM_MODEL) missing.push("LLM_MODEL");
  } else if (!process.env.ANTHROPIC_API_KEY) {
    // anthropic (the default) — also the fallback for any unknown value,
    // which getLLM() resolves to anthropic. The API key is a secret, not
    // structural config, and pre-#59 it was intentionally lazy (see
    // src/lib/anthropic.ts) so a missing key doesn't blow up `next build`
    // or CI's keyless boot. Don't hard-fail here: the anthropic adapter
    // already throws a descriptive LLMError("auth", …) at first request
    // when the key is absent (src/lib/llm/anthropic.ts), same as before #59.
    console.warn(
      'LLM provider "anthropic" has no ANTHROPIC_API_KEY set — AI features will fail at first use.',
    );
  }
  if (missing.length) {
    throw new Error(
      `LLM provider "${provider}" misconfigured — refusing to boot. Missing: ${missing.join(", ")}`,
    );
  }
}
