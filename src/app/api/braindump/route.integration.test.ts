/**
 * #175 — `POST /api/braindump` against real Postgres.
 *
 * `route.test.ts` decides the route's own logic with `writeCapture` and the
 * workspace resolver mocked. Five of this feature's promises cannot be shown that
 * way, because they are facts about the DATABASE and about the SEAM between the
 * route, the resolver and the unique index — and the seam is where #220's bug
 * lived while every function on either side of it was correct:
 *
 *  1. the same `clientKey` twice yields **one** row
 *  2. a workspace mismatch yields 409 **and no row**
 *  3. a frozen account yields 403 **and no row**
 *  4. a guest sandbox captures normally
 *  5. a capture arriving on the hostname production serves **without a redirect**
 *     yields a row, and a forged `Origin` on that same hostname does not (#175)
 *
 * So nothing below `next/headers` is mocked: real session signing, the real
 * resolver, the real Prisma client, a real `freezeAccount`, and the real index.
 * The only stubs are the two request-context APIs that have no meaning outside a
 * Next.js request, plus `revalidatePath` for the same reason.
 *
 * Isolation follows `src/lib/__tests__/revoked-account.integration.test.ts`: a
 * dedicated PrismaClient for setup and teardown, so this file's own queries can
 * never interfere with the `@/lib/db` singleton the route uses, and ids unique to
 * this file, wiped either side.
 *
 * Needs the real Postgres. CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally a bare `npm test` is enough, because
 * `config/vitest.config.ts` reads DATABASE_URL out of `.env` for exactly this
 * (#84) and forwards ONLY that one variable, so no test can reach a secret it
 * was not given.
 *
 * ⚠️ So do NOT run `set -a; . ./.env; set +a; npm test`. It was in this docblock,
 * it is unnecessary, and it hands the whole env file — API keys and
 * TOKEN_ENC_KEY included — to every test in the run, which is the one thing that
 * config went out of its way to prevent.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { PrismaClient } from "@prisma/client";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

const { cookiesMock, headersMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  headersMock: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock, headers: headersMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { freezeAccount } from "@/lib/account-lifecycle";
import {
  GUEST_COOKIE,
  OWNER_COOKIE,
  signGuestSession,
  signUserSession,
} from "@/lib/auth/session";
import { UserStatus, WorkspaceKind } from "@/lib/constants";
import { POST } from "./route";

// Dedicated client, not the `@/lib/db` singleton the route under test uses.
const prisma = new PrismaClient();

/** Ids unique to this file, so a parallel suite can never collide with it. */
const USER_ID = "test-175-route-user";
const WS_ID = "test-175-route-ws";
const GUEST_WS_ID = "test-175-route-guest-ws";
const PROVIDER_SUB = "test-175-route-subject";

async function wipe() {
  const workspaceId = { in: [WS_ID, GUEST_WS_ID] };
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId } });
  // Settings and Streak are created on first use by the streak touch a written
  // capture performs, and both cascade from Workspace — so the workspace delete
  // takes them, and nothing here has to know the list.
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

/** A signed session, plus the `delete` a Route Handler's jar exposes (#220). */
function jarWith(cookie: string, token: string) {
  return {
    get: (name: string) => (name === cookie ? { value: token } : undefined),
    delete: vi.fn(),
  };
}

