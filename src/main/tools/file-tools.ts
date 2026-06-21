import * as fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { resolveWorkspacePath, toRelativePath, getWorkspaceRoot } from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import { getIndex } from '../services/file-index.ts'
import micromatch from 'micromatch'
import { getAgentRunReadFileLimits } from '../services/agent-run-read-limits.ts'
import { readTextLineRange } from '../services/read-text-file.ts'

export const LIST_DIR_MAX_ENTRIES = 1000

function isPathUnderWorkspace(absPath: string): boolean {
  const rel = toRelativePath(absPath)
  return rel !== '..' && !rel.startsWith('..')
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a file from the workspace. Output size is capped per agent run based on available context; use start_line / end_line to read more.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
    start_line: z.number().int().min(1).optional().describe('First line to read (1-indexed)'),
    end_line: z.number().int().min(1).optional().describe('Last line to read (inclusive)'),
  }),
  async execute({ path, start_line, end_line }) {
    const { maxLines: READ_FILE_MAX_LINES, maxChars: READ_FILE_MAX_CHARS } =
      getAgentRunReadFileLimits()
    const absPath = resolveWorkspacePath(path)

    const result = await readTextLineRange(absPath, {
      startLine: start_line ?? 1,
      endLine: end_line,
      maxLines: READ_FILE_MAX_LINES,
      maxChars: READ_FILE_MAX_CHARS,
    })

    if (result.text === '[Binary file — cannot display as text]') return result.text

    const parts = [result.text]
    if (result.lineTruncated) {
      parts.push(
        `\n\n[File truncated at line ${result.endLine}. ${result.totalLines} total lines. Use start_line/end_line to read more.]`,
      )
    }
    if (result.charTruncated) {
      parts.push(
        `\n\n[Output truncated at ${READ_FILE_MAX_CHARS} characters. Use start_line/end_line to read a smaller range.]`,
      )
    }
    return parts.join('')
  },
}

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    'List files and directories at a path. Use recursive: true for a full tree (limited to 1000 entries, respects .gitignore).',
  parameters: z.object({
    path: z
      .string()
      .optional()
      .default('.')
      .describe('Directory path relative to workspace root. Use "." for root.'),
    recursive: z.boolean().optional().default(false),
  }),
  async execute({ path, recursive }) {
    const absPath = resolveWorkspacePath(path || '.')
    const workspaceRoot = getWorkspaceRoot()
    const absRoot = workspaceRoot ? resolve(workspaceRoot) : absPath

    if (recursive) {
      const idx = getIndex()
      let paths: string[]
      if (idx) {
        const glob = path && path !== '.' ? `${path.replace(/\/$/, '')}/**` : '**'
        paths = micromatch(idx.paths, glob).filter((p) => isPathUnderWorkspace(resolve(absRoot, p)))
      } else {
        const { stdout } = await runCommand('rg', [
          '--files',
          '--sort',
          'path',
          '--no-follow',
          absPath,
        ])
        paths = stdout
          .split('\n')
          .filter(Boolean)
          .map((p) => toRelativePath(p))
          .filter((p) => isPathUnderWorkspace(resolve(absRoot, p)))
      }
      return (
        paths.slice(0, LIST_DIR_MAX_ENTRIES).join('\n') +
        (paths.length > LIST_DIR_MAX_ENTRIES ? '\n[Truncated at 1000 entries]' : '')
      )
    }
    const entries = await fs.readdir(absPath, { withFileTypes: true })
    const lines: string[] = []
    for (const e of entries) {
      if (lines.length >= LIST_DIR_MAX_ENTRIES) break
      lines.push(`${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    }
    return (
      lines.join('\n') +
      (entries.length > LIST_DIR_MAX_ENTRIES ? '\n[Truncated at 1000 entries]' : '')
    )
  },
}
