import { NextResponse } from "next/server";
import { OWNER_COOKIE } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const res = NextResponse.redirect(`${requestOrigin(req)}/inbox`);
  res.cookies.delete(OWNER_COOKIE);
  return res;
}
