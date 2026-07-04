import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InstructionScope } from '@shared/types/instructions.ts'
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

/**
 * User-global instruction files, relative to the home directory, in precedence order.
 * These form a lower-precedence layer beneath the project files — always-on personal
 * steering that applies across every workspace, mirroring how most assistants layer a
 * global file under the per-repo one.
 */
export const GLOBAL_INSTRUCTION_FILES = ['AGENTS.md', join('.claude', 'CLAUDE.md')] as const

export interface ProjectInstructionSource {
  /** Absolute path of the file on disk. */
  path: string
  /** Bare filename (e.g. `CLAUDE.md`), for display. */
  name: string
  /** Whether the file is user-global or project-scoped. */
  scope: InstructionScope
  /** Trimmed file contents. */
  content: string
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const content = (await fsp.readFile(path, 'utf-8')).trim()
    return content || null
  } catch {
    return null // missing file is normal
  }
}

/**
 * Discover the instruction files feeding the system prompt, global layer first then
 * project. Identical content is loaded once (across both layers), so a repo whose
 * `AGENTS.md` matches the user's global file is not injected twice.
 */
export async function loadProjectInstructionSources(): Promise<ProjectInstructionSource[]> {
  const home = homedir()
  const candidates: Array<{ path: string; name: string; scope: InstructionScope }> = []

  for (const rel of GLOBAL_INSTRUCTION_FILES) {
    candidates.push({ path: join(home, rel), name: rel, scope: 'global' })
  }
  const root = getWorkspaceRoot()
  if (root) {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      candidates.push({ path: join(root, name), name, scope: 'project' })
    }
  }

  const sources: ProjectInstructionSource[] = []
  const seenContent = new Set<string>()
  for (const { path, name, scope } of candidates) {
    const content = await readTrimmed(path)
    if (!content || seenContent.has(content)) continue
    seenContent.add(content)
    sources.push({ path, name, scope, content })
  }
  return sources
}

/** Combined instructions appended to the system prompt (global layer first, then project). */
export async function loadProjectInstructions(): Promise<string> {
  const sources = await loadProjectInstructionSources()
  return sources.map((s) => s.content).join('\n\n')
}
