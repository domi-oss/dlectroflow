import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import {
  verifySession,
  OWNER_COOKIE,
  GUEST_COOKIE,
  GUEST_WS_HEADER,
} from "@/lib/auth/session";
import { authConfig } from "@/lib/auth/config";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export class MissingWorkspaceError extends Error {
  constructor() {
    super("No workspace context on request");
    this.name = "MissingWorkspaceError";
  }
}

export async function resolveWorkspaceId(input: {
  owner?: string;
  guest?: string;
  header?: string;
}): Promise<string> {
  const { sessionSecret } = authConfig();
  if (input.owner) {
    const p = await verifySession(input.owner, sessionSecret);
    if (p?.kind === "owner") return OWNER_WORKSPACE_ID;
  }
  if (input.guest) {
    const p = await verifySession(input.guest, sessionSecret);
    if (p?.kind === "guest") return p.wsId;
  }
  if (input.header) return input.header;
  throw new MissingWorkspaceError();
}

export async function touchWorkspace(id: string): Promise<void> {
  const kind = id === OWNER_WORKSPACE_ID ? "owner" : "guest";
  await prisma.workspace.upsert({
    where: { id },
    create: { id, kind, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });
}

export async function currentWorkspaceId(): Promise<string> {
  const jar = await cookies();
  const hdrs = await headers();
  const id = await resolveWorkspaceId({
    owner: jar.get(OWNER_COOKIE)?.value,
    guest: jar.get(GUEST_COOKIE)?.value,
    header: hdrs.get(GUEST_WS_HEADER) ?? undefined,
  });
  await touchWorkspace(id);
  return id;
}

export async function isOwnerRequest(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (!token) return false;
  const p = await verifySession(token, authConfig().sessionSecret);
  return p?.kind === "owner";
}
