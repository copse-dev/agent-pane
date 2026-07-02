# ACP client lacks native Copse tool parity; Fable prefers `run_shell` over structured tools

**Type:** bug / UX gap  
**Area:** ACP client, agent loop, tool registry, model behavior (Fable)  
**Reported:** 2026-07-02

## Summary

When comparing **ACP agents** (e.g. `acp:claude-code-acp`, `acp:cursor`) to **native Copse models** (e.g. `claude-fable-5`), the tool surface is **not the same**. This is partly by design, but it is easy to miss and shows up in practice as the model “not picking up many tools” and **defaulting to CLI/shell** (`run_shell`, or the external agent’s Bash tool) instead of Copse’s structured tools (`explore`, `read_file`, `search_codebase`, `staged_diffs`, MCP, etc.).

Re-validated on `main` (2026-07-02) with **CLI** (shell commands), not CI investigation tools.

## Expected vs actual

| Path | Expected (user mental model) | Actual |
|------|------------------------------|--------|
| Native `claude-fable-5` | Full Copse tool registry (reads, edits, git, shell, browser, …) | Registry is filtered: with default `subagentsEnabled: true`, parent hides `read_file` / `list_dir` / `search_*` / `find_files` and exposes `explore` instead. Model may bypass `explore` and use `run_shell` (`cat`, `grep`, `find`, …). |
| ACP client (`acp:*`) | Same Copse tools as native | **Different tool loop entirely.** Copse only backs `fs/read_text_file`, `fs/write_text_file`, and `session/request_permission`. The external agent runs its own tools (Claude Code Bash/Read/Edit, Cursor tools, etc.). MCP servers are **not** forwarded (`docs/acp-agents.md`). |
| `copse --acp` (server) | N/A | Uses the **full** native Copse loop (`acp-app-entry.ts` → `runAgent` + `createRegistry`). This is the opposite direction from ACP client mode. |

## Validated tool inventory (native Copse)

From `registry-bootstrap.ts` + `agent-service.ts` `parentTools()`:

**Always registered (typical dev machine, `gh` unavailable):**  
`read_file`, `write_file`, `str_replace`, `staged_diffs`, `read_staged_diff`, file ops, search tools, git tools, `run_shell`, `explore`, web tools, browser tools (6), `update_todos`, `ask_user`, optional skills/MCP.

**With authenticated `gh`:** adds `gh_pr_*`, `get_ci_status`, `wait_for_ci_checks`, `get_ci_failure_logs`.

**With `subagentsEnabled: true` (default, not exposed in Settings UI):** parent turn **removes**  
`read_file`, `list_dir`, `search_code`, `search_codebase`, `find_files`  
and keeps **`explore`** as the only read/search entry point (`PARENT_DELEGATED_TOOLS` in `agent-service.ts`).

**ACP client mode:** none of the above are offered to the external agent’s model through Copse. Copse implements ACP client callbacks only; the spawned agent owns tool planning (`docs/plans/acp-client-support.md` § “Native tools in ACP mode”).

## Why Fable “prefers CLI”

1. **Subagent indirection (default on):** Parent cannot call granular read/search tools; it must use `explore` or fall back to **`run_shell`**. Weaker tool routers (including some fast models) often choose shell (`cat`, `grep`, `rg`, `find`) over `explore`.
2. **Prompt steering is asymmetric:** `agent-prompt.ts` tells the model to use `run_shell` for validation and `gh_*` “prefer over run_shell + gh”, but there is no equally strong rule steering **file reads/searches away from `run_shell`** toward `explore` / structured tools.
3. **`explore` depends on subagent routing:** For cloud models, `explore`/`investigate_ci` delegate to LM Studio when `localSubagentsEnabled` is on. If no local subagent is available, the parent model runs the subagent itself — which may perform poorly on Fable.
4. **ACP comparison is apples-to-oranges:** An ACP adapter (Claude Code, Cursor) exposes **shell-first** tools by design. Native Fable in Copse may look “CLI-heavy” in comparison even when structured tools exist.

## Reproduction hints

1. Open a workspace; pick native **`claude-fable-5`** (not `acp:*`).
2. Ask: “Find where `decideShellPermission` is defined and summarize it.”
3. Observe tool cards: often **`Run command`** (`run_shell` with `grep`/`cat`) instead of **`Explore`** or read/search tools.
4. Compare with **`acp:claude-code-acp`** (or Cursor ACP): tool names differ entirely (external agent’s Bash/Read/Edit), and Copse MCP/skills/browser tools are absent.

## Proposed follow-ups

- [ ] **Document tool parity** prominently in `docs/acp-agents.md` (native vs ACP client vs `copse --acp`) with a side-by-side tool table.
- [ ] **Settings UI:** expose `subagentsEnabled` toggle (schema exists; only seedable today) so users can restore direct `read_file` / `search_*` on the parent model.
- [ ] **Prompt steering:** add explicit “do not use `run_shell` for file reads or codebase search; use `explore` or read/search tools” guidance in `agent-prompt.ts`.
- [ ] **Eval:** agent-run eval comparing Fable vs Sonnet tool-choice rates (`explore` vs `run_shell` vs direct reads) with subagents on/off.
- [ ] **ACP (optional, larger):** forward MCP servers or expose a curated native-tool bridge — tracked partially in #264 / `docs/plans/acp-client-support.md`.

## References

- `src/main/services/agent-service.ts` — `parentTools()`, ACP routing at `acp:<id>`
- `src/main/services/registry-bootstrap.ts` — tool registration gates
- `src/main/services/agent-prompt.ts` — system prompt tool list
- `src/main/services/acp/acp-app-entry.ts` — full native loop for `copse --acp`
- `docs/acp-agents.md` — limitations (no MCP forwarding, no terminals)
- `docs/plans/acp-client-support.md` — “Native tools in ACP mode: Disabled”
