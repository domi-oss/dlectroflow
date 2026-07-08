# Security Policy

dlectroflow is a single-maintainer, agent-augmented project that runs live at
https://dlectroflow.dlectronique.dev. This document defines how security issues
are reported and handled, and where the line sits between automated and
human-only remediation.

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

- Preferred: open a [confidential issue](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/issues/new)
  (check **This issue is confidential**) with steps to reproduce and impact.
- Alternatively, email the maintainer at the address on the GitLab profile.

Please include: affected URL/endpoint or file, a reproduction, and the impact
you believe it has. We do not run a paid bug-bounty program, but credible
reports are acknowledged and credited (with your consent).

## Supported versions

Only the currently deployed `main` (production) is supported. There are no
back-ported release branches.

| Version | Supported |
|---------|-----------|
| `main` (production) | ✅ |
| Any tag / older commit | ❌ |

## Response targets

| Severity | Triage | Fix or documented mitigation |
|----------|--------|------------------------------|
| Critical (exploitable in production) | 24 hours | 72 hours |
| High | 3 business days | 2 weeks |
| Medium / Low | Next assessment cycle | As capacity allows |

"Triage" means acknowledged, reproduced (or refuted), and severity confirmed.

## Automated vs. human-only remediation

This project delegates routine security work to agents, with a human retaining
authority over anything that changes trust boundaries or production state.

**Agents may perform autonomously (human approves the MR):**
- Dependency patch/minor/digest bumps (Renovate), gated behind required scanners.
- Drafting false-positive dismissal rationale for human confirmation.
- Scanner-config and CI hygiene changes.
- Weekly vulnerability digests from the base-image rescan schedule.

**Human-in-the-loop (agent proposes, human decides):**
- Vulnerability dismissals, severity changes, and risk acceptances.
- Any production configuration change.

**Human-only:**
- Cryptographic key or secret rotation.
- Production rollback / incident command.
- Repository visibility changes and security-policy edits.

## Handling a Critical-in-production discovery

1. **Contain** — if actively exploited, take the affected path offline
   (scale down, disable the route, or roll back to the last-known-good image tag).
2. **Rotate** — if any secret may be exposed, rotate it (see below) before
   restoring service.
3. **Fix** — land the patch through the normal MR + required-scanner pipeline.
4. **Verify** — confirm `/api/health` is 200 and the finding is resolved on the
   default-branch scan.
5. **Record** — note the timeline and root cause on the security assessment issue.

### Secret rotation note

Application secrets are injected via a Kubernetes Secret consumed with
`envFrom: secretRef`. Rotating a secret in CI/CD variables and re-deploying now
automatically rolls the pods (a `checksum/secret` annotation on the Deployment
pod template forces a rollout when the Secret changes), so rotated values take
effect without a manual `kubectl rollout restart`.

## Security program cadence

- **Per-commit (agent-gated):** SAST, Advanced SAST, Dependency Scanning,
  Secret Detection, and Container Scanning run as **required** MR jobs; a Scan
  Result Policy requires approval for any new Critical/High finding.
- **Weekly:** base-image rescan schedule; Renovate review.
- **Monthly:** security assessment re-run (per `.gitlab/duo/prompts/security-assessment.md`).
- **Quarterly:** threat-model refresh and policy review.
