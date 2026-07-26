import { NextResponse } from "next/server";
import { llmFailureCount } from "@/lib/observability";

// Process-only liveness (#21 P4): deliberately NO DB access. The liveness
// probe used to hit /api/health (SELECT 1), so a Postgres blip killed every
// pod and the migrate initContainers turned it into a restart storm. A pod
// that can serve this route is alive; DB readiness belongs to readinessProbe
// (/api/health), which only pulls a pod out of rotation.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const llmFailures = llmFailureCount();
  return NextResponse.json({
    status: "alive",
    llmFailures,
    // Deprecated alias, kept for one release while dashboards/alerts migrate
    // off the Anthropic-only name (#59 generalized the LLM layer).
    anthropicFailures: llmFailures,
  });
}
