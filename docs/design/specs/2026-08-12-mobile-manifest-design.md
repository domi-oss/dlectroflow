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

## Current state — grounded 2026-08-11, re-verified 2026-08-12

| Question | Answer |
| --- | --- |
| Is there a manifest? | **No.** Verified across `manifest.json` / `.webmanifest` / `manifest.ts`, `rel="manifest"`, and `next-pwa` / `workbox` / `serwist` in `package.json` and the lockfile. The only hit is `src/lib/export/manifest.ts`, the data-export manifest |
| Is there a service worker? | **Yes** — `public/sw.js`, registered at `src/lib/notifications.ts:40`. Notifications only, no `fetch` handler. **An installable app needs no more than this** |
| Icons available? | `public/brand-mark.png`, **256×256** only. No maskable set. Referenced by `src/components/brand/brand-mark.tsx`, its test, and `charts/dlectroflow/Chart.yaml`'s `icon:` — **so it must not be moved or replaced** |
| Image tooling? | `sharp` **already a dependency** (`package.json`). No new dependency needed |
| Is `PUBLIC_ORIGIN` available at build time? | **No — it is runtime only.** Set in `charts/dlectroflow/templates/deployment.yaml:204`, read at request time via `src/lib/origin.ts:54`. This is load-bearing; see below |

## Design

### `app/manifest.ts`, not a static `manifest.json`

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

`app/manifest.ts` is a Route Handler that is **cached by default** unless it uses a request-time API. And
`PUBLIC_ORIGIN` is a **runtime** variable. So reading it at module scope bakes whatever the *build
container* had — nothing — producing a missing or wrong `start_url`, with a green build and green tests.
Opting the route out of caching to read it at request time would make every manifest fetch dynamic to
recover a value that never varies for a given deployment.

**So: `start_url: "/"` and `scope: "/"`, both relative.** Relative URLs in a manifest resolve against the
manifest's own URL, so an app installed from `dlectroflow.dev` launches on `dlectroflow.dev`. No env
coupling, no caching opt-out, no dynamic route.

**The #174 hardening is not lost — it just comes from somewhere better.** `canonicalOriginRedirect`
(`src/proxy.ts`) already forces every request onto `PUBLIC_ORIGIN`'s host, so a user cannot linger on a
non-canonical hostname long enough to install from one. The guarantee is enforced by shipped code rather
than restated in a config file, which is the stronger arrangement.

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

`.*\.\w+$` excludes **any path carrying a file extension**. `app/manifest.ts` is served at
`/manifest.webmanifest`; the icons are `/icon-192.png`, `/icon-512.png`, `/apple-icon.png`. **All of them
have extensions, so none of them ever reaches the gate** — no `PUBLIC_PREFIXES` classification is
consulted, no redirect is possible, and no guest workspace is minted.

⚠️ **That is an incidental property of a regex, not a stated guarantee, and that is the actual finding.**
`gate.ts` says nothing about the manifest. It works today additionally because `OWNER_ONLY_PREFIXES` is
**empty** and `AUTHENTICATED_PREFIXES` is only `/api/account/` and `/api/google/oauth/` — but if either the
matcher's extension exclusion or those lists change, **install breaks silently on first visit**, which is
the same "green build, broken install" class this document already rules out for `start_url`.

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
| `brand-mark.svg` | opaque 1254×1254, **no alpha** | **`purpose: "maskable"`** |
| `brand-mark-transparent.svg` | real alpha (min 0, max 255, ~17% opaque) | **`purpose: "any"`** |

**Both are needed and neither substitutes for the other.** Android crops a maskable icon to a shape, so
transparency renders as a **visible gap** — the transparent source is wrong there, and the absence of
alpha in the opaque one is a feature rather than a limitation. Conversely, using the opaque one for
`purpose: "any"` puts a **dark square** in every browser tab and desktop install.

`sharp` **does** honour the `feColorMatrix` filters — verified by rasterising and measuring the alpha
channel, not assumed.

#### The maskable safe zone, measured

A maskable icon is cropped to a circle covering the centre 80%. **An edge-margin check is the wrong
test** and would have passed this asset for the wrong reason: margins are 13.3% clear, but the mark's
bounding-box half-diagonal is 608px against a safe radius of 502px, so corners *could* have been clipped.

The correct test is the furthest **drawn** pixel from centre. ⚠️ **"Drawn" cannot mean "opaque" for this
source, and the distinction is the whole reason this paragraph exists.** The maskable bitmap has **no alpha
channel at all** — every pixel is opaque, including the background — so an alpha test cannot separate the
mark from the square it sits on. It would report the corner of the canvas as the furthest pixel and fail
the asset.

**So the two sources need two different methods, and the doc has to say which:**

| Source | What counts as "drawn" | Threshold |
| --- | --- | --- |
| `brand-mark.svg` (maskable, no alpha) | **luminance** above the near-black background | `0.2126·R + 0.7152·G + 0.0722·B > 60`, on 0–255 |
| `brand-mark-transparent.svg` (`any`, real alpha) | **alpha** above a small floor, to ignore anti-aliased fringe | `alpha > 32`, on 0–255 |

The luminance threshold of 60 is comfortably clear of the background, which measures `#0a0510`–`#0c0519`
(luminance ≈ 6–8) at the corners and centre. Stated so the measurement is reproducible from this document
alone rather than only from the session that took it.

| Measurement (maskable source, 1254×1254) | Value |
| --- | --- |
| Safe circle radius (0.4 × 1254) | **501.6px** |
| Furthest drawn pixel from centre | **460.2px** |
| Drawn pixels outside the safe circle | **0 (0.00%)** |
| Drawn pixels total | 264,830 (**16.8%** of the canvas) |

