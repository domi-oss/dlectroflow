# AppSec Hardening — July 2026

This document records the security improvements made in the `appsec/best-practices-hardening`
branch and the rationale behind each change. It serves as an audit trail for SOC 2 CC7.1
(change management) and OWASP ASVS compliance reviews.

## Changes

### 1. GitLab Security Scanners (`.gitlab-ci.yml`)

**What changed:** Added a `scan` stage with four GitLab-managed scanner templates:
- `Security/SAST.gitlab-ci.yml` — static analysis of TypeScript/JavaScript source
- `Security/Dependency-Scanning.gitlab-ci.yml` — npm advisory database checks against `package-lock.json`
- `Security/Secret-Detection.gitlab-ci.yml` — detects accidentally committed secrets
- `Security/Container-Scanning.gitlab-ci.yml` — CVE scan of the built Docker image

**Why:** The pipeline previously had zero security scanning. Vulnerabilities were accumulating
in the container image (150+ detected) with no automated detection on MRs.

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
- Belt-and-suspenders security headers at the ingress layer

**Why:** The ingress previously had no rate limiting or body size enforcement. The
application-layer guards (body size in route.ts, HSTS in next.config.ts) are the primary
controls; the ingress provides a defence-in-depth backstop that applies even if the
application fails to start.

**Compliance:** OWASP ASVS V13.2.6, CIS Kubernetes Benchmark 5.4

---

### 5. Container Image Slimming (`Dockerfile`)

**What changed:** Split the runtime stage to install **only** `openssl` (required by the
Prisma query engine binary). The previous `node:22-slim` runtime stage was pulling in
ImageMagick and a large media-processing dependency tree via transitive apt dependencies.

A dedicated `migrate` stage retains the full toolchain for the Kubernetes init container
that runs `prisma migrate deploy`.

**Why:** The container vulnerability report showed 140+ CVEs, almost all in ImageMagick,
binutils, HDF5, libraw, and related packages — none of which are used by a Next.js web app.
This change eliminates those packages from the runtime image entirely.

**Compliance:** CIS Docker Benchmark 4.3 (minimal base image), SOC 2 CC7.1

**Expected outcome:** Container CVE count drops from ~150 to <10 after this change.

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
