import { NextResponse } from "next/server";
import { anthropicFailureCount } from "@/lib/observability";

// Process-only liveness (#21 P4): deliberately NO DB access. The liveness
// probe used to hit /api/health (SELECT 1), so a Postgres blip killed every
// pod and the migrate initContainers turned it into a restart storm. A pod
// that can serve this route is alive; DB readiness belongs to readinessProbe
// (/api/health), which only pulls a pod out of rotation.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "alive",
    anthropicFailures: anthropicFailureCount(),
  });
}
