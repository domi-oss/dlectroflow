export const PUBLIC_PREFIXES = ["/api/health", "/login", "/api/auth/"];

// Integration connect/callback routes touch the owner's global Google/Reclaim
// tokens — guests must never reach them.
export const OWNER_ONLY_PREFIXES = [
  "/api/google/oauth/",
  "/api/reclaim/oauth/",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  );
}

export function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PREFIXES.some((p) => pathname.startsWith(p));
}
