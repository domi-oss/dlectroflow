---
name: antivibe
description: Explain code to learn from it, not just accept it. Produces a learning-focused deep dive of any code — AI-generated, legacy, or your own — covering what it does, why it was written this way, when the patterns apply, and what the alternatives are. Use when someone says deep dive, anti-vibecode, walk me through, explain this file, explain this codebase, explain what AI wrote, why did AI write this, analyze this module, or learn from this code. For an architectural audit aimed at an experienced developer rather than an explanation, use the antivibe-audit skill instead.
metadata:
  slash-command: enabled
---

# AntiVibe — code learning

Turn code into understanding. Every piece of code has concepts to teach; this skill
surfaces them instead of restating what the code already says.

Works on **any** codebase. It does not need recent git history and the code does not need
to be AI-generated.

**If the request is for an audit rather than an explanation — "audit this", "just the
trade-offs", "what should I worry about", "senior mode", "skip the basics" — stop and use
the `antivibe-audit` skill instead.** That is a different output contract, not a depth
setting on this one.

## What it produces

A markdown file in `deep-dive/`, named `[component]-[YYYY-MM-DD].md`.

| Section | `compact` (default) | `full` |
|---|:---:|:---:|
| **Overview** — what the code does and why it exists | ✅ | ✅ |
| **Key components / concepts** — patterns, algorithms, CS concepts | ✅ | ✅ |
| **Code walkthrough** — file-by-file, line-by-line | — | ✅ |
| **Learning resources** — curated docs, tutorials, videos | — | ✅ |
| **Related code** — other files in the codebase | — | ✅ |
| **Next steps** — exercises and deeper topics | — | ✅ |

## Configuration

These are defaults. Anything stated in the request overrides them.

### Output mode — default `compact`

`compact` keeps the token cost down: overview, one line per function or class, and
concepts as what + why only. **No line-by-line, no resources, no next steps, maximum 5
files.** If more than five files are in scope, summarise the extras in one line each and
offer to go deeper.

`full` adds the line-by-line walkthrough, prerequisites per concept, curated resources and
next steps, and drops the five-file limit. For very large inputs, split across several
deep-dive files rather than truncating.

Switch to full with: `full`, `full deep dive`, `include resources`, `show everything`.

### Explanation level — default `mid`

| Level | What to do |
|---|---|
| `junior` | Define every term. Use real-world analogies. Explain language features — what a decorator *is*. Full code snippets with inline comments. Assume no prior knowledge of the patterns used. |
| `mid` | Skip the basics; assume language features are known. Focus on design decisions and trade-offs, and why this approach over the alternatives. Brief code references only. |

Phrases that pick a level: *"explain for a junior"*, *"I'm new to this"*, *"explain
everything"* → `junior`. *"I know the basics"*, *"mid level"*, *"some context"* → `mid`.

**Apply the level consistently across the whole output**, not just the concept sections.

### Known concepts — the skip list

Concepts the reader already knows. Before writing a full explanation of any concept, check
this list. If it is on it, replace the explanation with a single line:

> `[Concept]` — skipped (marked as known). Used here to [one sentence on its role in *this*
> code].

Default list — edit it to match what you already know:

```yaml
known_concepts:
  - async/await
  - React hooks
  - REST APIs
```

## Workflow

### Step 1 — decide what to analyse

Use the **first** applicable mode:

1. **Explicit** — the request names files, a directory or a module. Use them directly; no
   git needed. *"explain `src/auth/`"*, *"walk me through `api/routes.py`"*.
2. **Recent** — no explicit target, the project is a git repo, and `git diff HEAD` has
   output. Use the changed files.
3. **Ask** — no explicit target and no usable diff (legacy project, no recent changes, not
   a git repo). **Ask which file, directory or module to analyse. Do not guess.**

### Step 2 — understand it

Per file: what it does, why it is built this way, and how it works internally. Note the key
functions, classes and modules, the design patterns in use, and any genuinely complex logic.

### Step 3 — identify and explain concepts

Look for design patterns, algorithms, data structures, language features and framework
patterns. For each one:

