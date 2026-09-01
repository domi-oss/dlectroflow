import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { GITLAB_OAUTH_CALLBACK_PATH } from "@/lib/auth/oauth-callback";
import { readPngFacts, readPngPixels } from "@/lib/png-inspect";
import { config as proxyConfig } from "@/proxy";
import manifest from "./manifest";

/**
 * The web app manifest — #277, against
 * `docs/design/specs/2026-08-12-mobile-manifest-design.md`.
 *
 * Every `describe` below is one of that spec's five TDD steps, in its order, plus
 * the icon-geometry guard the spec measured once by hand and this converts into a
 * standing check.
 *
 * ## What makes this worth testing at all
 *
 * A manifest fails **silently**. There is no build error, no console warning and
 * no failing request — the only symptom of every mistake in this file is "the
 * install option didn't appear on my phone", or worse, an app that installs and
 * signs the user out of itself. The whole point of generating it from `.ts` is
 * that `MetadataRoute.Manifest` catches the shape; these tests catch the values.
 */

const REPO_ROOT = process.cwd();
const PUBLIC_DIR = path.join(REPO_ROOT, "public");
const m = manifest();

/**
 * Is `pathname` inside `scope`?
 *
 * ⚠️ A **plain string prefix**, and that is the algorithm rather than a
 * simplification of it. The Web App Manifest spec's *within scope* steps are:
 * same origin, then *"Return a boolean indicating whether targetPath starts with
 * scopePath"* — with a note spelling out the consequence: *"The URL string
 * matching in this algorithm is prefix-based rather than path-structural (e.g. a
 * target URL string `/prefix-of/resource.html` will match an app with scope
 * `/prefix`)."*
 *
 * ⚠️ The first version of this helper truncated a scope at its last `/` before
 * comparing, on a recalled rule that does not exist. It agreed with the real
 * algorithm on every value this repo uses, so nothing caught it — checked
 * against the spec text rather than reasoned about. The trailing-slash case
 * below is what the difference looks like, and it is a real footgun: a scope of
 * `/app` admits `/application`.
 *
 * Written out rather than string-compared because the design spec's TDD step 1
 * says so in as many words: *"Assert containment, not string equality."* An
 * equality assertion on `scope === "/"` would go green for a manifest whose scope
 * happened to be `"/"` while saying nothing about the property that matters, so
 * it would keep passing if somebody narrowed the scope "for tidiness".
 */
function isWithinScope(scope: string, pathname: string): boolean {
  return pathname.startsWith(scope);
}

/**
 * Every `process.env` property access in a TypeScript source, found by PARSING.
 *
 * ⚠️ This started as a regex over comment-stripped source, which was wrong twice.
 * It duplicated `stripComments` from `src/lib/source-text.ts` — the module that
 * exists for exactly this step — and it inherited that helper's documented
 * text-level limitation: a `//` inside a string literal reads as the start of a
 * comment, so the rest of the line disappears. `source-text.ts` states the trade
 * plainly and says which callers may take it: the failure direction is "a scanner
 * missing a real occurrence", which is fine when a miss costs nothing.
 *
 * **This caller cannot take that trade**, and that is why it parses instead. A
 * miss here is a **false pass** on the one guard standing between a build-cached
 * route and a runtime variable baked in empty — the failure this whole file
 * exists to prevent. `source-text.ts` names the remedy in as many words:
 * *"Callers that cannot accept that trade should parse, as the AST-based scanners
 * do."* `src/lib/fetch-host-hygiene.ts` and `src/lib/git-env-hygiene.ts` are
 * those scanners, and `typescript` is a declared devDependency, so this is the
 * repo's existing idiom rather than a new dependency.
 *
 * A parser sees neither comments nor string contents as code, so both holes close
 * at once. (Duo review, `!397`.)
 */
function processEnvAccesses(source: string, fileName: string): string[] {
  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    // `process.env` however it is spelled downstream: `process.env.X`,
    // `process.env["X"]`, or a bare `process.env` handed to something else.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      found.push(`${fileName}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(tree, visit);
  return found;
}

