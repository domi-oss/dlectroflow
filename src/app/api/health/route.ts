import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { shortBuildSha } from "@/lib/build-info";

// Node runtime + always dynamic: this must actually hit the DB each call.
export const dynamic = "force-dynamic";

export async function GET() {
  // #135 — the short build SHA, on both paths. The two instances (Helm on
  // Kubernetes, Docker Compose on one host) can now be ASSERTED to be running
  // the same commit by comparing two curls, rather than assumed to be. It is on
  // the failure path too, because "which build is the one that cannot reach
  // Postgres" is the first question during an incident.
  //
  // The short SHA and nothing else: this route is unauthenticated (it is the
  // readiness probe and the Compose healthcheck), so it publishes the least
  // that answers the question, and src/lib/build-info.ts refuses to echo a
  // value that is not a SHA. `null` when the image was built without the
  // BUILD_SHA build arg — additive, so the existing `{"status":"ok"}` contract
  // that docs/self-host-vps.md and both probes rely on is unchanged.
  const sha = shortBuildSha();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", sha });
  } catch {
    return NextResponse.json({ status: "error", sha }, { status: 503 });
  }
}
