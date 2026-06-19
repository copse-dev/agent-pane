import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { getWorkspaceRoot } from './workspace.ts'

export async function loadProjectInstructions(): Promise<string> {
  const root = getWorkspaceRoot()
  if (!root) return ''
  try {
    const content = await fsp.readFile(join(root, 'AGENT.md'), 'utf-8')
    return content.trim()
  } catch {
    return ''
  }
}
