// Next.js calls register() once when a new server instance is initiated,
// before the server handles any requests. This wires assertAuthConfig() so
// a production deploy with missing auth secrets refuses to boot.
//
// The NEXT_PHASE guard is required: next build runs with NODE_ENV=production
// and the build environment does NOT have auth secrets set. Without the guard,
// assertAuthConfig() would throw and break the build.
// Source confirmed in next/dist/server/web/globals.js: Next.js itself uses
// this same guard to skip instrumentation during the production build phase.

export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { assertAuthConfig } = await import("@/lib/auth/config");
  assertAuthConfig();
}
