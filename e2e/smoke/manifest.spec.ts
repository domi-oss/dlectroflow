import { test, expect } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import manifestSource from "../../src/app/manifest";
import { readPngFacts } from "../../src/lib/png-inspect";

/**
 * The web app manifest, served by the artefact that actually ships (#277).
 *
 * ## Why this exists on top of `src/app/manifest.test.ts`
 *
 * That suite asserts the manifest's VALUES — scope containment, relative URLs,
 * both icon purposes at both sizes, the safe zone — by calling the exported
 * function. It cannot see any of the four ways this feature can ship green and be
 * broken in production, all of which are about SERVING rather than content:
 *
 *  1. **The file is in the wrong directory.** Next's docs say to put the manifest
 *     in "the root of `app`"; this repo's App Router root is `src/app/` and there
 *     is no `app/` at the repo root. A file created there is picked up by
 *     nothing — no manifest emitted, build still green, and the only symptom the
 *     missing install option on a handset.
 *  2. **No `<link rel="manifest">` in the HTML.** Next derives the tag from the
 *     discovered file convention (`mergeStaticMetadata` in
 *     `next/dist/lib/metadata/resolve-metadata.js` copies it onto
 *     `metadata.manifest`, which is what renders the tag). Nothing in this repo
 *     asks for it explicitly, so it is inherited behaviour — exactly the kind of
 *     claim that needs a test rather than a citation. Without the tag the
 *     manifest is a file nothing fetches.
 *  3. **The icons are not in the image.** ⚠️ `.next/standalone` deliberately
 *     OMITS `public/`, and `docker/Dockerfile`'s runtime stage copies **no
 *     `src/`** — it takes `prisma`, `public` and the standalone bundle and
 *     nothing else. The manifest survives that because Next PRERENDERS it to
 *     `.next/server/app/manifest.webmanifest.body` at build time, and the icons
 *     survive it because of the explicit `COPY … /app/public ./public`. Both are
 *     properties of the Dockerfile, not of the code, and neither is visible from
 *     a `next dev` server. `config/playwright.config.ts` assembles the bundle the
 *     way that runtime stage does and boots `node server.js`, so this suite is
 *     the closest a repo test gets to fetching from the image.
 *  4. **The auth gate eats them.** A browser evaluates installability while
 *     SIGNED OUT. `src/app/manifest.test.ts` asserts the paths against the
 *     matcher it imports from `src/proxy.ts`; this asserts the deployed
 *     middleware genuinely lets them through, which is a different claim.
 *
 * ## No storageState
 *
 * The config default is a forged OWNER session, which would make "reachable
 * while signed out" untestable — the same reasoning as `legal-pages.spec.ts`. An
 * EXPLICITLY empty cookie jar, because inheriting one silently is how a spec ends
 * up proving the opposite of its own name (see `member-calendar-feed.spec.ts`).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const MANIFEST_PATH = "/manifest.webmanifest";
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const declared = manifestSource();
const ICON_PATHS = (declared.icons ?? []).map((i) => i.src);

test.describe("the web app manifest is served by the standalone build", () => {
  test("it answers 200 as application/manifest+json with no cookies at all", async ({
    context,
  }) => {
    expect(
      await context.cookies(),
      "this spec must start with no cookies to mean anything",
    ).toEqual([]);

    const res = await context.request.get(MANIFEST_PATH);
    expect(res.status()).toBe(200);
    // The registered media type. A manifest served as text/plain is still parsed
    // by Chrome, but the wrong type is the tell that something is serving the
    // file statically rather than through the metadata route.
    expect(res.headers()["content-type"]).toContain(
      "application/manifest+json",
    );
  });

  test("the served document is byte-for-byte what src/app/manifest.ts returns", async ({
    context,
  }) => {
    // ⚠️ The assertion that closes the gap between the unit suite and reality.
    // Every value `src/app/manifest.test.ts` checks is checked on the FUNCTION;
    // this proves the build did not drop, reorder or re-encode any of it on the
    // way into `.next/server/app/manifest.webmanifest.body`, which is the copy
    // the image actually ships.
    const res = await context.request.get(MANIFEST_PATH);
    expect(JSON.parse(await res.text())).toEqual(
      JSON.parse(JSON.stringify(declared)),
    );
  });

  test("fetching it mints no guest sandbox — the auth gate never runs", async ({
    context,
  }) => {
    // Not a restatement of the 200 above. A guest cookie appearing here would
    // mean `src/proxy.ts` DID run on this path, which is the condition under
    // which a future change to `PUBLIC_PREFIXES` or to the matcher's extension
    // exclusion could start redirecting it — and install would then break
    // silently on a first visit.
    await context.request.get(MANIFEST_PATH);
    const names = (await context.cookies()).map((c) => c.name);
    expect(names).not.toContain("df_guest");
    expect(names).not.toContain("df_owner");
  });

  test("the root page advertises it, so a browser looks for it at all", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    // Not a redirect to /login: that would also render and report 200 after
    // following, and an install prompt never appears on a page a signed-out
    // visitor cannot reach.
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      MANIFEST_PATH,
    );
  });

  test("the sign-in page advertises it too", async ({ page }) => {
    // /login renders outside the (app) group, and it is where a signed-out
    // visitor most plausibly lands from a shared link — so it is the page the
    // install affordance has to appear on.
    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      MANIFEST_PATH,
    );
  });
});

test.describe("every declared icon is really in the built bundle", () => {
  test("the manifest declares four icons, so the cases below are not zero", () => {
    // The guard on the derivation: `ICON_PATHS` comes from the manifest itself,
    // and an empty array would register no cases while this file still reported
    // green.
    expect(ICON_PATHS).toHaveLength(4);
  });

  for (const src of ICON_PATHS) {
    test(`${src} answers 200 with the committed bytes`, async ({ context }) => {
      const res = await context.request.get(src);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");

      // ⚠️ Content, not just status. `.next/standalone` omits `public/`, so a
      // wrong or missing asset COPY in the runtime stage is exactly the class of
      // fault that leaves every HTML route at 200 while every public file 404s.
      // Probed: pointing this at a path the copy would not have brought reds all
      // four cases on `Expected: 200, Received: 404`.
      const served = await res.body();
      const onDisk = statSync(
        path.join(PUBLIC_DIR, src.replace(/^\//, "")),
      ).size;
      expect(served.length).toBe(onDisk);

      // ⚠️ The length comparison alone is SELF-REFERENTIAL — truncate the
      // committed file and both sides shrink together, so it goes green. That is
      // a real hole and it was found by probing rather than reasoned about. The
      // served bytes are therefore parsed and measured against what the manifest
      // DECLARES, which is a fact the file on disk cannot move.
      const facts = readPngFacts(served);
      expect(`${facts.width}x${facts.height}`).toBe(
        declared.icons!.find((i) => i.src === src)!.sizes,
      );
    });

    test(`${src} mints no guest sandbox`, async ({ context }) => {
      await context.request.get(src);
      expect((await context.cookies()).map((c) => c.name)).not.toContain(
        "df_guest",
      );
    });
  }
});

test.describe("the Apple touch icon's served path (#254)", () => {
  /**
   * ⚠️ Pinned because this exact fact has been misread twice, in opposite
   * directions, in two artefacts that are still on `main`.
   *
   * `docs/design/specs/2026-08-12-mobile-manifest-design.md` states that Next
   * serves the `app/**` convention at an **extensionless** `/apple-icon?<hash>`,
   * and builds two conclusions on it: that the path reaches `src/proxy.ts`'s
   * matcher, and that a rival file at `public/apple-icon.png` "would be served at
   * a URL nothing links to". #254's own description carries a correction dated
   * 2026-08-14 saying the emitted href is `/apple-icon.png?…` and that
   * `/apple-icon` 404s — which makes the two candidates collide on ONE pathname
   * and turns it into a route-precedence question instead.
   *
   * The correction is the one that matches this build. Asserted rather than
   * restated, so the next person to plan work here reads a test result instead of
   * choosing between two documents. The instruction both agree on is unchanged:
   * replace the `app/**` convention file, never add a second icon under `public/`.
   */
  test("the emitted href carries a .png extension, and the extensionless path 404s", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    const href = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    expect(href, "no apple-touch-icon link in the served HTML").toBeTruthy();
    expect(new URL(href!, "http://x").pathname).toMatch(/\.png$/);

    // The half that makes the spec's inference wrong rather than merely imprecise.
    expect((await context.request.get("/apple-icon")).status()).toBe(404);
  });

  test("the served Apple icon is the committed file", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    const href = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    const res = await context.request.get(href!);
    expect(res.status()).toBe(200);
    expect((await res.body()).length).toBe(
      readFileSync(
        path.join(__dirname, "..", "..", "src", "app", "apple-icon.png"),
      ).length,
    );
  });
});
