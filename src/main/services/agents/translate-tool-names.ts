/**
 * Translate Claude Code tool names into Copse native tool names.
 *
 * A definition's tool list can only ever *narrow* what the parent turn could
 * already do: the result is intersected with the turn's tools, and every call
 * still goes through `ToolRegistry.execute` (permission gate, read-only
 * enforcement, staged-edit approval, sandbox). Nothing here grants anything.
 *
 * Cursor definitions carry no tool list at all, so they always take the
 * inherit path instead of this one.
 */
const TOOL_NAME_MAP: Record<string, readonly string[]> = {
  Read: ['read_file'],
  Write: ['write_file'],
  Edit: ['str_replace'],
  MultiEdit: ['str_replace'],
  Glob: ['find_files'],
  // One Claude tool, two Copse tools: `search_codebase` is the combined
  // regex+semantic entry point and `search_code` the plain regex one. An agent
  // told it may grep should get both rather than the weaker half.
  Grep: ['search_code', 'search_codebase'],
  Bash: ['run_shell'],
  WebFetch: ['fetch_url'],
  WebSearch: ['web_search'],
  TodoWrite: ['update_todos'],
}

export interface TranslatedToolNames {
  /** Copse tool names, de-duplicated and order-preserving. */
  names: string[]
  /** Input names with no Copse equivalent, for the Settings row. */
  dropped: string[]
}

/**
 * MCP tool references pass through untranslated: Copse already names MCP tools
 * `mcp__<server>__<tool>`, and Claude Code's server-wide `mcp__<server>` and
 * `mcp__<server>__*` patterns are matched as prefixes at filter time.
 */
function isMcpReference(name: string): boolean {
  return name.startsWith('mcp__')
}

export function translateToolNames(rawNames: readonly string[]): TranslatedToolNames {
  const names: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()

  for (const raw of rawNames) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    // `Agent(reviewer)` — a nested-delegation grant. Copse pins subagent depth
    // at 1, so the whole entry is dropped rather than half-honoured.
    if (/^Agent\(/i.test(trimmed)) {
      dropped.push(trimmed)
      continue
    }

    if (isMcpReference(trimmed)) {
      if (!seen.has(trimmed)) {
        seen.add(trimmed)
        names.push(trimmed)
      }
      continue
    }

    const mapped = TOOL_NAME_MAP[trimmed]
    if (!mapped) {
      // Already a Copse name (a hand-written `.copse` definition), or a Claude
      // tool with no counterpart here. Lowercase-with-underscores is the Copse
      // shape; anything else is reported to the user as dropped.
      if (/^[a-z][a-z0-9_]*$/.test(trimmed)) {
        if (!seen.has(trimmed)) {
          seen.add(trimmed)
          names.push(trimmed)
        }
      } else {
        dropped.push(trimmed)
      }
      continue
    }

    for (const name of mapped) {
      if (seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
  }

  return { names, dropped }
}
