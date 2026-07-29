import { chromium } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUserSession, OWNER_COOKIE } from "../src/lib/auth/session";
import { encryptToken } from "../src/lib/crypto/token-cipher";
import {
  SESSION_SECRET,
  OWNER_SUB,
  OWNER_USER_ID,
  OWNER_WS_ID,
  OWNER_HANDLE,
  MEMBER_USER_ID,
  MEMBER_WS_ID,
  MEMBER_HANDLE,
  MEMBER_STORAGE_STATE,
  MEMBER_GOOGLE_ACCESS_TOKEN,
  TOKEN_ENC_KEY,
  STORAGE_STATE,
  BASE_URL,
} from "./constants";

// #118 — the member's Google credential is seeded ENCRYPTED, with the app's own
// cipher and the same key the server under test runs with. A hand-written string
// would decrypt to null, `getGoogleStatus` would answer "reconnect needed", and
// the member specs would quietly assert against the wrong state.
//
// token-cipher reads TOKEN_ENC_KEY from the environment on every call, and this
// is a separate process from the server, so it is set here before the import is
// used. A real environment variable already present is left alone.
if (!process.env.TOKEN_ENC_KEY) process.env.TOKEN_ENC_KEY = TOKEN_ENC_KEY;

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
        handle: OWNER_HANDLE,
        role: "owner",
        status: "active",
        // #35 Phase B: the instance owner is UNCAPPED by design, and the People
        // specs assert the panel says so. Set explicitly rather than left to the
        // schema default (`capped`) — which is exactly the way the live
        // instance's owner ended up capped after the Phase A deploy.
        aiPolicy: "uncapped",
      },
      // Re-assert what the suite depends on: an earlier run (or a spec) may
      // have left the row in another state.
      update: {
        role: "owner",
        status: "active",
        aiPolicy: "uncapped",
        // #100 — the header renders this, so re-assert it: a spec that changed
        // the handle would otherwise leave the next run naming a different
        // account in the bar.
        handle: OWNER_HANDLE,
      },
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

    // #35 Phase B — a second, ordinary account so the People panel has a row
    // that is NOT the owner's: one the owner may revoke, one that shows a capped
    // quota, and one that makes "the owner's row comes first" a real assertion.
    // Re-asserted every run, so a spec that revoked it cannot leak into the next.
    await prisma.user.upsert({
      where: { id: MEMBER_USER_ID },
      create: {
        id: MEMBER_USER_ID,
        provider: "gitlab",
        providerSub: "e2e-member-sub",
        handle: MEMBER_HANDLE,
        role: "member",
        status: "active",
        aiPolicy: "capped",
        aiQuota: 50,
      },
      update: {
        role: "member",
        status: "active",
        aiPolicy: "capped",
        aiQuota: 50,
        // Revocation sets these; clear them so a re-run starts clean.
        revokedAt: null,
        purgeAfter: null,
      },
    });
    await prisma.workspace.upsert({
      where: { id: MEMBER_WS_ID },
      create: {
        id: MEMBER_WS_ID,
        kind: "user",
        userId: MEMBER_USER_ID,
        expiresAt: null,
      },
      update: { kind: "user", userId: MEMBER_USER_ID, expiresAt: null },
    });

    // #118 Phase C — the member's OWN Google credential, keyed on their userId.
    // No refresh token and no expiry: the member specs read status and open
    // controls, they never push, so nothing ever calls Google. An expiry in the
    // past would trigger the refresh path and a real network request; a refresh
    // token would be offered to Google's revoke endpoint on disconnect.
    //
    // Re-asserted every run, so a spec that disconnected cannot leak into the
    // next one. Keyed on `userId` rather than on the row's own generated id —
    // which is the whole point of #118: there is no other handle on this row.
    await prisma.googleAuth.upsert({
      where: { userId: MEMBER_USER_ID },
      create: {
        userId: MEMBER_USER_ID,
        accessToken: encryptToken(MEMBER_GOOGLE_ACCESS_TOKEN),
        refreshToken: null,
        expiresAt: null,
        scope: "https://www.googleapis.com/auth/tasks",
        needsReconnect: false,
      },
      update: {
        accessToken: encryptToken(MEMBER_GOOGLE_ACCESS_TOKEN),
        refreshToken: null,
        expiresAt: null,
        needsReconnect: false,
      },
    });

    // #118 — and no key on the member, so the Account section starts in its
    // "no key stored" state. The member spec saves one and removes it again; this
    // is what stops a failed run leaking a stored key into the next.
    await prisma.user.updateMany({
      where: { id: MEMBER_USER_ID },
      data: { llmKeyEnc: null },
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

  // #118 Phase C — a SECOND storage state: the member, signed in as themselves.
  // The owner's session cannot exercise "a member uses their own connection",
  // which is the entire claim this phase makes.
  const memberToken = await signUserSession(
    { kind: "user", userId: MEMBER_USER_ID, wsId: MEMBER_WS_ID },
    SESSION_SECRET,
  );
  const memberContext = await browser.newContext();
  await memberContext.addCookies([
    {
      name: OWNER_COOKIE, // "df_owner" — the signed-in-account cookie, any role
      value: memberToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    },
  ]);
  await memberContext.storageState({ path: MEMBER_STORAGE_STATE });

  await browser.close();
}
