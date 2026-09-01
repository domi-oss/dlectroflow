import type { MetadataRoute } from "next";

/**
 * The web app manifest — what makes dlectroflow installable to a phone's home
 * screen (#277, designed in
 * `docs/design/specs/2026-08-12-mobile-manifest-design.md`).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Capturing a thought on a phone costs: unlock, find Chrome, find the tab or
 * type the URL, wait for the page — **every time, not just the first.** For a
 * tool whose premise is that an idea you cannot write down is lost, that is the
 * wrong number of steps. Installed, it is: tap the icon, type. `display:
 * "standalone"` below also reclaims roughly 100px of browser chrome, which is
 * the same phone vertical space #253 is recovering from the task row.
 *
 * ── Why generated TypeScript rather than a static manifest.json ────────────
 *
 * Two reasons, both about failure modes. A malformed manifest fails `tsc` here,
 * rather than failing silently on a handset where the only symptom is "the
 * install option didn't appear". And a `.ts` file can carry the reasoning — this
 * document has at least three values whose wrongness is invisible until
 * somebody signs out on a phone, and a JSON file cannot explain itself.
 *
 * ⚠️ The path is `src/app/manifest.ts`, not `app/manifest.ts`. Next's own docs
 * say "the root of `app` directory"; this repo's App Router root is `src/app/`
 * and there is no `app/` at the repo root. A file created there is picked up by
 * nothing: no manifest emitted, build still green, and the only symptom the
 * missing install option.
 *
 * Next emits `<link rel="manifest" href="/manifest.webmanifest">` from the mere
 * existence of this file — `mergeStaticMetadata` in
 * `next/dist/lib/metadata/resolve-metadata.js` copies the discovered file
 * convention onto `metadata.manifest`, which is what
 * `next/dist/lib/metadata/metadata.js` renders the tag from. So nothing has to
 * be added to `src/app/layout.tsx`, and `e2e/smoke/manifest.spec.ts` asserts the
 * tag is really in the served HTML rather than trusting that reading.
 *
 * ── Kept free of `process.env`, deliberately ───────────────────────────────
 *
 * ⚠️ This route is **cached by default** — it is a Route Handler, and Next caches
 * one unless it touches a request-time API. Reading a runtime variable at module
 * scope therefore bakes in whatever the BUILD container had. Everything below is
 * a constant for that reason, and `manifest.test.ts` asserts there is no
 * `process.env` access in this file at all.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "dlectroflow",
    // Android truncates the label under a home-screen icon at roughly 12
    // characters, and "dlectroflow" is 11 — so the full name fits and there is
    // nothing to abbreviate. Stated rather than omitted: with no `short_name` a
    // browser falls back to `name`, which happens to be right here, and a future
    // rename would silently start truncating.
    short_name: "dlectroflow",
    // Deliberately NOT the same sentence as `metadata.description` in
    // src/app/layout.tsx. That one is a search snippet; this one is what an
    // install dialog shows under the app's name, where the audience has already
    // decided to install and the useful thing is what the app is FOR.
    description:
      "Capture a thought before it goes. An ADHD helper for brain dumps, breaking things down, and getting them done.",

    // ── start_url and scope are RELATIVE ────────────────────────────────────
    //
    // ⚠️ Do NOT change these to absolute URLs on PUBLIC_ORIGIN. #254's
    // description and #175's spec both proposed it, reasoning that an installed
    // app would then always launch on the canonical origin and so could not
    // reproduce #174's cookie split. It ships BROKEN: this route is
    // build-cached (see above) and PUBLIC_ORIGIN is runtime-only, set in
    // charts/dlectroflow/templates/deployment.yaml and read at request time by
    // src/lib/origin.ts. The build container has no value, so the baked
    // start_url would be missing or wrong — with a green build and green tests.
    //
    // A relative URL in a manifest resolves against the manifest's own URL, so
    // an app installed from dlectroflow.dev launches on dlectroflow.dev. No env
    // coupling, no caching opt-out, no dynamic route.
    //
    // The #174 hardening is not lost, and it was always narrower than that
    // proposal claimed: `canonicalOriginRedirect` (src/lib/origin.ts, called
    // from src/proxy.ts) pins only CANONICAL_ORIGIN_PREFIXES — `/api/auth/`,
    // `/api/google/oauth/` and `/login`. So an install from a non-canonical
    // hostname yields an app pinned to that hostname whose first SIGN-IN hops to
    // the canonical host, which is the designed behaviour rather than a gap.
    start_url: "/",

    // ⚠️ The one line here that carries real risk, and the reason
    // manifest.test.ts asserts CONTAINMENT rather than equality.
    //
    // `scope` decides which URLs open inside the installed app's window. If it
    // does not cover /api/auth/gitlab/callback, the provider's redirect opens in
    // a browser tab: the user ends up signed in THERE while the installed app
    // still reads signed-out, with nothing on screen explaining it. Invisible
    // until somebody signs out, which on a single-user app can be months.
    //
    // "/" covers it, and covers every future route for free. Narrowing this to
    // an app-shell prefix would look tidier and would break sign-in.
    scope: "/",

    // The whole point of the issue: no browser chrome, and the ~100px of phone
    // vertical space it occupies.
    display: "standalone",

    // ── The two colours are the same value, and that is the decision ────────
    //
    // `background_color` paints the splash screen and is SAMPLED from the icon's
    // own corner pixel (#0a0510 exactly, at (0,0) of the 1254px maskable
    // raster), so the splash has no seam against the icon it surrounds.
    // `theme_color` paints OS and browser chrome; matching it removes the
    // status-bar-versus-splash mismatch. The brand purple that opens
    // --gradient-brand was the obvious alternative and is declined for exactly
    // that reason.
    //
    // ⚠️ A manifest carries exactly one of each, and this app has a
    // light/dark/system setting (#85), so no single value can be right in both.
    // Per-scheme theming is a `<meta name="theme-color" media="…">` concern and
    // in Next 16 belongs in a `viewport` export, NOT here — there is nowhere in
    // this file to solve it. `background_color` has no per-scheme form at all,
    // so a light-theme launch keeps a one-frame jump from the near-black splash
    // into the near-white app. That is accepted on the record: the alternative,
    // a light `background_color`, would put a near-black icon on a near-white
    // splash — a persistent high-contrast artefact traded for one frame.
    background_color: "#0a0510",
    theme_color: "#0a0510",

    // ── Four icons, two purposes, generated from two sources ────────────────
    //
    // Both purposes are required and neither substitutes for the other:
    //
    //   * Android CROPS a maskable icon to an OEM shape, so transparency renders
    //     as a visible gap. The maskable pair therefore comes from the OPAQUE
    //     source, where the absence of alpha is a feature.
    //   * Using that opaque source for `purpose: "any"` puts a DARK SQUARE in
    //     every browser tab and desktop install. The "any" pair comes from the
    //     transparent source.
    //
    // Generated as a one-off local run from two SVG exports that are
    // deliberately NOT committed — between them 1.8 MB of base64-wrapped bitmap,
    // not editable in this repo, so versioning them costs a megabyte and a half
    // in a public repo and buys no editing capability. If a genuine vector ever
    // replaces them, commit that instead. The sources live in the owner's design
    // tool as `brand-mark.svg` (opaque) and `brand-mark-transparent.svg`, and the
    // recipe — pinned to sharp 0.35.3 / libvips 8.18.3, `resize(size, size)` then
    // `png({ compressionLevel: 9 })`, no padding and no re-crop — is in
    // docs/design/specs/2026-08-12-mobile-manifest-design.md under "Reproducing
    // these numbers". Every byte count there reproduces exactly.
    //
    // ⚠️ `sharp` is NOT a declared dependency and generating these at build time
    // is declined for that reason: it resolves only as `next`'s OPTIONAL
    // transitive, so a --no-optional install or a `next` upgrade that drops the
    // entry removes it without failing the install. Fine for a one-off local
    // run, not for a pipeline step.
    //
    // ⚠️ The safe zone is measured, not eyeballed. Android's mask keeps the
    // circle covering the centre 80%; the mark's furthest DRAWN pixel is 460.2px
    // against a 501.6px safe radius on the 1254px source, and manifest.test.ts
    // re-measures it on the committed files at both sizes. "Drawn" means
    // luminance above the near-black background, NOT opacity — the maskable
    // source has no alpha channel to test, and an alpha reading returns the
    // canvas corner.
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],

    // ── One shortcut ───────────────────────────────────────────────────────
    //
    // Long-press the installed icon → "New brain dump". No new route: the inbox
    // renders at the bare root and its capture input carries `autoFocus`
    // (src/components/inbox/inbox-view.tsx), so "/" already lands the caret in
    // the field. Same destination as `start_url` by construction, and it earns
    // its place anyway — the long-press menu is the only surface that NAMES the
    // capture action, which is the one thing this app has to be faster at than
    // the thought it is capturing.
    //
    // The url must stay inside `scope` or the shortcut opens a browser tab
    // instead of the app; manifest.test.ts asserts that.
    shortcuts: [
      {
        name: "New brain dump",
        short_name: "Brain dump",
        description: "Open dlectroflow with the capture field ready",
        url: "/",
      },
    ],

    // ── Not here, on purpose ───────────────────────────────────────────────
    //
    //   * `share_target` — the single largest reduction in capture friction
    //     available, and explicitly not in this slice. It needs a route the OS
    //     POSTs to directly, a surface this app does not have, plus two
    //     unresolved product decisions (does shared text land in the capture
    //     field for editing or save immediately; and does a shared capture reuse
    //     #175's offline queue or become a second loss path). It stays on #254,
    //     and manifest.test.ts asserts its absence so adding one is a deliberate
    //     act rather than a drift.
    //   * Any install prompt. Owner decision: say nothing at all. Installing is
    //     a one-time act by a single known user, so a prompt is code written to
    //     persuade somebody already persuaded, and it would sidestep the
    //     recorded preference against first-run noise. Chrome's own affordance is
    //     enough.
    //   * `id`. It defaults to `start_url`, which is "/" — so declaring it would
    //     be a no-op that reads as load-bearing. Add it at the same time as any
    //     change to `start_url`, which is the only thing that makes it matter.
  };
}
