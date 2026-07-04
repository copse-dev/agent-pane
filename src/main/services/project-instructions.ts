import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { getWorkspaceRoot } from './workspace.ts'

/**
 * Project-root instruction files, in precedence order.
 *
 * `AGENT.md` / `AGENTS.md` are the cross-tool convention; `CLAUDE.md` is Claude Code's.
 * We load whichever are present so Copse behaves the same regardless of which assistant
 * seeded the repo. Identical content (repos often symlink `AGENTS.md` → `CLAUDE.md`) is
 * loaded once.
 */
export const PROJECT_INSTRUCTION_FILES = ['AGENT.md', 'AGENTS.md', 'CLAUDE.md'] as const

export interface ProjectInstructionSource {
  /** Absolute path of the file on disk. */
  path: string
  /** Bare filename (e.g. `CLAUDE.md`), for display. */
  name: string
  /** Trimmed file contents. */
  content: string
}

/** Discover the project instruction files present in the workspace root, in order. */
export async function loadProjectInstructionSources(): Promise<ProjectInstructionSource[]> {
  const root = getWorkspaceRoot()
  if (!root) return []

  const sources: ProjectInstructionSource[] = []
  const seenContent = new Set<string>()
  for (const name of PROJECT_INSTRUCTION_FILES) {
    let content: string
    try {
      content = (await fsp.readFile(join(root, name), 'utf-8')).trim()
    } catch {
      continue // missing file is normal
    }
    if (!content || seenContent.has(content)) continue
    seenContent.add(content)
    sources.push({ path: join(root, name), name, content })
  }
  return sources
}

/** Combined project instructions appended to the system prompt. */
export async function loadProjectInstructions(): Promise<string> {
  const sources = await loadProjectInstructionSources()
  return sources.map((s) => s.content).join('\n\n')
}
