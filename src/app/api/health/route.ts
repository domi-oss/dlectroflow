import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Node runtime + always dynamic: this must actually hit the DB each call.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