describe("isWithinScope: the containment helper can fail (#277)", () => {
  it("puts everything inside a scope of /", () => {
    expect(isWithinScope("/", "/api/auth/gitlab/callback")).toBe(true);
    expect(isWithinScope("/", "/")).toBe(true);
  });

  it("puts the OAuth callback OUTSIDE a narrowed scope — the failure this guards", () => {
    expect(isWithinScope("/app/", "/api/auth/gitlab/callback")).toBe(false);
    expect(isWithinScope("/inbox/", "/api/auth/gitlab/callback")).toBe(false);
  });

  it("is prefix-based, not path-structural — the trailing slash is load-bearing", () => {
    // Straight out of the spec's own note. A scope missing its trailing slash
    // admits a SIBLING path, which is why `scope` is never written without one.
    expect(isWithinScope("/app", "/application")).toBe(true);
    expect(isWithinScope("/app/", "/application")).toBe(false);
    expect(isWithinScope("/app/", "/app/x")).toBe(true);
  });
});

/**
 * ── Spec TDD step 1 ─────────────────────────────────────────────────────────
 */
describe("scope covers the OAuth callback (#277)", () => {
  /**
   * ⚠️ THE assertion in this file. If `scope` does not cover
   * `/api/auth/gitlab/callback`, the provider's redirect opens **outside** the
   * installed app's window: the user is signed in in a browser tab while the
   * installed app still reads signed-out, with no way to tell from inside the
   * app what happened. Nothing surfaces it until somebody signs out, which on a
   * single-user app can be months.
   *
   * The path comes from `@/lib/auth/oauth-callback`, whose own test checks that
   * string against the route directory it names — so a moved route reds there
   * rather than leaving this assertion quietly asserting containment of a path
   * the provider never visits. The spec explicitly warns against the tempting
   * alternative of reading `/api/auth/` out of `src/lib/auth/gate.ts`: that is a
   * PREFIX, and it would not change if the route moved.
   */
  it("contains the GitLab OAuth callback path", () => {
    expect(m.scope).toBeDefined();
    expect(
      isWithinScope(m.scope!, GITLAB_OAUTH_CALLBACK_PATH),
      `manifest scope "${m.scope}" does not contain "${GITLAB_OAUTH_CALLBACK_PATH}". ` +
        `The OAuth callback would open outside the installed app's window, leaving ` +
        `the user signed in in a browser tab while the app still reads signed-out.`,
    ).toBe(true);
  });

  it("contains start_url, or the app launches straight out of its own scope", () => {
    expect(isWithinScope(m.scope!, m.start_url!)).toBe(true);
  });
});

/**
 * ── Spec TDD step 2 ─────────────────────────────────────────────────────────
 */
