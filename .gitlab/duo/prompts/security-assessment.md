# Security Assessment Prompt

> Perform a comprehensive application security assessment of the **dlectroflow** project (`gl-demo-ultimate-dtop/domi-oss/dlectroflow`). Cover the following areas:
>
> 1. **Vulnerability Report Analysis** — Retrieve all active vulnerabilities (DETECTED and CONFIRMED states only) for this project. Triage and prioritize by exploitability using EPSS scores, KEV status, and reachability data where applicable. Group by scanner type (SAST, Dependency Scanning, Container Scanning, Secret Detection, DAST).
>
> > ℹ️ **Note:** The project path referenced in this prompt (`gl-demo-ultimate-dtop/domi-oss/dlectroflow`) is specific to this repository. If reusing this prompt in another project, update the path accordingly.
>
> 2. **Risk Prioritization** — Rank findings by real-world exploitability: CVSS severity, EPSS score, KEV status, and reachable code paths in production. Separate signal from noise.
>
> 3. **Secrets & Credential Hygiene** — Identify hardcoded secrets, insecure CI/CD variable usage, `.env` file exposure, and secret sprawl across environments. Flag any detected secrets that have not been rotated. Audit deploy keys, access tokens, and webhook endpoint trust.
>
> 4. **Principle of Least Privilege** — Review codebase, CI/CD configuration, container setup, and GitLab project settings for overly permissive roles, broad API scopes, non-root container enforcement, and misconfigured IAM/RBAC patterns.
>
> 5. **Supply Chain & Dependency Security** — Audit dependency hygiene: vulnerable packages, unpinned versions (`*`, `^` ranges), missing or uncommitted lock files, unmaintained libraries, and absence of an automated dependency update strategy (e.g., Renovate, Dependabot).
>
> 6. **Container & Runtime Security** — Evaluate `docker/Dockerfile` and `docker/Dockerfile.ci` for base image pinning, use of minimal/distroless images, non-root user enforcement, read-only filesystem, and defined resource limits. Flag any `latest` tag usage.
>
> 7. **Frontend Security** (TypeScript/React) — Check for `dangerouslySetInnerHTML` usage, missing HTTP security headers (`CSP`, `HSTS`, `X-Frame-Options`, `X-Content-Type-Options`), insecure token storage (e.g., `localStorage` for sensitive data), Subresource Integrity (SRI) for external assets, and input validation on externally ingested data.
>
> 8. **Authentication & Session Security** — Review auth mechanism (JWT, OAuth, session cookies), token expiry and refresh logic, MFA enforcement at the GitLab group/project level, and API key scoping for third-party integrations.
>
> 9. **GitLab Platform Security Configuration** — Audit branch protection rules, required MR approvals, Scan Result Policies, Audit Event logging, and whether security scan results are enforced as merge gates. Flag any ability to push directly to `main` bypassing pipeline checks.
>
> 10. **Compliance Posture** — Assess alignment with OWASP Top 10, SOC 2, GDPR (if PII is handled), and PCI-DSS (if payment flows exist). Flag data classification gaps, unencrypted sensitive data, and insecure logging practices (e.g., PII in logs).
>
> 11. **Open Source License Review** — Check for a LICENSE file. If missing, review dependency licenses (MIT, Apache 2.0, GPL/AGPL variants) and recommend the most appropriate license. Flag any copyleft obligations or license compatibility conflicts.
>
> 12. **GitLab Scanner Coverage** — Verify SAST, Dependency Scanning, Container Scanning, Secret Detection, and DAST are correctly configured in `.gitlab-ci.yml`. Identify any scanning gaps or misconfigurations.
>
> 13. **Incident Response Readiness** — Assess whether there is a defined process for Critical vulnerability discovery in production: notification path, response SLA, escalation vs. auto-remediation boundaries, and agent-actionable runbooks.
>
> 14. **Security Program Cadence** — Recommend a sustainable cadence for a 1+ engineer team augmented by AI agents:
>    - **Daily/Per-commit**: Fully agent-led — automated triage, secret detection, SAST gating on MRs
>    - **Weekly**: Agent-surfaced digest, human reviews and approves key decisions
>    - **Monthly**: Agent-compiled report, human interprets and prioritizes; license and compliance check
>    - **Quarterly**: Human-led — threat modeling, penetration testing scope, security roadmap refresh, policy review
>    - **Agent delegation model**: Clearly map what is fully delegated to agents, what requires human-in-the-loop approval, and what must remain human-led.
>
> **Present all findings as an actionable work plan**, structured as follows:
>
> - **Executive Summary** — 3–5 sentence overall security posture assessment. Current state, biggest risks, and top priorities.
>
> - **Work Plan** — For every finding, produce a work item containing:
>   - 📋 **Title** — Short, action-oriented (e.g., *"Rotate exposed API key in CI/CD pipeline"*)
>   - 🎯 **Priority** — 🔴 Immediate / 🟠 Scheduled / 🟡 Monitor / ✅ No action required
>   - 📁 **Category** — Which assessment area it belongs to (e.g., Secrets, Container Security, Compliance)
>   - 🔍 **Finding** — What was found and why it matters, with business impact context
>   - 🛠️ **Action** — Specific, concrete steps to remediate or mitigate
>   - 👤 **Owner** — Human, Agent, or Human-in-the-loop (agent executes, human approves)
>   - ⏱️ **Effort** — 🟢 Low / 🟡 Medium / 🔴 High
>   - 🔗 **References** — Relevant CVE, CWE, OWASP category, or GitLab documentation link
>
> - **Quick Wins** — Call out any findings that are 🔴 Immediate priority AND 🟢 Low effort — these should be done first.
>
> - **Agent Automation Opportunities** — List all work items where an AI agent can own or accelerate the remediation, and suggest which to automate first.
>
> - **Security Debt Register** — A running log of accepted risks and deferred items with rationale, so nothing is silently forgotten.
>
> **📌 Work Item Requirement:** Whenever assessment findings are presented, **always create a GitLab work item (issue) in the assessed project (the project path referenced in area 1) containing the full findings** — including the executive summary, severity breakdown, active vulnerabilities, and recommendations. Use a title in the format `Security Assessment — YYYY-MM-DD[: <headline>]`, where the optional headline is a short summary of the key finding (e.g., `Security Assessment — 2026-07-05: 1 active vulnerability`). This ensures every assessment leaves a durable, trackable record for follow-up and audit purposes. Label the work item with `security` and `security-assessment`, and add any directly related vulnerability reports or issues as [related issues](https://docs.gitlab.com/ee/user/project/issues/related_issues.html).

## Usage

To invoke this assessment, say:

```
Run the security assessment prompt from .gitlab/duo/prompts/security-assessment.md
```

Agents are pointed to this prompt via the `## Security Assessment` section in `AGENTS.md`. The prompt is self-contained and can be run on demand or scheduled as part of the security program cadence defined within it.

> ⚠️ **Portability note:** The project path `gl-demo-ultimate-dtop/domi-oss/dlectroflow` is hardcoded in area 1. Update it if reusing this prompt across repositories.

## Maintenance

| Field | Detail |
|---|---|
| **Owner** | Security / Engineering Lead |
| **Review cadence** | Quarterly (or after significant architecture changes) |
| **Last updated** | 2026-07-05 |
| **Version** | 1.1.0 |
