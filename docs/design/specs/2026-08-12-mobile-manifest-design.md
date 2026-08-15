# A web app manifest — home screen capture, and the prerequisite for everything after it (#254)

Owner brainstorm held 2026-08-12. This document settles the judgment calls #254's description
deliberately left open, and **narrows #254 to one slice**: the manifest, the icons, and the one test that
catches the failure nobody would otherwise notice.

## Goal

Capturing a thought on a phone currently costs: unlock, find Chrome, find the tab or type the URL, wait
for the page — **every time, not just the first.** For a tool whose premise is that an idea you cannot
write down is lost, that is the wrong number of steps.

A manifest reduces it to: tap the icon, type. It also reclaims roughly **100px of browser chrome**, which
is the same phone vertical space #253 is currently fighting for, so the two compound.

## Non-goals — all three settled with the owner, not deferred by omission

- **`share_target`.** The single largest reduction in capture friction available, and **explicitly not in
  this slice.** It needs a route the OS `POST`s to directly — a surface this app does not have — plus two
  unresolved product decisions (does shared text land in the capture field for editing, or save
  immediately; and does a shared capture reuse #175's offline queue or become a second loss path).
  Declared *inside* the manifest, so this work is its prerequisite either way.
- **Any install prompt.** Owner decision: **say nothing at all.** Installing is a one-time act by a single
  known user, so a prompt is code written to persuade somebody already persuaded. It also sidesteps the
  recorded preference against first-run noise rather than negotiating with it. Chrome's own affordance,
  whenever it appears, is enough.
- **The Play Store route.** A Trusted Web Activity *requires* this manifest, so the two are sequential
  rather than alternative. Nothing here assumes it happens.

## Current state — grounded 2026-08-11, re-verified 2026-08-13 against `origin/main` at `2ab3210`

Every row below was re-read at that named commit rather than in a working tree, because the repo carries
many worktrees and a tree is only evidence about the commit you are standing on. **Every row the re-read
corrected or added carries a ⚠️.** The markers are the record — a count stated in prose drifts out of step
with them the moment another row changes, which is what happened here.

| Question | Answer |
| --- | --- |
| Is there a manifest? | ⚠️ **No.** Verified across `manifest.json` / `.webmanifest` / `manifest.ts`, `rel="manifest"`, and `next-pwa` / `workbox` / `serwist` in `package.json` and the lockfile — those last three return **zero** hits (control: the same query for `sharp`/`next` returns 141, so the zero is a real absence and not a query that never ran). Two files do match the word `manifest` and neither is one: `src/lib/export/manifest.ts` is the data-export manifest, and `src/lib/manifest-hygiene.{ts,test.ts}` is about `package.json` declaring its imports |
| Is there a service worker? | **Yes** — `public/sw.js`, registered at `src/lib/notifications.ts:40`. Notifications only, no `fetch` handler. **An installable app needs no more than this** |
| Icons available? | ⚠️ `public/brand-mark.png`, **256×256**, and transparent — 79% of its pixels are fully so. No maskable set. Referenced by `src/components/brand/brand-mark.tsx`, its test, and `charts/dlectroflow/Chart.yaml`'s `icon:` — **so it must not be moved or replaced** |
| Any Next metadata icons already? | ⚠️ **Yes, two.** `src/app/icon.png` is **byte-identical** to `public/brand-mark.png` (same git blob, 256×256), and `src/app/apple-icon.png` is 180×180 and **77.3% fully transparent**. Both arrived with #13/#40, and Next already emits `<link>` tags for them, so the app *does* ship an Apple touch icon today. **That file is the one this work replaces** — see Icons below |
| Image tooling? | ⚠️ **`sharp` is available but NOT declared, and the difference decides the build-time option below.** `package.json` mentions it only under `overrides` (`"sharp": "^0.35.3"`), which pins a version rather than declaring a package — it is in neither `dependencies` nor `devDependencies`. It resolves because **`next` lists it under `optionalDependencies`** (`^0.34.5`), and the lockfile marks `node_modules/sharp` `"optional": true`. Enough for a one-off local run after `npm ci`; **not** something to build a pipeline step on |
| Is `PUBLIC_ORIGIN` available at build time? | **No — it is runtime only.** Set in `charts/dlectroflow/templates/deployment.yaml:204`, read at request time via `src/lib/origin.ts:54`. This is load-bearing; see below |

## Design

### `src/app/manifest.ts`, not a static `manifest.json`

⚠️ **The path is `src/app/manifest.ts`, not `app/manifest.ts`.** The shipped docs say to put it in "the
**root** of `app` directory", and this repo's App Router root is `src/app/` — there is no `app/` at the
repo root. A file created there would not be picked up at all: no manifest emitted, build still green, and
the only symptom the missing install option. Spelled out because every other path in this document is
`src/`-prefixed and the heading was not.

Next 16 supports both. **Verified against `next@16.2.11`** — the version pinned in `package.json` and
installed at the time — in the docs that ship with the dependency, at
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md`.

⚠️ **That path is deliberately cited and deliberately version-pinned.** `AGENTS.md` makes the shipped docs
the source of truth for this project rather than recalled API shapes, so the citation is to the surface the
repo actually mandates — but `node_modules` is not version-controlled and the path can move on upgrade, so
the **version** is what makes the claim checkable later. The public equivalent is the Next.js `manifest`
file-convention reference. If a future reader cannot find the file, the question to ask is whether
`16.2.11`'s behaviour still applies, not whether the path is a typo.

The generated form is chosen for two reasons:

1. It returns `MetadataRoute.Manifest`, so a malformed manifest fails `tsc` rather than failing silently
   on a handset — where the only symptom is "the install option didn't appear".
2. **A `.ts` file can carry the reasoning.** This repo's comment convention exists for lines exactly like
   `scope`, which is the one value an implementation can get wrong in a way nothing notices until someone
   signs out. A JSON file cannot explain itself.

### ⚠️ `start_url` and `scope` are RELATIVE — and #254's description is wrong about this

**#254 and the #175 spec both say to use an absolute `start_url` on `PUBLIC_ORIGIN`.** That would harden
against #174's root cause, which is why it was proposed. **It does not work in Next 16 and would ship
broken.**

`src/app/manifest.ts` is a Route Handler that is **cached by default** unless it uses a request-time API —
the cited `manifest.md` says exactly that, in a *Good to know* note, which is what makes this claim
checkable rather than recalled. And `PUBLIC_ORIGIN` is a **runtime** variable. So reading it at module
scope bakes whatever the *build
container* had — nothing — producing a missing or wrong `start_url`, with a green build and green tests.
Opting the route out of caching to read it at request time would make every manifest fetch dynamic to
recover a value that never varies for a given deployment.

**So: `start_url: "/"` and `scope: "/"`, both relative.** Relative URLs in a manifest resolve against the
manifest's own URL, so an app installed from `dlectroflow.dev` launches on `dlectroflow.dev`. No env
coupling, no caching opt-out, no dynamic route.

**The #174 hardening is not lost — but it is narrower than this paragraph claimed.**
`canonicalOriginRedirect` is defined in `src/lib/origin.ts` (`src/proxy.ts` imports and calls it — the
spec one day earlier had to correct this same citation), and it only fires for paths matching
`CANONICAL_ORIGIN_PREFIXES`: `/api/auth/`, `/api/google/oauth/` and `/login`. It does **not** force
*every* request onto `PUBLIC_ORIGIN`'s host, and that is deliberate — the homepage, the privacy notice
and the terms answer 200 on every served hostname so a consent-screen reviewer's cold fetch gets no hop.

⚠️ **So the original argument here does not hold, and the design needs to answer it rather than inherit
it.** A user *can* linger on a non-canonical hostname indefinitely on exactly the pages an install
prompt appears on, because those are the pages excluded from the redirect. What the redirect guarantees
is that they cannot complete a *sign-in* there. With `start_url` and `scope` relative, an install from
the apex therefore yields an app pinned to the apex whose first sign-in attempt hops to the canonical
host — which is the behaviour to design for, not a case the redirect rules out.

**#174's cause, for the record, because it has been misread twice.** It was **not** a browser-context
problem. The app answered on more than one hostname while `PUBLIC_ORIGIN` named one, and host-only
PKCE/state cookies returned to a host that did not have them. A phone's collapsed URL bar hid the hostname
change, which is why it presented as a hang. #174's description used *the absence of a manifest* as an
eliminating fact for a trap that was never the cause — so the manifest was being avoided for a reason that
did not exist.

### Unauthenticated reachability — it works, and the reason is an accident worth pinning

**Review of this spec asked whether the manifest and its icons are reachable without authentication, which
is exactly when a browser evaluates installability.** The concern is right and the mechanism it assumed is
not, so both are recorded.

**They are reachable, and not because anything classifies them as public.** `src/proxy.ts`'s matcher is:

```
matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"]
```

`.*\.\w+$` excludes **any path carrying a file extension**. `src/app/manifest.ts` is served at
`/manifest.webmanifest` — **read out of Next 16.2.11's own source rather than inferred**:
`normalizeMetadataRoute` in `node_modules/next/dist/lib/metadata/get-metadata-route.js` contains
`else if (page === "/manifest") { route += ".webmanifest" }`. The four manifest icons are
`/icon-192.png`, `/icon-192-maskable.png`, `/icon-512.png` and `/icon-512-maskable.png`. **All five paths
carry an extension, so none of them ever reaches the gate** — no `PUBLIC_PREFIXES` classification is
consulted, no redirect is possible, and no guest workspace is minted.

⚠️ **The Apple touch icon is the exception, and it is worth knowing before the implementation MR asserts
otherwise.** Next serves the `apple-icon` file convention at `/apple-icon?<hash>` (`app-icons.md`, same
docs directory) — an **extensionless pathname**, with the digest in the query string. So `/apple-icon` and
`/icon` *do* match the matcher and *do* reach the gate. Traced through `src/proxy.ts` at `2ab3210`: neither
is in `PUBLIC_PREFIXES`, so a signed-out fetch falls through to the guest branch, which returns
`NextResponse.next()` and mints a guest cookie. **It passes through rather than redirecting**, so nothing
is broken and installability is unaffected — but the blanket sentence above holds only for the
extension-carrying paths, and that is exactly the kind of distinction this section exists to pin.

⚠️ **That is an incidental property of a regex, not a stated guarantee, and that is the actual finding.**
`gate.ts` says nothing about the manifest. It works today additionally because `OWNER_ONLY_PREFIXES` is
**empty** and `AUTHENTICATED_PREFIXES` is only `/api/account/` and `/api/google/oauth/` — but if either the
matcher's extension exclusion or those lists change, **install breaks silently on first visit**, which is
the same "green build, broken install" class this document already rules out for `start_url`.

⚠️ **Do not size up the gate from the two lists named above.** `gate.ts` exports **four** prefix lists, and
`/api/auth/` appears in two of them — `PUBLIC_PREFIXES` and `CANONICAL_ORIGIN_PREFIXES`. That pair is what
makes the OAuth callback reachable signed-out *and* pinned to one origin. Nothing here touches either, but
neither is empty, and reading only the two above has already produced one wrong conclusion about which
module owns the callback path (see Testing, step 1).

**So it gets a test rather than a sentence** (see Testing). Had the mechanism been the one review assumed —
a signed-out fetch redirected to `/login` — the fix would have been a `PUBLIC_PREFIXES` entry. It is not,
so adding one would be dead configuration that reads as load-bearing. **Pin the behaviour, not a
workaround for a failure that does not occur.**

### `scope: "/"` is the one line that carries real risk

If `scope` does not cover `/api/auth/gitlab/callback`, the OAuth callback opens **outside** the installed
app's window. The user is then signed in **in a browser tab** while the installed app still reads
signed-out. `scope: "/"` covers it.

**This is invisible until someone signs out**, which is why it gets a test rather than a comment alone.

### Icons — two purposes, from two sources, and the pair is required

The owner supplied two Canva exports. **Neither is a true vector** — both are base64-embedded bitmaps in
an SVG shell (zero `<path>` elements; the transparent one adds `feColorMatrix` filters). That is fine:
the embedded bitmap is **1254×1254**, comfortably above the 512 ceiling any manifest needs.

| Source | Rasterises to | Declared as |
| --- | --- | --- |
| `brand-mark.svg` | opaque 1254×1254 — embedded bitmap is **PNG colour type 2, no alpha channel** | **`purpose: "maskable"`** |
| `brand-mark-transparent.svg` | real alpha (min 0, max 255; 17.3% of pixels above the alpha floor) | **`purpose: "any"`** |

**Both are needed and neither substitutes for the other.** Android crops a maskable icon to a shape, so
transparency renders as a **visible gap** — the transparent source is wrong there, and the absence of
alpha in the opaque one is a feature rather than a limitation. Conversely, using the opaque one for
`purpose: "any"` puts a **dark square** in every browser tab and desktop install.

`sharp` **does** honour the `feColorMatrix` filters — verified by rasterising and measuring the alpha
channel, not assumed.

#### The maskable safe zone, measured

A maskable icon is cropped to a circle covering the centre 80%. **An edge-margin check is the wrong
test** and would have passed this asset for the wrong reason: the tightest margin is 13.3% (that is the
top; left, right and bottom measure 16.3%, 16.4% and 16.9%), but the mark's bounding-box half-diagonal is
607.5px against a safe radius of 501.6px, so corners *could* have been clipped.

The correct test is the furthest **drawn** pixel from centre. ⚠️ **"Drawn" cannot mean "opaque" for this
source, and the distinction is the whole reason this paragraph exists.** The bitmap embedded in
`brand-mark.svg` is **PNG colour type 2 — RGB, with no alpha channel** (read from the decoded IHDR), so the
mark *and* the background it sits on are equally opaque, and an alpha test cannot separate the two.

**That failure was measured, not predicted.** Running the `alpha > 32` test against the maskable raster
reports the furthest drawn pixel at **886.0px** — which is exactly the canvas half-diagonal
(`hypot(626.5, 626.5) = 886.0`), i.e. the corner — against a safe radius of 501.6px. It fails the asset,
for precisely the wrong reason.

⚠️ **"No alpha" is a claim about the source bitmap, not about the output — do not restate it of the
generated files.** The *rasterised* PNG is not alpha-free: compositing the SVG shell's
`matrix(0.749601, …)` transform onto a transparent canvas anti-aliases the outermost edge, leaving **2,507
pixels (0.16% of the canvas) below alpha 255**, and exactly one at or below 32. That is a rasteriser edge
artefact rather than content, so it changes nothing above — but it does mean the generated maskable files
carry an alpha channel unless the generator explicitly drops it.

**So the two sources need two different methods, and the doc has to say which:**

| Source | What counts as "drawn" | Threshold |
| --- | --- | --- |
| `brand-mark.svg` (maskable, no alpha) | **luminance** above the near-black background | `0.2126·R + 0.7152·G + 0.0722·B > 60`, on 0–255 |
| `brand-mark-transparent.svg` (`any`, real alpha) | **alpha** above a small floor, to ignore anti-aliased fringe | `alpha > 32`, on 0–255 |

The luminance threshold of 60 is comfortably clear of the background, which measures `#0a0510`–`#0c0519`
(luminance ≈ 6–8) at the corners and centre — both endpoints re-confirmed exactly on 2026-08-13. Stated so
the measurement is reproducible from this document alone rather than only from the session that took it.

| Measurement (maskable source, 1254×1254) | Value |
| --- | --- |
| Safe circle radius (0.4 × 1254) | **501.6px** |
| Furthest drawn pixel from centre | **460.2px** |
| Drawn pixels outside the safe circle | **0 (0.00%)** |
| Drawn pixels total | 264,207 (**16.8%** of the canvas) |
| Mark bounding box | x 205–1047, y 167–1041 — half-diagonal **607.5px** |

Every figure above comes from the script in *Reproducing these numbers* below. Re-derive them from there
rather than trusting a figure quoted anywhere else.

**No padding, no downscaling, no redraw.** Generated as-is. The mark is centred horizontally (bounding-box
centre x 626.0 against a canvas centre of 626.5) and sits **offset 1.8% of the canvas above vertical
centre** — a position, not a size — which is not visible. ⚠️ **That 1.8% is the bounding-box centre**
(1.79% precisely); the *centroid* of drawn pixels sits 1.35% above, because the mark is not symmetric. Both
definitions are defensible, so the one in use is named.

The `any` raster was checked the same way for completeness — furthest drawn pixel **188.3px** against a
**204.8px** safe radius at 512 — so it would also survive masking. It stays `purpose: "any"` regardless,
because its transparency is the point.

#### Sizes, weights and why the sources are not committed

| File | Size | Bytes | Rasterised from |
| --- | --- | --- | --- |
| `public/icon-192.png` (`any`) | 192×192 | 18,770 | transparent |
| `public/icon-192-maskable.png` | 192×192 | 37,491 | opaque |
| `public/icon-512.png` (`any`) | 512×512 | 95,284 | transparent |
| `public/icon-512-maskable.png` | 512×512 | 246,479 | opaque |
| `src/app/apple-icon.png` (replaces the existing file) | 180×180 | 33,069 | opaque |

Every byte count is the output of the single command in *Reproducing these numbers* below. Safari ignores
the manifest and uses its own file convention, which is why the last row exists at all and why it is the one
row not named in the manifest's `icons` array.

⚠️ **`apple-icon.png` comes from the OPAQUE source.** iOS renders a transparent home-screen icon against a
**black backdrop** — the same *"dark square"* failure mode described above for using the opaque source as
`purpose: "any"`, just inverted. Since the mark sits on a near-black gradient already, a transparent Apple
icon would look *almost* right on a dark background and wrong everywhere else, which is the worst kind of
bug to leave for an actual iPhone to find.

Using the opaque source directly is also simpler than flattening the transparent one onto
`background_color`: same pixels, one fewer step, and nothing to get wrong. **So of the five generated
files, three come from the opaque source — both maskable icons and the Apple icon — and two, the
`purpose: "any"` pair, come from the transparent one.**

⚠️ **The Apple icon replaces `src/app/apple-icon.png`. It does NOT go to `public/apple-icon.png`, and this
is the one thing in this section most likely to be got wrong.** `src/app/apple-icon.png` **already exists**
at `2ab3210`: 180×180, with **77.3% of its pixels fully transparent**. So the iOS black-backdrop rendering
described above is not a risk to be avoided in future — it is **what ships today**, and correcting it is
the point of this row rather than a side effect of it.

The directory is load-bearing because the two locations are not interchangeable. The `apple-icon` file
convention is scanned under `app/**` only (`app-icons.md`), and Next already emits
`<link rel="apple-touch-icon" href="/apple-icon?<hash>">` from the existing file. A *new* file at
`public/apple-icon.png` would be served at `/apple-icon.png`, a URL **nothing links to** — Safari would go
on fetching `/apple-icon` and go on getting the transparent icon. The fix would ship, add 33 KB to the
image, and change nothing on the phone. **Replace the existing convention file's contents; do not add a
second icon under `public/`.**

**The four manifest icons total 398,024 bytes (388.7 KiB); the Apple icon adds 33,069 more.**
The two SVG sources are deliberately **NOT** committed. Between them they are
1,837,533 bytes of base64-wrapped bitmap, and neither is editable in this repo — so versioning them costs a
megabyte and a half in a public repo and buys no editing capability. The generation command and both
source filenames are recorded in a comment above the icon array; the sources live in the owner's design
tool. **If a genuine vector ever replaces them, commit that instead** — a vector earns its place because
it can be edited.

The 512 maskable is the heavy one because it is an opaque dark gradient with nothing to compress away, and
**it is already at the floor for lossless PNG**: `compressionLevel: 9` gives 246,479 bytes, the default
level 6 gives 250,810, and both `effort: 10` and a second lossless pass over the output return **exactly
246,479** — byte-identical, so there is nothing left to win losslessly.

There is one lossy saving available, recorded so it is declined on the record rather than rediscovered:
`png({ palette: true, effort: 10 })` cuts that file to **117,659 bytes, a 52% saving**. It is declined
because that is 256-colour quantisation and this asset is a smooth dark gradient — the one thing a small
palette bands visibly. A flat background colour would cut it to a few KB, but that is a design
change and is not proposed here.

#### Reproducing these numbers

Every figure in this section came from a local spike, and a spike stops being evidence the moment its
session ends — so the command is recorded in place of the trust. It needs the two uncommitted SVG sources
from the design tool and nothing else. `sharp` needs no install — it resolves from `node_modules` after a
normal `npm ci`, as `next`'s optional transitive pinned to `^0.35.3` by this repo's `overrides` (see the
*Image tooling?* row). That is sound for a one-off local run and is precisely why the build-time option is
declined. These numbers were taken on **`sharp 0.35.3` / `libvips 8.18.3`**.

```js
// node --input-type=module, run from the repo root with the two SVGs in place
import sharp from "sharp";
const OPAQUE = "brand-mark.svg"; // purpose: "maskable" + the Apple icon
const TRANSPARENT = "brand-mark-transparent.svg"; // purpose: "any"
const jobs = [
  ["public/icon-192.png", TRANSPARENT, 192],
  ["public/icon-192-maskable.png", OPAQUE, 192],
  ["public/icon-512.png", TRANSPARENT, 512],
  ["public/icon-512-maskable.png", OPAQUE, 512],
  ["src/app/apple-icon.png", OPAQUE, 180],
];
for (const [out, src, size] of jobs) {
  await sharp(src).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
}
```

`compressionLevel: 9` is part of the recipe rather than a detail: the default level 6 emits different bytes,
and a byte count is only checkable against a stated setting. The geometry figures come from the same
rasters — `resize(1254, 1254).ensureAlpha().raw()`, then the luminance and alpha thresholds already tabled
above.

⚠️ **This recipe is the only authority for these figures.** Byte counts for the two maskable icons have
circulated that no combination of rasterisation density, resize kernel, alpha handling, compression level,
filtering or palette mode reproduces — so a figure quoted anywhere other than the table above should be
distrusted and re-derived, not reconciled.

### `background_color: "#0a0510"`, and `theme_color` the same

`background_color` is **sampled from the icon's own corner pixels** rather than picked, so the splash
screen has no seam against the icon it surrounds: pixel (0, 0) of the 1254×1254 maskable raster is exactly
`#0a0510`, and 2,255 pixels across the canvas match it exactly.

**`theme_color` matches it, at `#0a0510`.** The obvious alternative was the brand purple that opens the
gradient (`--gradient-brand: linear-gradient(100deg, #9b5cf0, #e0479e)`, `src/app/globals.css:18`), and it
is declined for one reason: it does not match the icon's background, so the status bar would disagree with
the splash for the duration of the launch.

⚠️ **A manifest carries exactly one `theme_color`, and this app has a light/dark toggle**
(`src/components/theme-toggle.tsx`), so no single value can be right in both. Per-scheme theming is a
`<meta name="theme-color" media="…">` concern and in Next 16 belongs in the `viewport` export, **not** in
the manifest — recorded here because the natural instinct is to try to solve it in this file and there is
nowhere in this file to solve it.

#### `background_color` inherits that limitation, and the residual seam is ACCEPTED

**What matching the two values actually buys, stated precisely, because it is easy to overclaim.**
`theme_color` paints **OS and browser UI chrome**, not the app canvas — so matching it to
`background_color` removes the *status-bar-versus-splash* mismatch. It does **not** govern
splash-versus-app. That is the app's own CSS `--background`, which is theme-dependent. Measured at
`2ab3210`:

| Surface | Value | Luminance |
| --- | --- | --- |
| Manifest splash (`background_color`) | `#0a0510` | 6.9 |
| App background, dark (`.dark --background`) | `#0c0a14` | 11.1 |
| App background, light (`:root --background`) | `#fdf6fa` | 247.8 |

In the dark theme the launch really is seamless — 4 luminance units apart, imperceptible. **In the light
theme it is a 241-unit jump**, and that path is not hypothetical: `src/app/layout.tsx` adds `.dark` only
when `localStorage["df-theme"] === "dark"`, with **no `prefers-color-scheme` fallback**, so any install
with no stored preference renders light. On iOS a home-screen web app gets its own storage jar, so a
freshly added app starts there by construction.

**Accepted, because the manifest offers no way out and the alternative is worse.** Unlike `theme_color`,
`background_color` has **no per-scheme form at all** — no `viewport` export to move it to, no media-query
variant in the spec — so this is a stronger version of the callout above, not a second instance of it. And
the two goals are mutually exclusive: the splash paints the icon *on* `background_color`, and the icon's
own background is near-black. Setting `background_color` to `#fdf6fa` would put a near-black square on a
near-white splash, reintroducing the **dark square** artefact this document rules out twice elsewhere — a
persistent, high-contrast defect on the splash itself, traded for removing one transition on entry. **A
one-frame jump into the app is the cheaper of the two, so `#0a0510` stands.**

The lever for revisiting this is not in this file: it is giving the app a `prefers-color-scheme` default,
so a dark-system user lands in the dark theme and the seamless path becomes the common one.

### `shortcuts` — one entry

Long-press the icon → **"New brain dump"**, straight into the capture field. A few lines in the same
manifest, no new route, and it is the addition that most directly serves this issue's premise.

## Testing

TDD, failing test first, in this order:

1. **`scope` covers the OAuth callback.** Assert containment, not string equality.

   ⚠️ **Do not derive the path from `src/lib/auth/gate.ts` — it is the obvious wrong answer here.**
   `gate.ts` *does* carry `/api/auth/`, in `PUBLIC_PREFIXES` and again in `CANONICAL_ORIGIN_PREFIXES`, so
   the file looks like the auth source of truth. But that is a **prefix**, not the callback path, and it
   fails for exactly the reason this test exists: if the route directory moved, `/api/auth/` would not
   change, so a test reading `gate.ts` would keep passing. Same failure as hardcoding, with more ceremony.

   **What actually owns the path is the App Router file tree.** At `2ab3210` the route is
   `src/app/api/auth/gitlab/callback/route.ts`, and **no module exports the path as a constant.** The
   string is built inline as a template literal in exactly two non-exported places:
   `src/app/api/auth/gitlab/start/route.ts:29` (``const redirectUri = `${origin}/api/auth/gitlab/callback` ``)
   and `src/app/api/auth/gitlab/callback/route.ts:80` (the matching `redirectUri` on the token exchange).
   Nothing is importable today, so "derive, don't hardcode" has to resolve to one of two things and the
   implementation MR should pick one deliberately:

   - **Derive from the route's own location on disk** — resolve
     `src/app/api/auth/gitlab/callback/route.ts` and turn its directory into a URL path. This reds if the
     route moves, which is the property wanted; it needs no source change; and it is the shape the repo's
     existing repo-asserting hygiene tests already use.
   - **Or export a constant** that both route files and the test read. The repo has precedent —
     `src/lib/focus-catalog.ts:34,46` export `CATALOG_INDEX_PATH` and `CATALOG_AUDIO_PATH` for this exact
     reason. It is the stronger option and the only one that also removes the two duplicated literals, but
     it is a **source** change and so belongs to the implementation slice, not to this spec.
2. **`start_url` and `scope` are relative.** Pins the decision above. The comment on the assertion says
   *why* absolute-on-`PUBLIC_ORIGIN` is wrong here, so the next reader does not "improve" it back.
3. **Both icon purposes are declared, at both sizes**, and every declared `src` exists on disk. A manifest
   naming an absent icon is valid JSON and a broken install.
4. **`display: "standalone"`** and the `shortcuts` entry's `url` is within `scope`.
5. **The manifest and every manifest icon path are unreachable by the auth gate.** Assert each path against
   `src/proxy.ts`'s exported `config.matcher` — `/manifest.webmanifest` plus **all four** icons
   (`/icon-192.png`, `/icon-192-maskable.png`, `/icon-512.png`, `/icon-512-maskable.png`) — and **assert a
   control that IS matched** (`/`, or any extensionless app path), so a test that passes because the regex
   was misread cannot go green. ⚠️ **Derive the list from the manifest's own `icons` array, not by hand** —
   a hand-written list of three leaves both maskable paths unchecked, and those are precisely the ones
   Android fetches for the home screen.
   ⚠️ **The Apple touch icon is deliberately not in this list.** It is served at the extensionless
   `/apple-icon`, so it *is* matched by the matcher — asserting it alongside the others would simply be
   false. It passes through the gate rather than being redirected; see *Unauthenticated reachability*. This converts the extension-exclusion accident into a checked property: if someone
   later removes that exclusion or gates `/`, this reds instead of install silently failing on first visit.
   ⚠️ Import the matcher from `proxy.ts`; do **not** copy the pattern into the test, or the test stops
   describing the deployed gate the moment the real one changes.

### ⚠️ One thing cannot be automated, and pretending otherwise is the risk

**Sign-in must be exercised on a genuinely installed app, on a handset.** #174's "reproduce on a real
mobile device" was honoured with ingress logs and `curl` — the right call *there*, and **not sufficient
here**, because the entire question is what the launch context does to cookies. No test in this repo can
observe that.

This is a manual checklist item on #254 and it is **the slow part of this work.** The code is small; the
verification cannot be parallelised or mocked.

## Sequencing

- Depends on nothing. `public/sw.js` already exists and needs no change.
- **Compounds with #253** — both are about phone vertical space, and `display: "standalone"` reclaims
  roughly the same 100px #253 is recovering from the row. They touch no common files.
- **Unblocks** `share_target`, app shortcuts beyond the one here, durable storage
  (`navigator.storage.persist()`, for which installation is one of Chrome's signals — better odds, not a
  guarantee), and a future TWA.

## Considered and declined

| Option | Why not |
| --- | --- |
| Absolute `start_url` on `PUBLIC_ORIGIN` | Proposed by #254 and the #175 spec. **Ships broken** — the manifest route is build-cached and the variable is runtime-only. See above |
| Static `src/app/manifest.json` | No type checking, and cannot carry the reasoning for `scope` — the one line that fails invisibly |
| `next-pwa` / `serwist` | An entire PWA framework to emit one JSON document. Nothing here needs a service-worker build step; `sw.js` already exists |
| Generating icons at build time | Adds image processing to **`build_app`** — the `npm ci` + `next build` job, **not** Kaniko, which only assembles the image from that job's artifacts — for assets that change approximately never. ⚠️ **And it would mean genuinely DECLARING `sharp`.** Today it resolves only as `next`'s **optional** transitive, so a `--no-optional` install, a platform with no prebuilt binary, or a `next` upgrade that drops the entry each remove it *without failing the install*. That is tolerable for a one-off local run and not for a pipeline step, so making it reliable costs a real new direct dependency — which is the actual price of this option, and it is not the same as "`sharp` is already there". ⚠️ It is **not** non-deterministic, and the row must not say so: resizing a fixed source with a pinned `sharp` is reproducible given identical inputs |
| Committing the SVG sources | 1.8 MB of base64-wrapped bitmap, not editable in-repo. Would be right for a genuine vector |
| Upscaling `brand-mark.png` (256) | Unnecessary — the supplied source is 1254px. Recorded because it was the fallback before the export arrived |
| An install prompt | Owner decision. One known user, one-time act, and the repo has a recorded preference against first-run noise |
| Padding the mark for the safe zone | Measured unnecessary: furthest **drawn** pixel 460.2px against 501.6px allowed, zero pixels outside. "Drawn" means luminance > 60, **not** opacity — an alpha test on this source returns the canvas corner, as the section above shows |
| A second Apple icon under `public/` | It would be served at `/apple-icon.png`, which nothing links to, while Safari kept fetching `/apple-icon` from the existing convention file. The fix would ship and do nothing — see Icons |

## Related

- **#254** — this issue. Its description says a brainstorm must precede any implementation plan; this
  document is that brainstorm's output, and it **narrows** the issue rather than restating it
- **#174** — the multi-hostname OAuth failure whose cause has been misread as a browser-context problem
  twice, including by #254's own description
- **#175** — its spec's *"The manifest question"* section is the handover that produced #254. Its claim
  about an absolute `start_url` is corrected here
- **#253** — the other half of the phone-vertical-space work