- **What it is** — plain language
- **Why it is used here** — the design rationale, not the definition
- **When to use it** — the contexts where it is the right call
- **Trade-offs** — what you give up by choosing it
- **Prerequisites** — 2–4 foundational concepts needed first, e.g. *"to understand JWT you
  need HTTP request/response, Base64 encoding, and cryptographic signing"*

`reference/language-patterns.md` lists the patterns worth looking for per language and
framework. Read it when the codebase is in a language you are pattern-matching loosely on.

### Step 4 — find resources — `full` mode only

**Skip this entirely in `compact` mode.** In `full`, curate official documentation, quality
tutorials or blog posts, video resources where genuinely good, and related concepts for
further study. `reference/resource-curation.md` sets the quality bar — apply it. Quality
links, not the first page of search results.

### Step 5 — write the output

Write to `deep-dive/[component]-[YYYY-MM-DD].md`. In `full` mode use
`templates/deep-dive.md`. In `compact` mode use this shape:

```markdown
# Deep Dive: [Component]

## Overview
[3–5 sentences: what this does and why it exists]

## Key Components
- `[FunctionOrClass]`: [one-line purpose]

## Concepts & Decisions
### [Concept]
- **What**: [1–2 sentences, plain language]
- **Why used here**: [1–2 sentences of design rationale]
```

Make it educational, not descriptive.

## Principles

1. **Why over what.** Always explain the design decision. If a line only restates the code,
   delete it.
2. **Context matters.** Say when a pattern is appropriate, not just that it was used.
3. **Show alternatives.** Never present a choice as the only option.
4. **Connect to fundamentals.** Link the code to the underlying CS concept.
5. **Curate.** Quality resources, not volume.
6. **Be Socratic.** Guide towards understanding rather than handing over conclusions.

## Constraints

- Do not summarise code — explain the reasoning behind it.
- Include real code snippets in explanations.
- Respect the `known_concepts` skip list.
- Give actionable next steps in `full` mode.

## Examples

| Request | Mode | Result |
|---|---|---|
| *"Explain the auth system the AI wrote"* | Recent (git diff) | `deep-dive/auth-system-2026-08-04.md` |
| *"Walk me through `src/payments/`"* | Explicit | Analyses that directory, no git needed |
| *"Deep dive"* on a legacy repo with no changes | Ask | Asks which module to analyse |
| *"Audit this, just the trade-offs"* | — | **Not this skill.** Use `antivibe-audit` |

---

## Attribution and provenance

Adapted from **AntiVibe** by M Mohith — <https://github.com/mohi-devhub/antivibe> — which
is MIT licensed. The licence text travels with this directory in `LICENSE` and must stay
there.

**What changed in adapting it for GitLab Duo, and why:**

- **The upstream `triggers:` frontmatter list is gone.** Duo's skill schema has only `name`
  and `description` plus optional `metadata`, and matches on the description. The trigger
  vocabulary was folded into the description rather than dropped, because those phrases were
  doing the discovery work.
- **`agents/explainer.md` was merged into this file, and `agents/auditor.md` became the
  separate `antivibe-audit` skill.** Upstream routes between them with *"if level = senior,
  route to `agents/auditor.md`"*, which relies on a subagent-dispatch mechanism Duo does not
  have — the route would have silently read as context and been ignored. Two skills also
  make the audit path discoverable on its own rather than hidden behind a level argument.
- **`hooks/hooks.json` was not carried over.** It configures `SubagentStop` and `Stop` hooks
  in a schema Duo has no equivalent for, so the auto-nudge after a feature lands does not
  exist here. This skill is invoked deliberately. That is a real capability difference, not
  an oversight.
- **`scripts/*.sh` were not carried over.** Upstream describes them as optional helpers and
  notes everything they do can be done by direct code analysis. Omitting them keeps this
  directory pure documentation, which is what lets it take the docs-only CI fast path —
  see `DOCS_ONLY_PATHS` in `src/lib/ci-docs-only.ts`. Adding an executable here means
  reclassifying the directory as code in `.gitlab-ci.yml` first.