**No padding, no downscaling, no redraw.** Generated as-is. The mark is centred horizontally and sits
**offset 1.8% of the canvas above vertical centre** — a position, not a size — which is not visible.

The `any` raster was checked the same way for completeness — furthest drawn pixel **188.3px** against a
**204.8px** safe radius at 512 — so it would also survive masking. It stays `purpose: "any"` regardless,
because its transparency is the point.

#### Sizes, weights and why the sources are not committed

| File | Size | Bytes |
| --- | --- | --- |
| `public/icon-192.png` (`any`) | 192×192 | 18,770 |
| `public/icon-192-maskable.png` | 192×192 | 32,749 |
| `public/icon-512.png` (`any`) | 512×512 | 95,284 |
| `public/icon-512-maskable.png` | 512×512 | 247,036 |
| `public/apple-icon.png` | 180×180 | generated; Safari ignores the manifest and uses its own convention |

**The four manifest icons total 393,839 bytes (385 KiB), measured; the Apple icon adds a little more.**
The two SVG sources are deliberately **NOT** committed. Between them they are
1.8 MB of base64-wrapped bitmap, and neither is editable in this repo — so versioning them costs a
megabyte and a half in a public repo and buys no editing capability. The generation command and both
source filenames are recorded in a comment above the icon array; the sources live in the owner's design
tool. **If a genuine vector ever replaces them, commit that instead** — a vector earns its place because
it can be edited.

The 512 maskable is the heavy one because it is an opaque dark gradient with nothing to compress away.
Recompressing the source at maximum effort produced a **larger** file, so it is already optimal. A flat
background colour would cut it to a few KB, but that is a design change and is not proposed here.

### `background_color: "#0a0510"`, and `theme_color` the same

`background_color` is **sampled from the icon's own corner pixels** rather than picked, so the splash
screen has no seam against the icon it surrounds.

**`theme_color` matches it, at `#0a0510`**, so the launch sequence — splash, then app — has no colour
jump. The obvious alternative was the brand purple that opens the gradient
(`--gradient-brand: linear-gradient(100deg, #9b5cf0, #e0479e)`, `src/app/globals.css:18`), and it is
declined for one reason: it does not match the icon's background, so the status bar would disagree with
the splash for the duration of the launch.

⚠️ **A manifest carries exactly one `theme_color`, and this app has a light/dark toggle**
(`src/components/theme-toggle.tsx`), so no single value can be right in both. Per-scheme theming is a
`<meta name="theme-color" media="…">` concern and in Next 16 belongs in the `viewport` export, **not** in
the manifest — recorded here because the natural instinct is to try to solve it in this file and there is
nowhere in this file to solve it.

### `shortcuts` — one entry

Long-press the icon → **"New brain dump"**, straight into the capture field. A few lines in the same
manifest, no new route, and it is the addition that most directly serves this issue's premise.

## Testing

TDD, failing test first, in this order:

1. **`scope` covers the OAuth callback.** ⚠️ **The callback path is derived from `src/lib/auth/gate.ts`,
   not hardcoded** — a hardcoded `/api/auth/gitlab/callback` would keep passing after the real route
   moved, which is the failure mode this test exists to prevent. Assert containment, not string equality.
2. **`start_url` and `scope` are relative.** Pins the decision above. The comment on the assertion says
   *why* absolute-on-`PUBLIC_ORIGIN` is wrong here, so the next reader does not "improve" it back.
3. **Both icon purposes are declared, at both sizes**, and every declared `src` exists on disk. A manifest
   naming an absent icon is valid JSON and a broken install.
4. **`display: "standalone"`** and the `shortcuts` entry's `url` is within `scope`.
5. **The manifest and every icon path are unreachable by the auth gate.** Assert each path against
   `src/proxy.ts`'s exported `config.matcher` — the manifest, all three icons — and **assert a control that
   IS matched** (`/`, or any extensionless app path), so a test that passes because the regex was misread
   cannot go green. This converts the extension-exclusion accident into a checked property: if someone
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
| Static `app/manifest.json` | No type checking, and cannot carry the reasoning for `scope` — the one line that fails invisibly |
| `next-pwa` / `serwist` | An entire PWA framework to emit one JSON document. Nothing here needs a service-worker build step; `sw.js` already exists |
| Generating icons at build time | Adds image processing to the Kaniko build, and a `sharp` dependency to the build stage, for assets that change approximately never. ⚠️ **An earlier version of this row also called it "non-deterministic", which was wrong** — resizing a fixed source with a pinned `sharp` is reproducible given identical inputs, and review of this spec was right to challenge it. Dropped rather than substantiated: the cost and dependency-surface arguments carry the decision on their own, and leaving an unsupported claim in a declined-options table invites a future reader to take it as a general fact about image generation |
| Committing the SVG sources | 1.8 MB of base64-wrapped bitmap, not editable in-repo. Would be right for a genuine vector |
| Upscaling `brand-mark.png` (256) | Unnecessary — the supplied source is 1254px. Recorded because it was the fallback before the export arrived |
| An install prompt | Owner decision. One known user, one-time act, and the repo has a recorded preference against first-run noise |
| Padding the mark for the safe zone | Measured unnecessary: furthest opaque pixel 460px against 502px allowed, zero pixels outside |

## Related

- **#254** — this issue. Its description says a brainstorm must precede any implementation plan; this
  document is that brainstorm's output, and it **narrows** the issue rather than restating it
- **#174** — the multi-hostname OAuth failure whose cause has been misread as a browser-context problem
  twice, including by #254's own description
- **#175** — its spec's *"The manifest question"* section is the handover that produced #254. Its claim
  about an absolute `start_url` is corrected here
- **#253** — the other half of the phone-vertical-space work
