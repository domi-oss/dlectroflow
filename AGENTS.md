<!-- BEGIN:nextjs-agent-rules -->
# Next.js version reference

This project uses Next.js 16. Version-matched documentation ships with the
dependency at `node_modules/next/dist/docs/` and is the accurate reference for
this version's APIs, conventions and file structure.

It is the source of truth here, not a supplementary reference: framework code in
this repo is written against those docs rather than against recalled API shapes,
and it is read first rather than after something behaves unexpectedly. Its
deprecation notices are binding — an API the docs mark deprecated does not appear
in new code, and that is the part most often lost by working from memory, because
a deprecated API usually still runs.

<!-- END:nextjs-agent-rules -->

## Security assessment prompt

The repository keeps a security-assessment prompt at
`.gitlab/duo/prompts/security-assessment.md`. It is **the prompt this project uses
for a whole-project security assessment**, and a whole-project assessment here runs
from it rather than from an improvised checklist — that is what keeps successive
assessments comparable to each other. A security review of a single change is
ordinary code review and does not use it.

It covers vulnerability triage, secrets hygiene, least privilege, supply chain
security, container security, frontend security, compliance posture, license
review, GitLab platform configuration, incident response readiness and security
program cadence. Its output format is an actionable work plan with prioritized
work items, quick wins, agent automation opportunities and a security debt
register.
