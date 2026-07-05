# AppSec Hardening — July 2026

This document records the security improvements made in the `appsec/best-practices-hardening`
branch and the rationale behind each change. It serves as an audit trail for SOC 2 CC7.1
(change management) and OWASP ASVS compliance reviews.

## Changes

### 1. GitLab Security Scanners (`.gitlab-ci.yml`)

**What changed:** Included four GitLab-managed scanner templates, which run in the `test`
stage (the stage these templates target by default):
- `Security/SAST.gitlab-ci.yml` — static analysis of TypeScript/JavaScript source
- `Security/Dependency-Scanning.gitlab-ci.yml` — npm advisory database checks against `package-lock.json`
- `Security/Secret-Detection.gitlab-ci.yml` — detects accidentally committed secrets
- `Security/Container-Scanning.gitlab-ci.yml` — CVE scan of the built Docker image

**Why:** The pipeline previously had zero security scanning — no automated vulnerability
detection on MRs.

**Compliance:** SOC 2 CC7.1, CIS Control 16, OWASP ASVS V14

**Demo value:** Populates the Vulnerability Report, MR Security Widget, and Compliance
Dashboard automatically on every push.

---

### 2. HTTP Security Headers (`next.config.ts`)

**What changed:** Added the following headers to all responses:

| Header | Value | Purpose |
|---|---|---|
| `Content-Security-Policy` | scoped to self + Anthropic/Google APIs | Prevents XSS and data injection |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS for 2 years |
| `X-Frame-Options` | `SAMEORIGIN` | Prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | camera, mic, geolocation, payment disabled | Reduces browser attack surface |

**Why:** The application had no transport-layer security headers. This is a baseline
requirement for OWASP ASVS V14.4 and is checked by most automated security scanners.

**Compliance:** OWASP ASVS V14.4, SOC 2 CC6.1

---

### 3. AI API Input Validation (`src/app/api/breakdown/route.ts`)

**What changed:** Added a 10 000-character body size guard before JSON parsing and before
any call to the Claude API.

**Why:** The `/api/breakdown` endpoint was unauthenticated (single-user demo app) and had
no request size limit. A malicious actor with access to a review app URL could send
arbitrarily large payloads, triggering expensive Claude Opus calls.

**Compliance:** OWASP ASVS V13.2.6 (API abuse prevention), SOC 2 CC6.6

---

### 4. Ingress Hardening (`charts/dlectroflow/templates/ingress.yaml`)

**What changed:**
- Force HTTPS redirect (`ssl-redirect` + `force-ssl-redirect`)
- Request body cap at 2 MB (`proxy-body-size`)
- Per-IP rate limiting: 20 RPS, 20 concurrent connections

**Why:** The ingress previously had no rate limiting or body size enforcement. The
application-layer guards (body size in route.ts, HSTS + headers in next.config.ts) are the
primary controls; these annotations add a defence-in-depth backstop.

> Security response headers are **not** set at the ingress via a `configuration-snippet`:
> ingress-nginx v1.15 disables snippet annotations by default (`allow-snippet-annotations=false`,
> post CVE-2023-5043), so the admission webhook would reject the Ingress. The app sets those
> headers in `next.config.ts` instead.

**Compliance:** OWASP ASVS V13.2.6, CIS Kubernetes Benchmark 5.4

---

### 5. Container Image Slimming (`Dockerfile`)

**What changed:** The `openssl` install now uses `--no-install-recommends` (in both the
build and runtime stages) so apt doesn't pull in recommended-but-unneeded packages. The
runtime image still contains the Prisma CLI + schema, because the Kubernetes migrate
initContainer reuses this same image to run `prisma migrate deploy`.

**Why:** Keep the runtime image as small as reasonable. `--no-install-recommends` trims the
apt footprint on top of `node:22-slim`.

**Compliance:** CIS Docker Benchmark 4.3 (minimal base image), SOC 2 CC7.1

