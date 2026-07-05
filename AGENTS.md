<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Security Assessment

When asked to perform a security review or security assessment, agents are pointed to the prompt defined in `.gitlab/duo/prompts/security-assessment.md` via this AGENTS.md reference.

This prompt covers: vulnerability triage, secrets hygiene, least privilege, supply chain security, container security, frontend security, compliance posture, license review, GitLab platform configuration, incident response readiness, and security program cadence.

The output should always be presented as an actionable work plan with prioritized work items, quick wins, agent automation opportunities, and a security debt register.
