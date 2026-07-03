import * as fsp from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { splitSkillMarkdown } from './parse-skill-frontmatter.ts'

/**
 * Cursor project rules loaded as instruction text.
 *
 * Two on-disk shapes are supported, both project-scoped:
 *   1. `<root>/.cursor/rules/**\/*.mdc` — Markdown + YAML frontmatter. Cursor classifies
 *      each rule as Always / Auto-Attached (globs) / Agent-Requested (description) /
 *      Manual. Without a concrete active-file context we can only apply the **Always**
 *      rules (`alwaysApply: true`); the glob/description-scoped kinds are left for a
 *      follow-up (see docs/plans/settings-transparency.md).
 *   2. `<root>/.cursorrules` — the legacy single-file format, always applied.
 *
 * Like `AGENT.md`, these are prompt text (not executed), so they are read whenever
 * present — the workspace-trust gate is reserved for things that *run* (hooks, MCP).
 */

const SKIP_DIRS = new Set(['node_modules', '.git'])

export interface CursorRuleSource {
  /** Absolute path of the rule file. */
  path: string
  /** Display name, relative to the workspace root (e.g. `.cursor/rules/style.mdc`). */
  name: string
  /** Rule text fed to the prompt (frontmatter stripped for `.mdc`). */
  content: string
}

/** Whether an `.mdc` frontmatter block sets `alwaysApply: true`. */
function isAlwaysApply(frontmatter: string): boolean {
  const match = frontmatter.match(/^alwaysApply:[ \t]*(.+?)[ \t]*$/m)
  if (!match) return false
  return /^(true|yes|on)$/i.test((match[1] ?? '').trim())
}

async function walkMdcFiles(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walkMdcFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.mdc')) {
      out.push(full)
    }
  }
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const content = (await fsp.readFile(path, 'utf-8')).trim()
    return content || null
  } catch {
    return null
  }
}

/** Discover the Cursor project rules that apply unconditionally in this workspace. */
export async function loadCursorRuleSources(workspaceRoot: string): Promise<CursorRuleSource[]> {
  const sources: CursorRuleSource[] = []

  const rulesDir = join(workspaceRoot, '.cursor', 'rules')
  const mdcPaths: string[] = []
  await walkMdcFiles(rulesDir, mdcPaths)
  mdcPaths.sort()

  for (const path of mdcPaths) {
    const raw = await readTrimmed(path)
    if (!raw) continue
    const split = splitSkillMarkdown(raw)
    // A `.mdc` without frontmatter has no `alwaysApply` flag, so we cannot tell it is an
    // Always rule — skip it rather than guess.
    if (!split || !isAlwaysApply(split.frontmatter)) continue
    const body = split.body.trim()
    if (!body) continue
    sources.push({ path, name: relative(workspaceRoot, path), content: body })
  }

  const legacyPath = join(workspaceRoot, '.cursorrules')
  const legacy = await readTrimmed(legacyPath)
  if (legacy) sources.push({ path: legacyPath, name: basename(legacyPath), content: legacy })

  return sources
}
