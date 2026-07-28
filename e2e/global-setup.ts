import { chromium } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUserSession, OWNER_COOKIE } from "../src/lib/auth/session";
import {
  SESSION_SECRET,
  OWNER_SUB,
  OWNER_USER_ID,
  OWNER_WS_ID,
  STORAGE_STATE,
  BASE_URL,
} from "./constants";

// Mint a real, valid signed-in session the same way the OAuth callback does,
// then persist it as Playwright storageState so every spec starts logged in.
// No auth-bypass path is added to application code.
//
// #35 Phase A: the payload changed from { kind: "owner", sub } to
// { kind: "user", userId, wsId }, and the app now RESOLVES that userId against
// the database — currentUser() loads the row to read its role and status.
// Signing the new shape alone is not enough. A token naming a user that does
// not exist verifies happily and then resolves to nobody, so isOwnerRequest()
// would be false, the guest banner would render, and the entire suite would run
// as an unauthenticated visitor while continuing to pass. The account and its
// workspace are therefore seeded here first, idempotently.
export default async function globalSetup(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.user.upsert({
      where: { id: OWNER_USER_ID },
      create: {
        id: OWNER_USER_ID,
        provider: "gitlab",
        providerSub: OWNER_SUB,
        handle: "e2e-owner",
        role: "owner",
        status: "active",
      },
      // Re-assert what the suite depends on: an earlier run (or a spec) may
      // have left the row in another state.
      update: { role: "owner", status: "active" },
    });
    await prisma.workspace.upsert({
      where: { id: OWNER_WS_ID },
      create: {
        id: OWNER_WS_ID,
        kind: "user",
        userId: OWNER_USER_ID,
        // A user workspace never expires; a stray TTL would let the guest
        // purge sweep the suite's fixtures out mid-run.
        expiresAt: null,
      },
      update: { kind: "user", userId: OWNER_USER_ID, expiresAt: null },
    });
  } finally {
    await prisma.$disconnect();
  }

  const token = await signUserSession(
    { kind: "user", userId: OWNER_USER_ID, wsId: OWNER_WS_ID },
    SESSION_SECRET,
  );
  const url = new URL(BASE_URL);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: OWNER_COOKIE, // "df_owner"
      value: token,
      domain: url.hostname, // "localhost"
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    },
  ]);
  await context.storageState({ path: STORAGE_STATE });
  await browser.close();
}
