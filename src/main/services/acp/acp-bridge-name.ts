import { randomInt } from 'node:crypto'

/**
 * The stem of the MCP server name Copse gives its native-tool bridge when it
 * hands the bridge to the external agent in `session/new` `mcpServers`. Each
 * bridge is mounted as `copse-<nonce>` ({@link newBridgeServerName}), never as
 * the bare stem: an MCP config the agent reads for itself (`~/.claude.json`,
 * a repository's `.mcp.json`, a plugin manifest) can define a server named
 * `copse`, and its tools would then carry the same adapter-authored names as
 * Copse's own (#4125). No static config can name a server it cannot predict.
 *
 * The agent prefixes bridged tool calls with the server name (e.g. Cursor
 * titles a call `copse-k3v9x2mq-gh_pr_list: gh_pr_list`), which is how the
 * agent-eval harness and the transcript's display recognise Copse's tools.
 * Permission decisions do not use this prefix match: they match the session's
 * exact server name (`acp-tool-provenance.ts`).
 *
 * A leaf module of its own so importing the *name* does not drag in the bridge
 * implementation — whose transitive graph reaches `spawn.ts` and therefore
 * `node-pty`. `acp-client.ts` needs only these, and must stay bundleable as a
 * standalone script for the out-of-process probe worker.
 */
export const BRIDGE_MCP_SERVER_NAME = 'copse'

const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const NONCE_LENGTH = 8

/**
 * A fresh, unguessable server name for one bridge: `copse-` and eight random
 * lowercase letters or digits (about 41 bits). Lowercase ASCII and one hyphen
 * survive every adapter's server-name rules and never contain the `__` that
 * splits Claude's `mcp__<server>__<tool>`.
 */
export function newBridgeServerName(): string {
  const nonce = Array.from({ length: NONCE_LENGTH }, () =>
    NONCE_ALPHABET.charAt(randomInt(NONCE_ALPHABET.length)),
  ).join('')
  return `${BRIDGE_MCP_SERVER_NAME}-${nonce}`
}

/**
 * The server-name pattern display code accepts as Copse's bridge: the bare stem
 * (threads recorded before #4125) or a nonce name. Display only: it says what a
 * transcript row looks like, never whether a call reached Copse's bridge.
 */
export const BRIDGE_SERVER_NAME_PATTERN = `${BRIDGE_MCP_SERVER_NAME}(?:-[a-z0-9]{${String(NONCE_LENGTH)}})?`

/** `text` as a literal inside a regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`)
}

/**
 * Whether `text` names the bridged tool `tool`, anchored at the *start* of the
 * text: an optional `mcp` prefix, the bridge server name (`copse`, or a nonce
 * name such as `copse-k3v9x2mq`), a separator, then the tool name. All three
 * observed shapes match:
 *
 * - `copse-k3v9x2mq-gh_pr_list: gh_pr_list` — Cursor, server name leading.
 * - `mcp__copse-k3v9x2mq__gh_pr_view` — Claude, server name *infixed* under
 *   the conventional `mcp__` prefix.
 * - `mcp.copse-k3v9x2mq.gh_pr_view` — Codex, dot-joined.
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
 * Used by the agent-eval harness scoring which tools an agent chose: a
 * scenario naming `gh_pr_view` has to match the namespaced form an ACP agent
 * actually emits, or the expectation silently never fires. It is display-text
 * matching and must not authorize anything: a title that starts with a bridged
 * name can still carry model-chosen text after it (#1446).
 */
export function matchesBridgedToolName(text: string, tool: string): boolean {
  return new RegExp(
    `^(?:mcp[^a-z0-9]+)?${BRIDGE_SERVER_NAME_PATTERN}[^a-z0-9]+${escapeRegex(tool)}(?![a-z0-9_])`,
    'i',
  ).test(text)
}
