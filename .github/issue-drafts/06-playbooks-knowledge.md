## Problem

Skills (`/skill-name`) are reusable prompts but live as files in `.cursor/skills` etc. — no lifecycle, no project-scoped versioning in the knowledge store, and no "run this workflow when X" trigger beyond manual slash invocation.

Roadmap items hold *future intent*; memories hold *facts*; neither is a structured *procedure* the agent can attach to a session.

## Proposal

Add a **`Playbook` knowledge type** — OKF notes under `~/.copse/knowledge/<workspace>/playbook/<uuid>.md`.

### Note shape

```yaml
---
type: Playbook
id: <uuid>
title: REST-to-GraphQL migration
tags: [migration, api]
trigger: manual   # manual | on-issue | on-schedule (later)
---
## Procedure
1. …
## Specifications
- …
## Advice
- …
```

Body holds procedure, specs, and advice (same structure as successful session exports).

### Agent surface

- `playbook list` / `playbook attach <id>` — load playbook into system context for the thread.
- Create from thread: "turn this session into a playbook" → extracts procedure from transcript (small-tasks model).
- Slash alias: `/playbook-<slug>` generated from title.

### UI

- Playbooks section in knowledge panel.
- "Attach playbook" picker when starting a thread (optional).

## Relationship to skills

- Skills remain for Cursor-plugin / repo-file workflows.
- Playbooks are *project-authored procedures* in the knowledge store; can reference skills via `read_skill`.

## Out of scope

- Org-wide playbook sharing (local per workspace for now).
- Automation triggers (webhook/cron) — depends on cloud runner design.

## Acceptance criteria

- Playbook CRUD via tool + knowledge panel.
- Attaching a playbook injects its body into the thread system prompt.
- "Create from session" produces a valid Playbook note from a seeded transcript.
- Tests for store round-trip and attach injection.

## Related

- #645 — knowledge store
- `src/main/tools/skill-tools.ts` (`read_skill`)
- `.cursor/skills/` layout