const post = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  POST(
    new Request("http://localhost/api/braindump", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

/** Rows carrying a given key, whatever workspace they landed in. */
const rowsWithKey = (clientKey: string) =>
  prisma.brainDumpItem.findMany({
    where: { clientKey },
    select: { text: true, notes: true, workspaceId: true },
  });

describe("POST /api/braindump (real Postgres)", () => {
  /** The cookie the browser holds, signed while the account was live. */
  let ownerToken: string;

  beforeAll(async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    ownerToken = await signUserSession(
      { kind: "user", userId: USER_ID, wsId: WS_ID },
      SECRET,
    );
    headersMock.mockResolvedValue(new Headers());
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await wipe();
    await prisma.$disconnect();
  });

  /**
   * A full teardown and rebuild per case, not a per-case repair — the shape
   * `revoked-account.integration.test.ts` settled on after !305's review. One case
   * here freezes the shared account and another writes rows to it, so "who puts it
   * back" is answered once, here, rather than by each case remembering.
   */
  beforeEach(async () => {
    cookiesMock.mockResolvedValue(jarWith(OWNER_COOKIE, ownerToken));
    await wipe();
    await prisma.user.create({
      data: {
        id: USER_ID,
        provider: "gitlab",
        providerSub: PROVIDER_SUB,
        handle: "capture-person",
        status: UserStatus.Active,
        workspace: { create: { id: WS_ID, kind: WorkspaceKind.User } },
      },
    });
  });

  // The control. Without it every refusal below could just as easily mean the
  // fixture never worked — the unproven zero this repo guards against everywhere.
  it("writes the capture and answers 201", async () => {
    const res = await post({
      clientKey: "key-control",
      text: "buy milk",
      workspaceId: WS_ID,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "saved" });
    expect(await rowsWithKey("key-control")).toEqual([
      { text: "buy milk", notes: null, workspaceId: WS_ID },
    ]);
  });

  /**
   * ⚠️ The #175 multi-host regression, proved where it can only be proved: a real
   * row, from a real session, for a capture arriving on the hostname production
   * serves WITHOUT a redirect.
   *
   * `route.test.ts` pins the same case with `writeCapture` mocked, so it can show
   * the route decided to write; only this file can show the row exists. It earns
   * the round trip because the first implementation of the CSRF guard compared
   * against `PUBLIC_ORIGIN` and answered `400` here — which the client maps to
   * "retryable", so the capture was never lost and never saved, and nothing
   * anywhere reported it.
   *
   * `PUBLIC_ORIGIN` is stubbed to the OTHER served hostname deliberately: unset is
   * the one configuration in which the wrong comparand accidentally behaves, so
   * without this stub the case cannot fail.
   */
  it("writes a capture that arrived on a served non-canonical host (#175)", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://work.dlectroflow.dev");

    const res = await post(
      { clientKey: "key-apex", text: "typed on the apex", workspaceId: WS_ID },
      {
        origin: "https://dlectroflow.dev",
        "x-forwarded-host": "dlectroflow.dev",
        "x-forwarded-proto": "https",
      },
    );

    expect(res.status).toBe(201);
    expect(await rowsWithKey("key-apex")).toEqual([
      { text: "typed on the apex", notes: null, workspaceId: WS_ID },
    ]);
  });

  /**
   * And the control on the same seam, so the case above cannot be satisfied by a
   * guard that stopped guarding. A forged `Origin` against the victim's host is
   * refused, and refused BEFORE the session — so no row, in either workspace.
   */
  it("refuses a forged Origin and writes no row (#175, CWE-352)", async () => {
    const res = await post(
      {
        clientKey: "key-forged",
        text: "not the user's words",
        workspaceId: WS_ID,
      },
      {
        origin: "https://evil.example",
        "x-forwarded-host": "dlectroflow.dev",
        "x-forwarded-proto": "https",
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request origin not allowed" });
    expect(await rowsWithKey("key-forged")).toEqual([]);
  });

  it("splits the inline note into the real columns, end to end (#179)", async () => {
    // The seam, not the parser: `braindump-note-syntax.test.ts` covers the rule,
    // and this covers that the route reaches it and that both values survive a
    // round trip through the CHECK-constrained column.
    await post({
      clientKey: "key-note",
      text: "water the plants {can under sink}",
      workspaceId: WS_ID,
    });
    expect(await rowsWithKey("key-note")).toEqual([
      {
        text: "water the plants",
        notes: "can under sink",
        workspaceId: WS_ID,
      },
    ]);
  });

  it("answers 201 then 200 for the same clientKey, and leaves ONE row", async () => {
    // The reason the column exists. `withActionTimeout` bounds how long the UI
    // waits, not how long the request runs, so a capture that timed out at 10s and
    // landed at 14s is replayed by the next flush. Without the key that flush
    // would insert a second row of the same thought, every time.
    const body = {
      clientKey: "key-replayed",
      text: "ring the dentist",
      workspaceId: WS_ID,
    };

    expect((await post(body)).status).toBe(201);
    const replay = await post(body);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "duplicate" });
    expect(await rowsWithKey("key-replayed")).toHaveLength(1);
  });

  it("keeps the FIRST text when a replay carries different words", async () => {
    // `ON CONFLICT DO NOTHING`, so the row is not rewritten. The words already
    // promised to the user are the ones worth keeping — the same rule `enqueue`
    // applies when a `clientKey` is re-enqueued.
    await post({
      clientKey: "key-first-wins",
      text: "the words the user was told were saved",
      workspaceId: WS_ID,
    });
    await post({
      clientKey: "key-first-wins",
      text: "something else entirely",
      workspaceId: WS_ID,
    });

    expect(await rowsWithKey("key-first-wins")).toEqual([
      {
        text: "the words the user was told were saved",
        notes: null,
        workspaceId: WS_ID,
      },
    ]);
  });

  it("leaves ONE row when two flushes of the same capture overlap", async () => {
    // Two presses of Retry, or a flush racing the foreground write. Neither
    // request may raise: `INSERT … ON CONFLICT DO NOTHING` means the loser inserts
    // nothing and is told so, rather than raising a P2002 that Prisma's client
    // logger would print as an incident before any catch saw it (#156, #158).
    const body = {
      clientKey: "key-overlapping",
      text: "buy milk",
      workspaceId: WS_ID,
    };

    const [a, b] = await Promise.all([post(body), post(body)]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await rowsWithKey("key-overlapping")).toHaveLength(1);
  });

  it("answers 409 and writes NOTHING when the declared workspace is not the resolved one", async () => {
    // The expired-cookie hole, as the queue actually reaches it: a capture made as
    // the owner, flushed once the session has moved on. It must refuse — landing
    // it under the resolved workspace would put the person's words somewhere they
    // will never look again.
    const res = await post({
      clientKey: "key-mismatch",
      text: "a capture from another session",
      workspaceId: "test-175-route-somebody-else",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "session-expired" });
    // Nowhere, not merely "not in the declared workspace": the check must not have
    // written it under the resolved one either.
    expect(await rowsWithKey("key-mismatch")).toEqual([]);
    expect(
      await prisma.brainDumpItem.count({ where: { workspaceId: WS_ID } }),
    ).toBe(0);
  });

  it("answers 403 and writes NOTHING once the account is frozen", async () => {
    // The real thing, not a hand-written UPDATE: this is what `revokePerson`
    // calls, so the promise under test is the one `freezeAccount` makes.
    expect(await freezeAccount(USER_ID)).toBe(true);

    const res = await post({
      clientKey: "key-frozen",
      text: "a write a frozen account must not get",
      workspaceId: WS_ID,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: "account-revoked" });
    expect(await rowsWithKey("key-frozen")).toEqual([]);
  });

  it("signs the frozen account out rather than only refusing it (#220)", async () => {
    // A Route Handler's cookie jar is writable — this is the path #220 names as
    // the one that matters, because it is what a still-open tab and a flushing
    // queue keep hitting. The next request arrives as an ordinary guest instead of
    // failing forever behind a cookie with 30 days left on it.
    const jar = jarWith(OWNER_COOKIE, ownerToken);
    cookiesMock.mockResolvedValue(jar);
    await freezeAccount(USER_ID);

    expect(
      (
        await post({
          clientKey: "key-frozen-signout",
          text: "nope",
          workspaceId: WS_ID,
        })
      ).status,
    ).toBe(403);
    expect(jar.delete).toHaveBeenCalledWith(OWNER_COOKIE);
  });

  it("lets a guest sandbox capture normally", async () => {
    // A guest workspace is a real workspace with a TTL, not a special case to
    // branch on — and #175's whole point is that words typed offline are not lost,
    // which is at least as true in a sandbox.
    const guestToken = await signGuestSession(GUEST_WS_ID, SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(GUEST_COOKIE, guestToken));

    const res = await post({
      clientKey: "key-guest",
      text: "a guest capture",
      workspaceId: GUEST_WS_ID,
    });

    expect(res.status).toBe(201);
    expect(await rowsWithKey("key-guest")).toEqual([
      { text: "a guest capture", notes: null, workspaceId: GUEST_WS_ID },
    ]);
  });

  it("treats the same clientKey in two workspaces as two different captures", async () => {
    // The index is per-workspace, not global, and this is the behavioural half of
    // that tenancy decision: the key is minted in the browser, so two tenants can
    // legitimately hold the same string, and a global index would both refuse the
    // second write and tell one workspace that the other holds that key.
    const shared = "key-shared-across-tenants";
    expect(
      (await post({ clientKey: shared, text: "mine", workspaceId: WS_ID }))
        .status,
    ).toBe(201);

    const guestToken = await signGuestSession(GUEST_WS_ID, SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(GUEST_COOKIE, guestToken));
    expect(
      (
        await post({
          clientKey: shared,
          text: "theirs",
          workspaceId: GUEST_WS_ID,
        })
      ).status,
    ).toBe(201);

    expect(
      (await rowsWithKey(shared)).map((r) => r.workspaceId).sort(),
    ).toEqual([GUEST_WS_ID, WS_ID].sort());
  });
});
