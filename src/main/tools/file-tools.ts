import * as fs from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { resolveWorkspacePath, toRelativePath } from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import { getAgentRunReadFileLimits } from '../services/agent-run-read-limits.ts'

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

    const handle = await fs.open(absPath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(buf, 0, 8192, 0)
      if (buf.slice(0, bytesRead).includes(0)) return '[Binary file — cannot display as text]'
    } finally {
      await handle.close()
    }

    const content = await fs.readFile(absPath, 'utf-8')
    const lines = content.split('\n')
    const start = (start_line ?? 1) - 1
    const end = end_line ?? Math.min(lines.length, start + READ_FILE_MAX_LINES)
    const slice = lines.slice(start, end)
    const lineTruncated = end < lines.length

    let text = slice.join('\n')
    let charTruncated = false
    if (text.length > READ_FILE_MAX_CHARS) {
      text = text.slice(0, READ_FILE_MAX_CHARS)
      charTruncated = true
    }

    const parts = [text]
    if (lineTruncated) {
      parts.push(
        `\n\n[File truncated at line ${end}. ${lines.length} total lines. Use start_line/end_line to read more.]`,
      )
    }
    if (charTruncated) {
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
    // Optional + default so models (esp. local ones) that omit it still work —
    // it simply lists the workspace root.
    path: z
      .string()
      .optional()
      .default('.')
      .describe('Directory path relative to workspace root. Use "." for root.'),
    recursive: z.boolean().optional().default(false),
  }),
  async execute({ path, recursive }) {
    const absPath = resolveWorkspacePath(path || '.')
    if (recursive) {
      const { stdout } = await runCommand('rg', ['--files', '--sort', 'path', absPath])
      const paths = stdout
        .split('\n')
        .filter(Boolean)
        .map((p) => toRelativePath(p))
      return (
        paths.slice(0, 1000).join('\n') +
        (paths.length > 1000 ? '\n[Truncated at 1000 entries]' : '')
      )
    }
    const entries = await fs.readdir(absPath, { withFileTypes: true })
    return entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
  },
}
