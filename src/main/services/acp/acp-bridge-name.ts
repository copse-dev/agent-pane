/**
 * The MCP server name Copse assigns its native-tool bridge when handing it to
 * the external agent in `session/new` `mcpServers`. The agent prefixes bridged
 * tool calls with it (e.g. Cursor titles a call `copse-gh_pr_list: gh_pr_list`),
 * which is how the client recognises its own tools in a permission request.
 *
 * A leaf module of its own so importing the *name* does not drag in the bridge
 * implementation — whose transitive graph reaches `spawn.ts` and therefore
 * `node-pty`. `acp-client.ts` needs only this constant, and must stay bundleable
 * as a standalone script for the out-of-process probe worker.
 */
export const BRIDGE_MCP_SERVER_NAME = 'copse'

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`)
}

/**
 * Whether `text` names the bridged tool `tool`, anchored at the *start* of the
 * text: an optional `mcp` prefix, the bridge server name (`copse`), a
 * separator, then the tool name. All three observed shapes match:
 *
 * - `copse-gh_pr_list: gh_pr_list` — Cursor, server name leading.
 * - `mcp__copse__gh_pr_view` — Claude, server name *infixed* under the
 *   conventional `mcp__` prefix.
 * - `mcp.copse.gh_pr_view` — Codex, dot-joined.
 *
 * Claude's shape was missed until a wire trace (#1659) showed it: `^copse`
 * cannot match a title starting `mcp__`, so every bridged call under Claude fell
 * through to a duplicate permission prompt. The optional prefix is the literal
 * `mcp` rather than "any leading token" on purpose; see the anchoring note
 * below.
 *
 * Anchoring — rather than searching anywhere in the text — matters because
 * `copse` is a common token in this very repo: a prose title like
 * `Edit copse-gh_pr_list-notes.md` must not be mistaken for a bridged call.
 * Admitting an arbitrary leading word would reopen exactly that, since
 * `Run copse gh_pr_list now` would then match. The separator is any run of
 * non-alphanumeric joiners (the inherent shape of `server<sep>tool`) rather than
 * hard-coded to `-`, so an agent that joins with `/`, `_`, `.`, or `__` still
 * matches; text in some entirely different shape just falls through.
 *
 * Shared by two callers that must agree on what counts as a bridged call: the
 * permission gate that auto-approves Copse's own tools, and the agent-eval
 * harness scoring which tools an agent chose. A scenario naming `gh_pr_view`
 * has to match the namespaced form an ACP agent actually emits, or the
 * expectation silently never fires.
 */
export function matchesBridgedToolName(text: string, tool: string): boolean {
  return new RegExp(
    `^(?:mcp[^a-z0-9]+)?${BRIDGE_MCP_SERVER_NAME}[^a-z0-9]+${escapeRegex(tool)}(?![a-z0-9_])`,
    'i',
  ).test(text)
}
