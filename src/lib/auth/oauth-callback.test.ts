import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GITLAB_OAUTH_CALLBACK_PATH } from "./oauth-callback";

/**
 * The OAuth callback's pathname, asserted against the thing that actually owns
 * it — the App Router file tree (#277).
 *
 * ## Why a constant at all
 *
 * The web app manifest's `scope` has to cover this path, or the provider's
 * redirect opens OUTSIDE the installed app's window and the user ends up signed
 * in **in a browser tab** while the installed app still reads signed-out. That
 * is invisible until somebody signs out, so `src/app/manifest.test.ts` asserts
 * containment — and it needs a path to assert against.
 *
 * Before this file the string was built inline, as a template literal, in two
 * non-exported places (`../../app/api/auth/gitlab/start/route.ts` and the
 * callback route's own token exchange). Nothing was importable, so a test had
 * three bad options: hardcode the string a third time, or read
 * `src/lib/auth/gate.ts` — which carries the PREFIX `/api/auth/`, not this path,
 * so it would keep passing if the route directory moved — or duplicate the
 * literal again.
 *
 * ## Why the constant is not trusted on its own
 *
 * A constant that both the routes and the test read is only as true as somebody
 * remembering to edit it. Move `route.ts` and the constant, the routes and the
 * manifest test all agree with each other and all disagree with the deployed
 * app. So the constant is checked against the DIRECTORY IT NAMES: the assertion
 * below reds if the route file is not where this string says it is, which is the
 * property the spec's TDD step 1 asked for and the reason it warned against
 * deriving the value from `gate.ts`.
 */

const REPO_ROOT = process.cwd();

describe("GITLAB_OAUTH_CALLBACK_PATH (#277)", () => {
  it("is an absolute, relative-to-origin path with no origin baked into it", () => {
    expect(GITLAB_OAUTH_CALLBACK_PATH.startsWith("/")).toBe(true);
    expect(GITLAB_OAUTH_CALLBACK_PATH).not.toMatch(/^https?:/);
    // No trailing slash: it is a route, and `scope` containment below compares
    // string prefixes, where a stray slash changes the answer.
    expect(GITLAB_OAUTH_CALLBACK_PATH.endsWith("/")).toBe(false);
  });

  it("names a route handler that exists on disk, so moving the route reds this", () => {
    const routeFile = path.join(
      REPO_ROOT,
      "src",
      "app",
      ...GITLAB_OAUTH_CALLBACK_PATH.split("/").filter(Boolean),
      "route.ts",
    );
    expect(
      existsSync(routeFile),
      `GITLAB_OAUTH_CALLBACK_PATH is "${GITLAB_OAUTH_CALLBACK_PATH}", which resolves ` +
        `to ${routeFile} — and nothing is there. Either the route moved and this ` +
        `constant did not follow (in which case the manifest's \`scope\` test is now ` +
        `asserting containment of a path the provider never redirects to), or the ` +
        `constant is simply wrong.`,
    ).toBe(true);
  });

  /**
   * The control for the assertion above. A test that only ever checks a path
   * that exists cannot show that it would notice one that does not.
   */
  it("the disk check can fail — a moved route resolves to nothing", () => {
    const moved = "/api/auth/gitlab/callback-moved";
    const routeFile = path.join(
      REPO_ROOT,
      "src",
      "app",
      ...moved.split("/").filter(Boolean),
      "route.ts",
    );
    expect(existsSync(routeFile)).toBe(false);
  });

  /**
   * The other half of the extraction: the two duplicated literals are gone. A
   * source grep rather than a behavioural assertion, because the failure it
   * catches is somebody re-inlining the string while the constant goes on
   * existing and going stale beside it.
   */
  it("is what both OAuth routes build their redirect_uri from", () => {
    const routes = [
      "src/app/api/auth/gitlab/start/route.ts",
      "src/app/api/auth/gitlab/callback/route.ts",
    ];
    for (const file of routes) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(
        source.includes("GITLAB_OAUTH_CALLBACK_PATH"),
        `${file} does not reference GITLAB_OAUTH_CALLBACK_PATH`,
      ).toBe(true);
      expect(
        source.includes("/api/auth/gitlab/callback`"),
        `${file} still builds the callback path as an inline template literal — ` +
          `two spellings of one fact, which is what this constant removed.`,
      ).toBe(false);
    }
  });
});