> Note: an earlier version of this doc claimed the base image shipped ImageMagick/HDF5/libraw
> causing "140+ CVEs" and that this change would drop CVEs from ~150 to <10. That was not
> substantiated — `node:22-slim` does not ship those packages. Any actual CVE reduction should
> be read from the Container Scanning job's report, not asserted here.

---

## Remaining Recommendations (not in this MR)

These require GitLab UI/admin actions and cannot be applied via code:

| Action | Where | Priority |
|---|---|---|
| Enable Secret Push Protection | Settings → Security & Compliance | 🔴 Critical |
| Assign SOC 2 Compliance Framework | Group Settings → Compliance | 🟡 High |
| Add Scan Result Policy (block Critical vulns on merge) | Security & Compliance → Policies | 🟡 High |
| Require 1 MR approval (Security team) | Settings → Merge Requests | 🟡 High |
| Enable Container Registry cleanup policy | Settings → Packages & Registries | 🟠 Medium |

See the full review in the MR description for details on each.

---

## Base-Image Refresh Cadence & Automated Updates (issue #2, task 4.3)

**What changed:** Two mechanisms keep the base image and dependencies current between code
changes, closing the gap where prod's `node:22-alpine` base could drift and accumulate new
CVEs undetected.

**1. Weekly base-image rescan (scheduled pipeline).** A pipeline schedule with no extra
variables rebuilds the image on the current `main` and re-runs the full scanner suite
(SAST / dependency / secret / container). New base or dependency CVEs surface in the
Vulnerability Report and MR security widget on a cadence, not only when code changes.
The `deploy_production` job is guarded (`$CI_PIPELINE_SOURCE == "schedule"` → `never`), so a
rescan **never** rolls prod — it only detects.

**2. Self-hosted Renovate (scheduled pipeline).** A second schedule sets `RENOVATE_RUN=true`,
which runs only the `renovate` job (`renovate/renovate` image). Renovate opens update MRs for
npm dependencies and the Docker/CI base image, using `config:best-practices` (pins Docker
digests, enforces a minimum release age, weekly lockfile maintenance). Config lives in-repo at
`renovate.json`. Patch / minor / digest / pin updates **automerge** once the MR pipeline
passes (`platformAutomerge`); majors always require manual review. Security-advisory-driven
bumps (`vulnerabilityAlerts`) are labelled but **not** automerged — a human reviews those.
Base bumps reach prod the normal way: Renovate MR → merge to `main` → push pipeline →
`deploy_production`.

**Automerge safety — the real vuln gate is the Scan Result Policy (task 4.2).** On MR
pipelines the scanners are *required* jobs (`allow_failure: false`), so a scanner that can't
execute blocks the merge — but a scanner finding a new vulnerability still exits 0; it does
not fail the job. Blocking a merge on *new Critical/High findings* is done by a Scan Result
Policy, which is task 4.2. **Enable the Scan Result Policy before turning the "Weekly
Renovate" schedule on**, otherwise automerge is gated only on scanner *execution*, not on
findings.

**Why:** A floating tag + `apk upgrade` only refreshes on rebuild; without a cadence, a
long-lived `main` can run an increasingly stale base. Rescan gives detection; Renovate gives
automated remediation, both gated by the existing scanners.

**Compliance:** SLSA / supply-chain (pinned digests), CIS Docker Benchmark, SOC 2 CC7.1.

### Setup required (GitLab UI/admin — cannot be applied via code)

| Action | Where |
|---|---|
| Create `RENOVATE_TOKEN` CI/CD variable, **Protected + Masked**: Project/Group Access Token with `api` scope + **Maintainer** role (merge rights needed for automerge). Protected means only protected refs/schedules (main) can read it. | Settings → CI/CD → Variables |
| Schedule **"Weekly base-image rescan"** (e.g. `0 6 * * 1`), target `main`, no variables | Settings → CI/CD → Pipeline schedules |
| Schedule **"Weekly Renovate"** (e.g. `0 7 * * 1`), target `main`, variable `RENOVATE_RUN=true`. **Turn this on only after the Scan Result Policy (task 4.2) is live** — see automerge-safety note above. | Settings → CI/CD → Pipeline schedules |
