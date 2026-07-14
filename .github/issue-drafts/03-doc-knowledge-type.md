## Problem

Copse stores *authored* project knowledge (memories, roadmap prompts) but does not synthesize *repository documentation* — architecture overviews, module maps, or "how does X work?" pages grounded in the codebase. Users (and the agent) must re-discover structure on every new thread.

The semantic index and `explore` subagent help at query time, but durable, browsable doc notes would reduce repeated exploration and complement the knowledge store's memory/roadmap types.

## Proposal

Add a **`Doc` knowledge type** to the existing store (`~/.copse/knowledge/<workspace>/doc/<uuid>.md`), same OKF + `index.jsonl` substrate as `Memory` and `Roadmap`.

### Generation pipeline

- **On demand** (user or agent triggers "index docs" / "refresh architecture notes") or after major index rebuild.
- Walk semantic index + file tree; produce structured OKF notes: title, tags (`subsystem`, `entrypoint`, …), markdown body with links to source paths.
- Optional Mermaid diagrams in note bodies (renderer already supports Mermaid).
- **Steering file**: `.copse/wiki.json` at repo root — `repo_notes` and optional `pages[]` to force coverage of important areas on large repos (same idea as steering auto-doc on monorepos).

### Surfacing

- Browse in the knowledge panel (depends on knowledge surfacing issue).
- Inject relevant `Doc` notes at prompt time alongside memories.
- Agent tool: `refresh_docs` (or extend explore with a "write findings to Doc notes" path).

## Out of scope

- Public/hosted documentation portal.
- Replacing `AGENTS.md` / project rules ingestion.

## Acceptance criteria

- `Doc` notes persist under `doc/` with correct frontmatter (`type: Doc`).
- Generation produces at least one architecture overview + per-top-level-module notes on a medium repo.
- `.copse/wiki.json` `pages` override skips auto-cluster planning and creates specified pages.
- Notes are readable via `read_file` / knowledge panel.

## Related

- #645 — knowledge store
- Knowledge surfacing (prompt injector)
- `src/main/services/search/semantic-index.ts`
- `docs/plans/knowledge-store.md`