describe("start_url and scope are RELATIVE (#277)", () => {
  /**
   * ⚠️ Do not "improve" these to absolute URLs on `PUBLIC_ORIGIN`.
   *
   * #254's description and #175's spec both proposed exactly that, on the
   * reasoning that an installed app would then always launch on the canonical
   * origin and so could not reproduce #174. **It ships broken.**
   * `src/app/manifest.ts` is a Route Handler that Next caches by default unless
   * it uses a request-time API, and `PUBLIC_ORIGIN` is a **runtime** variable
   * (set in `charts/dlectroflow/templates/deployment.yaml`, read at request time
   * by `src/lib/origin.ts`). Reading it at module scope bakes in whatever the
   * BUILD container had — nothing — producing a missing or wrong `start_url`,
   * with a green build and green tests. Opting the route out of caching to read
   * it at request time would make every manifest fetch dynamic to recover a
   * value that cannot vary within a deployment.
   *
   * A relative URL in a manifest resolves against the manifest's own URL, so an
   * app installed from `dlectroflow.dev` launches on `dlectroflow.dev` with no
   * env coupling at all. The #174 hardening is not lost: `canonicalOriginRedirect`
   * still pins the sign-in paths, which is where host-only cookies live.
   */
  it("start_url is a root-relative path, not an absolute URL", () => {
    expect(m.start_url).toBe("/");
    expect(m.start_url).not.toMatch(/^https?:/);
  });

  it("scope is a root-relative path, not an absolute URL", () => {
    expect(m.scope).toBe("/");
    expect(m.scope).not.toMatch(/^https?:/);
  });

  it("no manifest value carries an origin", () => {
    // Belt and braces across the whole document rather than the two fields
    // above, because `shortcuts[].url` and `icons[].src` have the same trap.
    expect(JSON.stringify(m)).not.toMatch(/https?:\/\//);
  });

  /**
   * ⚠️ Parsed, not grepped. `manifest.ts` EXPLAINS at length why it must not read
   * a runtime variable, so the phrase is all over the file — a plain source grep
   * reds on the documentation that exists to prevent the defect. This repo has
   * paid for that class of mistake twice (`manifest-hygiene` #76, `env-drift`
   * #146), which is why `src/lib/source-text.ts` exists at all.
   */
  it("does not read process.env — the route is build-cached, so a runtime value bakes in", () => {
    const source = readFileSync(path.join(__dirname, "manifest.ts"), "utf8");
    const accesses = processEnvAccesses(source, "src/app/manifest.ts");
    expect(
      accesses,
      `src/app/manifest.ts reads process.env at ${accesses.join(", ")}. This route ` +
        `is a Route Handler that Next CACHES by default, so a runtime variable is ` +
        `read once in the build container — where it is unset — and baked in. The ` +
        `symptom is a missing or wrong start_url with a green build and green tests.`,
    ).toEqual([]);
  });

  /**
   * ⚠️ THE control, and it is doing three jobs. It shows the walker finds a real
   * access at all; it shows the same walker is NOT fooled by the phrase appearing
   * in a line comment, a block comment or a string; and the fourth line is the
   * case that made a regex the wrong tool — a `//` inside a string literal, which
   * a text-level stripper treats as the start of a comment and so deletes the
   * real access sitting after it on the same line.
   */
  it("CONTROL: the walker finds real accesses and ignores comments and strings", () => {
    const sample = [
      "// a line comment mentioning process.env",
      "/* a block comment mentioning process.env",
      "   over two lines */",
      'const doc = "see https://x/y // process.env.NOPE"; const a = process.env.ONE;',
      'const b = process.env["TWO"];',
      "const plain = 'process.env.ALSO_NOPE';",
    ].join("\n");
    const found = processEnvAccesses(sample, "sample.ts");
    // Lines 4 and 5 (1-based) only: the two real accesses.
    expect(found).toEqual(["sample.ts:4", "sample.ts:5"]);
  });

  it("CONTROL: the walker returns nothing for a file that genuinely has none", () => {
    expect(processEnvAccesses("export const a = 1;\n", "empty.ts")).toEqual([]);
  });
});

/**
 * ── Spec TDD step 3 ─────────────────────────────────────────────────────────
 */
describe("both icon purposes are declared, at both sizes (#277)", () => {
  const icons = m.icons ?? [];

  /**
   * Both are needed and neither substitutes for the other. Android crops a
   * maskable icon to a shape, so transparency renders as a visible GAP — the
   * transparent source is wrong there. Conversely the opaque source used for
   * `purpose: "any"` puts a DARK SQUARE in every browser tab and desktop install.
   */
  for (const size of [192, 512]) {
    for (const purpose of ["any", "maskable"] as const) {
      it(`declares exactly one ${size}x${size} icon with purpose "${purpose}"`, () => {
        const matches = icons.filter(
          (i) => i.sizes === `${size}x${size}` && i.purpose === purpose,
        );
        expect(matches).toHaveLength(1);
        expect(matches[0].type).toBe("image/png");
      });
    }
  }

  it("declares no icon without an explicit purpose", () => {
    // An icon with no `purpose` defaults to "any". Leaving it implicit is how a
    // maskable icon ends up serving both roles and showing a dark square in the
    // browser tab.
    expect(icons.filter((i) => !i.purpose)).toEqual([]);
  });

  it("names four icons and no more", () => {
    expect(icons).toHaveLength(4);
  });

  /**
   * A manifest naming an absent icon is valid JSON, and there is no build error,
   * no console warning and no failing request to say so. Chrome's installability
   * check needs a FETCHABLE icon of at least 144px, so a set that 404s takes the
   * install option away with nothing on screen explaining it. Asserting the file
   * is on disk is the cheapest place to catch a typo in an `src`;
   * `e2e/smoke/manifest.spec.ts` is where it is caught for real, against the
   * built server.
   */
  it("every declared src exists in public/ and is the size it claims", () => {
    for (const icon of icons) {
      const file = path.join(PUBLIC_DIR, icon.src.replace(/^\//, ""));
      expect(
        existsSync(file),
        `${icon.src} is declared and absent from public/`,
      ).toBe(true);
      const facts = readPngFacts(readFileSync(file));
      expect(
        `${facts.width}x${facts.height}`,
        `${icon.src} declares sizes "${icon.sizes}" and is ${facts.width}x${facts.height}`,
      ).toBe(icon.sizes);
    }
  });

  it("every declared src is root-relative, so it resolves under any hostname", () => {
    for (const icon of icons) {
      expect(icon.src.startsWith("/")).toBe(true);
    }
  });
});

/**
 * ── Spec TDD step 4 ─────────────────────────────────────────────────────────
 */
describe("display and shortcuts (#277)", () => {
  it('display is "standalone" — the whole point of the issue', () => {
    // Anything else and the app opens with browser chrome, which is the ~100px of
    // phone vertical space this work is reclaiming.
    expect(m.display).toBe("standalone");
  });

  it("declares exactly one shortcut, with a name and a url", () => {
    expect(m.shortcuts).toHaveLength(1);
    expect(m.shortcuts![0].name).toBeTruthy();
    expect(m.shortcuts![0].url).toBeTruthy();
  });

  it("the shortcut's url is within scope", () => {
    // A shortcut outside scope opens in a browser tab instead of the app — the
    // same failure as the OAuth callback, reached from the long-press menu.
    expect(isWithinScope(m.scope!, m.shortcuts![0].url)).toBe(true);
  });

  it("the shortcut lands on the capture field", () => {
    // The inbox renders at the bare root and its capture input carries
    // `autoFocus` (src/components/inbox/inbox-view.tsx), so "/" really is
    // straight into the field — no new route, which is what the spec sanctioned.
    expect(m.shortcuts![0].url).toBe("/");
  });

  it("theme_color and background_color match, so the status bar does not disagree with the splash", () => {
    expect(m.background_color).toBe("#0a0510");
    expect(m.theme_color).toBe(m.background_color);
  });

  it("carries a name and a short_name that fits under a home screen icon", () => {
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    // 12 is not a spec number — it is the widely-cited practical limit before a
    // launcher ellipsises the label, and it varies by launcher and by font size
    // setting. The assertion is here to make a RENAME stop and think about the
    // home-screen label, which is the one place the app's name is read in
    // isolation, rather than to certify any particular device.
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
  });

  it("declares no share_target — an explicit non-goal of this slice (#254)", () => {
    // It needs a route the OS POSTs to directly, plus two unresolved product
    // decisions. Declared here so adding one is a deliberate act with a test to
    // update, rather than something that drifts in.
    expect(m.share_target).toBeUndefined();
  });
});

/**
 * ── Spec TDD step 5 ─────────────────────────────────────────────────────────
 */
describe("the manifest and its icons are unreachable by the auth gate (#277)", () => {
  /**
   * A browser evaluates installability while SIGNED OUT, so every path the
   * manifest names has to answer without a session. Today they do — and not
   * because anything classifies them as public. `src/proxy.ts`'s matcher
   * excludes `.*\.\w+$`, i.e. any path carrying a file extension, and all five of
   * these paths carry one. No `PUBLIC_PREFIXES` entry is consulted and no
   * redirect is possible.
   *
   * ⚠️ That is an incidental property of a regex, not a stated guarantee, which
   * is exactly why it is a test. `gate.ts` says nothing about the manifest. If
   * either the extension exclusion or those prefix lists change, install breaks
   * silently on a first visit — the same "green build, broken install" class this
   * whole file exists to rule out.
   *
   * ⚠️ The Apple touch icon is deliberately absent from this list: it is served
   * from the `app/**` file convention at a hashed URL, it is not named by the
   * manifest, and Safari ignores the manifest's icons in favour of its own
   * convention. `src/app/apple-icon.test.ts` owns it.
   */
  const matcher = proxyConfig.matcher;

  /**
   * The matcher is IMPORTED, never copied. A copied pattern stops describing the
   * deployed gate the moment the real one changes, which would leave this suite
   * green while install broke.
   *
   * The only transformation is anchoring — Next matches a middleware matcher
   * against the whole pathname — and the two controls below are what prove the
   * transformation is faithful rather than asserted to be.
   */
  const gateRunsOn = (pathname: string) =>
    matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

  it("the middleware config exposes exactly one matcher", () => {
    // More than one and `gateRunsOn` above would need to say which; fewer and
    // the import silently stopped resolving.
    expect(matcher).toHaveLength(1);
  });

  /**
   * ⚠️ THE control. A regex misread in the permissive direction would make every
   * assertion below pass for the wrong reason, so the suite has to show the same
   * function returning true for a path the gate really does run on.
   */
  it("CONTROL: the gate does run on ordinary app paths", () => {
    for (const pathname of ["/", "/settings", "/api/braindump", "/login"]) {
      expect(
        gateRunsOn(pathname),
        `expected the gate to run on ${pathname}`,
      ).toBe(true);
    }
  });

  it("the gate does not run on /manifest.webmanifest", () => {
    // Next serves `src/app/manifest.ts` at this pathname —
    // `normalizeMetadataRoute` in next/dist/lib/metadata/get-metadata-route.js
    // appends `.webmanifest` for the page `/manifest`.
    expect(gateRunsOn("/manifest.webmanifest")).toBe(false);
  });

  /**
   * ⚠️ Derived from the manifest's own `icons` array, never hand-written. A
   * hand-written list of three would leave both maskable paths unchecked, and
   * those are precisely the ones Android fetches for the home screen.
   */
  it.each((m.icons ?? []).map((i) => i.src))(
    "the gate does not run on %s",
    (src) => {
      expect(gateRunsOn(src)).toBe(false);
    },
  );

  it("checks all four icons, not a subset", () => {
    // Guards the derivation above: if `icons` were ever empty, `it.each` would
    // register zero cases and this describe block would go green having asserted
    // nothing about any icon.
    expect((m.icons ?? []).length).toBe(4);
  });
});

/**
 * ── The icon assets themselves ──────────────────────────────────────────────
 *
 * Not one of the spec's five steps. The spec measured these numbers once, in a
 * local spike, and a spike stops being evidence the moment its session ends —
 * so the measurement becomes a standing check on the committed files.
 */
describe("the generated icons (#277)", () => {
  const icons = m.icons ?? [];
  const read = (src: string) =>
    readPngPixels(readFileSync(path.join(PUBLIC_DIR, src.replace(/^\//, ""))));

  /**
   * Furthest **drawn** pixel from the centre, in pixels.
   *
   * ⚠️ "Drawn" cannot mean "opaque" for the maskable source, and the distinction
   * is the whole reason this helper takes a mode. The bitmap behind
   * `brand-mark.svg` is PNG colour type 2 — RGB with no alpha channel — so the
   * mark and the near-black background it sits on are equally opaque and an alpha
   * test cannot separate them. Measured, not predicted: an `alpha > 32` test
   * against the 1254px maskable raster reports the furthest drawn pixel at
   * 886.0px, which is exactly the canvas half-diagonal — the corner. It fails the
   * asset for precisely the wrong reason.
   *
   * The near-black background measures #0a0510–#0c0519, luminance 6–8, so a
   * luminance threshold of 60 is comfortably clear of it.
   */
  function furthestDrawn(src: string, mode: "luminance" | "alpha") {
    const { data, width, height, channels } = read(src);
    // ⚠️ Loud, not lenient. `png-inspect` also reads 1- and 2-channel greyscale
    // PNGs, and on those the luminance arithmetic below would take the ALPHA
    // sample for green and read past the pixel for blue — a plausible-looking
    // wrong number, which is the one thing this file must never produce. Every
    // icon here is RGB or RGBA; a regeneration that changed that should stop the
    // suite rather than quietly re-measure the safe zone against nonsense.
    expect(
      channels,
      `${src} decoded to ${channels} channels; the measurement below assumes RGB`,
    ).toBeGreaterThanOrEqual(3);
    const cx = width / 2 - 0.5;
    const cy = height / 2 - 0.5;
    let furthest = 0;
    let drawn = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * channels;
        const isDrawn =
          mode === "luminance"
            ? 0.2126 * data[at] +
                0.7152 * data[at + 1] +
                0.0722 * data[at + 2] >
              60
            : channels === 4 && data[at + 3] > 32;
        if (!isDrawn) continue;
        drawn++;
        furthest = Math.max(furthest, Math.hypot(x - cx, y - cy));
      }
    }
    return { furthest, drawn, width, height, safeRadius: 0.4 * width };
  }

  /**
   * ⚠️ The safe-zone assertion. Android crops a maskable icon to a shape, and the
   * guaranteed-visible region is the circle covering the centre 80% — radius
   * 0.4 x the icon's width. Anything drawn outside it can be clipped by an OEM
   * mask, and the symptom is a home-screen icon with a corner shaved off, which
   * only a handset can show you.
   *
   * ⚠️ An EDGE-MARGIN check is the wrong test and would pass this asset for the
   * wrong reason: the tightest margin on the source is 13.3%, under the 20% a
   * margin test would demand, while the mark's actual furthest drawn pixel is
   * comfortably inside the circle. The correct test is radial, and it is this one.
   */
  for (const size of [192, 512]) {
    it(`the ${size}px maskable icon draws nothing outside the safe circle`, () => {
      const src = icons.find(
        (i) => i.purpose === "maskable" && i.sizes === `${size}x${size}`,
      )!.src;
      const { furthest, safeRadius, drawn } = furthestDrawn(src, "luminance");
      expect(drawn).toBeGreaterThan(0); // the threshold found the mark at all
      expect(
        furthest,
        `${src}: furthest drawn pixel is ${furthest.toFixed(1)}px from centre, ` +
          `against a safe radius of ${safeRadius.toFixed(1)}px. An OEM mask can ` +
          `clip the overhang. Re-generate from brand-mark.svg without padding or ` +
          `re-cropping — see docs/design/specs/2026-08-12-mobile-manifest-design.md.`,
      ).toBeLessThan(safeRadius);
    });
  }

  /**
   * The control for the safe-zone test: the SAME measurement, in the mode the
   * spec warns against, reports the canvas corner. Without this, the assertions
   * above could be passing because `furthestDrawn` never found anything.
   */
  it("CONTROL: an alpha-based reading of the maskable icon returns the canvas corner", () => {
    const src = icons.find(
      (i) => i.purpose === "maskable" && i.sizes === "512x512",
    )!.src;
    const { furthest, width, safeRadius } = furthestDrawn(src, "alpha");
    const halfDiagonal = Math.hypot(width / 2 - 0.5, width / 2 - 0.5);
    expect(furthest).toBeCloseTo(halfDiagonal, 0);
    expect(furthest).toBeGreaterThan(safeRadius);
  });

  it("the maskable icons are opaque — transparency would render as a visible gap", () => {
    for (const icon of icons.filter((i) => i.purpose === "maskable")) {
      const facts = readPngFacts(
        readFileSync(path.join(PUBLIC_DIR, icon.src.replace(/^\//, ""))),
      );
      const pixels = facts.width * facts.height;
      // A rasteriser anti-aliases the outermost edge of the SVG shell's own
      // transform, so a handful of sub-255 alpha samples is an artefact rather
      // than content. What must not be there is a transparent REGION.
      const transparent = facts.fullyTransparentPixels ?? 0;
      expect(
        transparent / pixels,
        `${icon.src} has ${transparent} of ${pixels} pixels fully transparent; ` +
          `Android crops a maskable icon to a shape, so transparency shows as a gap`,
      ).toBeLessThan(0.001);
    }
  });

  it('the "any" icons keep their transparency — an opaque one is a dark square in every tab', () => {
    for (const icon of icons.filter((i) => i.purpose === "any")) {
      const facts = readPngFacts(
        readFileSync(path.join(PUBLIC_DIR, icon.src.replace(/^\//, ""))),
      );
      const pixels = facts.width * facts.height;
      expect(
        facts.hasAlphaChannel,
        `${icon.src} has no alpha channel, so it will render as a dark square ` +
          `in browser tabs and desktop installs`,
      ).toBe(true);
      expect(
        (facts.fullyTransparentPixels ?? 0) / pixels,
        `${icon.src} is barely transparent (${facts.fullyTransparentPixels} of ${pixels})`,
      ).toBeGreaterThan(0.5);
    }
  });

  it("the four icons together stay well under a megabyte", () => {
    // Every declared icon is fetched during an installability check, so the whole
    // set is on the critical path of the install prompt appearing.
    const total = icons.reduce(
      (sum, i) =>
        sum + statSync(path.join(PUBLIC_DIR, i.src.replace(/^\//, ""))).size,
      0,
    );
    expect(total).toBeLessThan(1024 * 1024);
  });
});
