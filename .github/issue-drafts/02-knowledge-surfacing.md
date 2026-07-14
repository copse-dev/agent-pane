## Problem

The knowledge store (`~/.copse/knowledge/`) holds durable project notes — memories and roadmap items — but the agent only sees them when it explicitly calls `recall` or `roadmap_plan list`. Relevant tribal knowledge does not surface at prompt time, and there is no unified browse/edit surface beyond the experimental Memories and Roadmap panes.

Phase 3 of the knowledge-store plan (`docs/plans/knowledge-store.md`) is not built yet.

## Proposal

**Surfacing layer** on top of the existing OKF knowledge store (#645):

1. **Prompt injector** — when the user sends a message, automatically attach a small, relevant subset of knowledge notes to the prompt (no tool call required). Use title/tags/body keyword match first; optional small-tasks model triage to pick which notes "land".
2. **Unified knowledge panel** — sidebar over all note types (`Memory`, `Roadmap`, later `Doc`), mirroring `todo-panel.ts`: list, filter by type, inline edit, delete.
3. **Status badges** — show which notes were injected on the last turn (debuggability / trust).

Keep distinct tool verbs (`remember`, `roadmap_plan`) — surfacing is read-path only.

## Out of scope

- New storage format (files + `index.jsonl` stay as-is).
- Renaming "memories" → "knowledge" in settings/UI (defer until surfacing ships).

## Acceptance criteria

- Sending a prompt with a matching memory note causes that note to appear in the injected context without `recall`.
- Knowledge panel lists memories and roadmap items from one store.
- Surfacing respects experimental flags (`okfMemoriesEnabled`, `roadmapPlansEnabled`) — inert when off.
- Unit tests for match/triage logic; component test for panel list.

## Related

- #645 — knowledge store foundation
- `docs/plans/knowledge-store.md` (Phase 3)
- `src/main/services/storage/knowledge-store.ts`
- `src/renderer/views/roadmap-pane.ts`, Memories pane
