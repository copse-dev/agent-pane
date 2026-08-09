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
