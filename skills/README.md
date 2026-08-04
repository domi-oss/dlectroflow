# `skills/` — GitLab Duo agent skills

Skills GitLab Duo can load and invoke against this repository. Duo discovers project-level
skills at `skills/<skill-name>/SKILL.md`; `/skills` lists what is available, and each skill
here sets `metadata: slash-command: enabled` so it can also be called directly as
`/<skill-name>`.

| Skill | What it does |
|---|---|
| [`antivibe`](antivibe/SKILL.md) | Explains code so you learn from it — what it does, why it was built that way, what the alternatives were. Writes to `deep-dive/`. |
| [`antivibe-audit`](antivibe-audit/SKILL.md) | Architectural audit for an experienced reader — trade-offs, flags, failure modes, testability. 500 words, no tutorials. |

Both are adapted from [AntiVibe](https://github.com/mohi-devhub/antivibe) by M Mohith, MIT
licensed. Each directory carries its own `LICENSE`; **that file must stay** — it is the
condition on which the code is reusable. Each `SKILL.md` ends with an attribution section
recording exactly what was changed in adapting it for Duo and why, so the divergence from
upstream stays legible rather than becoming folklore.

## Adding a skill

1. `skills/<name>/SKILL.md`, with YAML frontmatter carrying `name` and `description`.
   Optionally `metadata: slash-command: enabled` to expose `/<name>`.
2. **The `description` is the whole discovery mechanism.** Duo matches a task against it,
   so it has to contain the vocabulary someone would actually use. There is no separate
   trigger-phrases field — a skill with a terse description will not be found.
3. Say in the description when *not* to use it, and name the skill that should be used
   instead. Two skills with overlapping descriptions is how you get the wrong one invoked.

## Keep this directory documentation-only

`skills/` is listed in `DOCS_ONLY_PATHS` in `src/lib/ci-docs-only.ts`, which means an MR
touching only this directory takes the docs-only CI fast path and skips the compile, test,
image-build and scanning jobs.

That classification is only honest while everything here is prose. **Adding an executable —
a shell script, a hook, anything CI or a developer would run — means moving `skills/**/*`
into `.code_changes` in `.gitlab-ci.yml` in the same change**, or it ships unscanned with no
signal at all. That is precisely the failure mode `ci-docs-only.ts` exists to catch, and it
is why upstream AntiVibe's four optional helper scripts were deliberately not carried over.
