/**
 * Refuse Claude Code's own sandbox escape inside Copse's sandbox (#4146).
 *
 * Claude Code's Bash tool takes `dangerouslyDisableSandbox: true` to run one
 * command outside Claude Code's own sandbox. Under Copse that escape cannot do
 * anything: Copse's seatbelt wraps the whole agent process, so the command runs
 * in the same sandbox and fails with the same `Operation not permitted`. The
 * agent cannot tell that from an ordinary sandboxed failure, so it retries.
 *
 * Copse therefore hands a sandboxed Claude agent one `PreToolUse` command hook
 * in Claude Code's flag settings (`session/new` `_meta.claudeCode.options.settings`).
 * When a Bash call asks for the escape, the hook exits 2 and Claude Code returns
 * its stderr to the model as the tool result: an explicit refusal that names
 * Copse's sandbox and says which tool can run the command outside it.
 *
 * The hook only refuses. It runs inside the agent's sandbox like any other
 * child of the agent, it never lets anything run that would not otherwise run,
 * and a command without the escape is untouched.
 *
 * `sandbox.allowUnsandboxedCommands: false` is deliberately not used: Claude
 * Code then ignores the parameter silently, which is the failure this exists to
 * explain.
 *
 * A leaf module with no imports, like `acp-bridge-name.ts`: `acp-client.ts` is
 * bundled as a standalone script for the out-of-process probe worker.
 */

/** The Claude Code Bash parameter that asks for one command outside its sandbox. */
export const CLAUDE_SANDBOX_ESCAPE_PARAM = 'dangerouslyDisableSandbox'

/**
 * The refusal the agent reads in place of the command's output. `bridgeMounted`
 * says whether this session mounted Copse's native-tool bridge, the only Copse
 * route to a command outside the sandbox. A session that has the bridge may
 * still lose it (#4144), so that copy says what to do then too.
 */
export function claudeSandboxEscapeRefusal(bridgeMounted: boolean): string {
  const lead =
    `Copse refused this command: ${CLAUDE_SANDBOX_ESCAPE_PARAM} has no effect here. ` +
    "This whole Claude Code process runs inside Copse's sandbox, not just its commands, " +
    'so the command would run in that same sandbox and fail the same way. Approval ' +
    'cannot unsandbox this shell.'
  const route = bridgeMounted
    ? 'To run a command outside the sandbox, call the run_shell tool of the "copse" MCP ' +
      'server (mcp__copse__run_shell) with expects_sandbox_block: true; Copse can then ask ' +
      'the user to approve running it outside the sandbox. If no mcp__copse__ tools are in ' +
      "your tool list, Copse's tool bridge is not available in this session: tell the user " +
      'what needs to run outside the sandbox instead of retrying.'
    : 'Copse\'s tool bridge (the "copse" MCP server and its run_shell tool) is not available ' +
      'in this session, so no tool here can run a command outside the sandbox. Tell the user ' +
      'what needs to run outside it instead of retrying.'
  return `${lead} ${route} A command that works inside the sandbox can be retried without ${CLAUDE_SANDBOX_ESCAPE_PARAM}.`
}

/** POSIX single quoting: the value is one literal word whatever it contains. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Extended regex for the escape set to `true` in the hook's stdin JSON. The
 * leading class keeps a JSON-escaped copy inside a string (a command line that
 * merely mentions `"dangerouslyDisableSandbox": true`) from matching, since
 * there the quote is preceded by a backslash.
 */
const ESCAPE_REQUESTED_ERE = `(^|[^\\\\])"${CLAUDE_SANDBOX_ESCAPE_PARAM}"[[:space:]]*:[[:space:]]*true`

/**
 * The hook's shell command. It drains stdin first, so Claude Code's write never
 * meets a closed pipe, then refuses with exit 2 (Claude Code's "block and show
 * stderr to the model") only when the escape was asked for. Plain `sh`, `cat`,
 * `printf` and `grep`: the hook runs inside the agent's sandbox, on macOS or Linux.
 */
export function claudeSandboxEscapeHookCommand(bridgeMounted: boolean): string {
  return (
    'input=$(cat); ' +
    `if printf '%s' "$input" | grep -Eq ${singleQuote(ESCAPE_REQUESTED_ERE)}; then ` +
    `printf '%s\\n' ${singleQuote(claudeSandboxEscapeRefusal(bridgeMounted))} >&2; exit 2; fi`
  )
}

/** Seconds Claude Code waits for the hook; it does no more than one grep. */
const HOOK_TIMEOUT_SECONDS = 10

/**
 * `_meta` for `session/new`, `session/resume` and `session/load`: Claude Code
 * flag settings carrying the refusal hook. The adapter re-reads `_meta` on
 * every one of them, and a resumed session must keep the hook.
 */
export function claudeSandboxEscapeSessionMeta(bridgeMounted: boolean): {
  claudeCode: { options: { settings: Record<string, unknown> } }
} {
  return {
    claudeCode: {
      options: {
        settings: {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: claudeSandboxEscapeHookCommand(bridgeMounted),
                    timeout: HOOK_TIMEOUT_SECONDS,
                  },
                ],
              },
            ],
          },
        },
      },
    },
  }
}
