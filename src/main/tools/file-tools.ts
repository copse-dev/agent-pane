import * as fs from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  resolveReadablePath,
  toRelativePath,
  getWorkspaceRoot,
  isInsideChatStore,
} from '../services/workspace.ts'
import { runCommand } from '../services/exec/command-runner.ts'
import { getIndex } from '../services/search/file-index.ts'
import micromatch from 'micromatch'
import { getAgentRunReadFileLimits } from '../services/agent-run-read-limits.ts'
import { readTextLineRange } from '../services/read-text-file.ts'
import { buildReadFilePageMeta, formatReadFilePageFooter } from '@shared/agent/read-file-page.ts'
import { getStagedDiffEntry } from '../services/diff-queue.ts'

export const LIST_DIR_MAX_ENTRIES = 1000

function isPathUnderWorkspace(absPath: string): boolean {
  const rel = toRelativePath(absPath)
  return rel !== '..' && !rel.startsWith('..')
}

/**
 * Map a node:fs error to a friendly, workspace-relative message so raw errnos
 * and absolute filesystem paths never leak to the model (#123).
 */
function friendlyFsError(err: unknown, relPath: string, op: 'read' | 'list'): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOENT':
      return op === 'list' ? `Directory not found: ${relPath}` : `File not found: ${relPath}`
    case 'EISDIR':
      return `${relPath} is a directory, not a file.`
    case 'ENOTDIR':
      return `${relPath} is not a directory.`
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: ${relPath}`
    default:
      return op === 'list' ? `Could not list ${relPath}.` : `Could not read ${relPath}.`
  }
}

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a file from the workspace. Output size is capped per agent run based on available context; use start_line / end_line to read more.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
    start_line: z.number().int().min(1).optional().describe('First line to read (1-indexed)'),
    end_line: z.number().int().min(1).optional().describe('Last line to read (inclusive)'),
  }),
  async execute({ path, start_line, end_line }) {
    if (start_line !== undefined && end_line !== undefined && end_line < start_line) {
      return `Invalid range: end_line (${String(end_line)}) must be >= start_line (${String(start_line)}).`
    }
    const { maxLines: READ_FILE_MAX_LINES, maxChars: READ_FILE_MAX_CHARS } =
      getAgentRunReadFileLimits()
    const absPath = resolveReadablePath(path)

    let result
    try {
      result = await readTextLineRange(absPath, {
        startLine: start_line ?? 1,
        endLine: end_line,
        maxLines: READ_FILE_MAX_LINES,
        maxChars: READ_FILE_MAX_CHARS,
      })
    } catch (err) {
      return friendlyFsError(err, path, 'read')
    }

    if (result.text === '[Binary file — cannot display as text]') return result.text

    const pageMeta = buildReadFilePageMeta(
      path,
      result.totalLines,
      result.startLine,
      result.endLine,
      result.lineTruncated || result.charTruncated,
    )
    const pending = getStagedDiffEntry(path)
    const pendingNote = pending
      ? `\n\n[Note: ${path} has a pending Copse staged diff that is not written to disk yet. This read_file output is the on-disk content only. Use read_staged_diff with this path to inspect the proposed after content, or wait for user approval before validating.]`
      : ''
    return result.text + formatReadFilePageFooter(pageMeta, result.charTruncated) + pendingNote
  },
})

export const listDirTool = defineTool({
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
    const absPath = resolveReadablePath(path || '.')
    const workspaceRoot = getWorkspaceRoot()
    const absRoot = workspaceRoot ? resolve(workspaceRoot) : absPath

    if (recursive) {
      // The chat store (#644) is neither in the workspace file-index nor
      // workspace-relative, so list it directly with rg, rooted at and relative
      // to the listed directory. `--no-follow` keeps a symlink from escaping.
      if (isInsideChatStore(absPath)) {
        const { stdout } = await runCommand('rg', [
          '--files',
          '--sort',
          'path',
          '--no-follow',
          absPath,
        ])
        const paths = stdout
          .split('\n')
          .filter(Boolean)
          .map((p) => relative(absPath, p))
          .filter((p) => p !== '' && !p.startsWith('..'))
        return (
          paths.slice(0, LIST_DIR_MAX_ENTRIES).join('\n') +
          (paths.length > LIST_DIR_MAX_ENTRIES ? '\n[Truncated at 1000 entries]' : '')
        )
      }
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
    let entries
    try {
      entries = await fs.readdir(absPath, { withFileTypes: true })
    } catch (err) {
      return friendlyFsError(err, path || '.', 'list')
    }
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
})
