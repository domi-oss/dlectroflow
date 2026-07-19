import crypto from "node:crypto";

// Provider-agnostic OAuth 2.0 PKCE + state helpers. Used by the Google Tasks
// and GitLab sign-in OAuth flows (formerly also the removed Reclaim flow).

export function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function randomState() {
  return crypto.randomBytes(16).toString("base64url");
}
