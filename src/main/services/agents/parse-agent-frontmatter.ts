import { basename } from 'node:path'
import type { AgentContainer, UnsupportedAgentField } from '@shared/types/agents.ts'
import {
  parseScalarBlock,
  parseYamlBoolean,
  parseYamlList,
  splitMarkdownFrontmatter,
} from '../discovery/yaml-frontmatter.ts'
import { translateToolNames } from './translate-tool-names.ts'

export interface ParsedAgentFile {
  name: string
  description: string | null
  body: string
  tools: string[] | null
  disallowedTools: string[]
  model: string
  readonly: boolean
  maxTurns: number | null
  color: string | null
  unsupportedFields: UnsupportedAgentField[]
}

/** A file that is not an agent definition, and the user-facing reason why. */
export interface RejectedAgentFile {
  reason: string
  /** False for files that are simply documentation — not worth a Settings row. */
  report: boolean
}

export type AgentParseResult =
  { ok: true; agent: ParsedAgentFile } | { ok: false; rejected: RejectedAgentFile }

/**
 * Frontmatter fields Copse recognises but does not act on yet, with the copy
 * shown per row in Settings.
 *
 * Two of these are load-bearing for safety rather than convenience.
 * `permissionMode`'s permissive values are ignored *by design* — a file on disk
 * does not get to relax the permission gate — and `isolation: worktree` is
 * called out because an agent written to expect a throwaway checkout will edit
 * the real tree instead.
 */
const UNSUPPORTED_FIELD_REASONS: Record<string, string> = {
  mcpServers: 'per-agent MCP servers are not wired up yet; the agent uses this thread’s',
  hooks: 'per-agent hooks are not wired up yet; your global hooks still run',
  memory: 'agent memory directories are not supported yet',
  effort: 'per-agent effort is not supported yet; the thread’s setting applies',
  model_reasoning_effort: 'per-agent reasoning effort is not supported yet',
  initialPrompt: 'only used when an agent runs as a whole session, which Copse does not do',
  skills: 'preloading skills into an agent is not supported yet',
  background: 'background agents are not supported yet; this one runs inline',
  is_background: 'background agents are not supported yet; this one runs inline',
}

/**
 * `permissionMode` values Copse maps rather than honours. `plan` becomes a
 * read-only run; everything else would *widen* what the agent may do, and is
 * dropped.
 */
function permissionModeNote(value: string): UnsupportedAgentField | null {
  if (value === 'plan' || value === 'default') return null
  return {
    field: 'permissionMode',
    reason: `“${value}” is ignored — Copse always asks for the approvals it would normally ask for`,
  }
}

function parseMaxTurns(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * Whether a container's format lets the filename stand in for a missing `name`.
 *
 * Cursor derives `name` from the filename; Claude Code treats a file with no
 * `name` as documentation and skips it. Applying Cursor's rule inside
 * `.claude/agents` would turn a stray `README.md` into an agent named `readme`
 * that Claude Code itself correctly ignores, so each container keeps its own
 * format's convention.
 */
function allowsFilenameName(container: AgentContainer): boolean {
  return container === '.cursor' || container === '.copse'
}

const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function parseAgentFile(
  raw: string,
  agentPath: string,
  container: AgentContainer,
): AgentParseResult {
  const split = splitMarkdownFrontmatter(raw)
  if (!split) {
    // A file that never opens a frontmatter block is documentation — a README
    // beside your definitions is normal, and flagging it as an error row is
    // noise. A block that opens and never closes is a real mistake worth
    // reporting, and is the only case that reaches `report: true` here.
    const opensBlock = raw
      .replace(/^\uFEFF/, '')
      .trimStart()
      .startsWith('---')
    return {
      ok: false,
      rejected: opensBlock
        ? { reason: 'frontmatter block is never closed by a “---” line', report: true }
        : { reason: 'no YAML frontmatter — treated as documentation', report: false },
    }
  }

  const { frontmatter: yaml, body } = split
  const declaredName = parseScalarBlock(yaml, 'name')
  const fileStem = basename(agentPath).replace(/\.md$/i, '')
  const name = declaredName ?? (allowsFilenameName(container) ? fileStem : undefined)

  if (name === undefined) {
    // Claude Code's rule: no `name` means the file is documentation sitting in
    // the agents directory. Not an error, and not worth a Settings row.
    return {
      ok: false,
      rejected: { reason: 'no “name” field — treated as documentation', report: false },
    }
  }
  if (name.startsWith('-')) {
    return {
      ok: false,
      rejected: { reason: `invalid name “${name}” — cannot start with “-”`, report: true },
    }
  }
  if (name.includes(':')) {
    // Reserved for plugin scoping (`my-plugin:reviewer`).
    return {
      ok: false,
      rejected: { reason: `invalid name “${name}” — “:” is reserved`, report: true },
    }
  }
  if (!VALID_NAME_RE.test(name)) {
    return {
      ok: false,
      rejected: {
        reason: `invalid name “${name}” — use lowercase letters, digits and hyphens`,
        report: true,
      },
    }
  }

  const unsupportedFields: UnsupportedAgentField[] = []
  for (const [field, reason] of Object.entries(UNSUPPORTED_FIELD_REASONS)) {
    if (new RegExp(`^${field}:`, 'm').test(yaml)) unsupportedFields.push({ field, reason })
  }

  const permissionMode = parseScalarBlock(yaml, 'permissionMode')
  if (permissionMode !== undefined) {
    const note = permissionModeNote(permissionMode)
    if (note) unsupportedFields.push(note)
  }

  const isolation = parseScalarBlock(yaml, 'isolation')
  if (isolation !== undefined) {
    unsupportedFields.push({
      field: 'isolation',
      reason: 'runs in your working tree, not an isolated worktree copy',
    })
  }

  const rawTools = parseYamlList(yaml, 'tools')
  const tools = translateToolNames(rawTools)
  if (tools.dropped.length > 0) {
    unsupportedFields.push({
      field: 'tools',
      reason: `no Copse equivalent for ${tools.dropped.join(', ')}`,
    })
  }
  const disallowed = translateToolNames(parseYamlList(yaml, 'disallowedTools'))

  // Cursor writes `id[fast,effort=high]`; the parameter suffix has no Copse
  // meaning, so it is stripped and the bare id resolved at run time.
  const rawModel = parseScalarBlock(yaml, 'model') ?? 'inherit'
  const model = rawModel.replace(/\[.*\]$/, '').trim()
  if (model !== rawModel) {
    unsupportedFields.push({
      field: 'model',
      reason: `model options in “${rawModel}” are ignored`,
    })
  }

  return {
    ok: true,
    agent: {
      name,
      description: parseScalarBlock(yaml, 'description') ?? null,
      body,
      tools: rawTools.length > 0 ? tools.names : null,
      disallowedTools: disallowed.names,
      model: model || 'inherit',
      readonly: parseYamlBoolean(yaml, 'readonly') || permissionMode === 'plan',
      maxTurns: parseMaxTurns(parseScalarBlock(yaml, 'maxTurns')),
      color: parseScalarBlock(yaml, 'color') ?? null,
      unsupportedFields,
    },
  }
}
