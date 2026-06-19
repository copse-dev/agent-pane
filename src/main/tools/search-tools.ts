import * as fs from 'node:fs/promises'
import { z } from 'zod'
import micromatch from 'micromatch'
import type { ToolDefinition } from '@shared/types'
import { resolveWorkspacePath, getWorkspaceRoot, toRelativePath } from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import { isRgAvailable } from '../services/tool-availability.ts'
import { getIndex } from '../services/file-index.ts'

export const searchCodeTool: ToolDefinition = {
  name: 'search_code',
  description:
    'Search for a text pattern or regex in the workspace. Respects .gitignore. Returns matching lines with file:line format.',
  parameters: z.object({
    pattern: z.string().describe('Search pattern (regex by default)'),
    path: z.string().optional().describe('Subdirectory to search in. Defaults to workspace root.'),
    file_glob: z.string().optional().describe('Glob to filter files, e.g. "*.ts"'),
    fixed_string: z.boolean().optional().default(false).describe('Treat pattern as literal string'),
    case_sensitive: z.boolean().optional().default(false),
    max_results: z.number().int().min(1).max(500).optional().default(50),
  }),
  async execute({ pattern, path, file_glob, fixed_string, case_sensitive, max_results }, signal) {
    const root = getWorkspaceRoot()
    if (!root) return 'No workspace open.'
    const searchRoot = path ? resolveWorkspacePath(path) : root

    if (!isRgAvailable()) {
      return slowSearch(searchRoot, pattern, max_results)
    }

    const args = [
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--max-count',
      String(max_results),
      '--json',
      ...(fixed_string ? ['--fixed-strings'] : []),
      ...(case_sensitive ? [] : ['--ignore-case']),
      ...(file_glob ? ['--glob', file_glob] : []),
      '--',
      pattern,
      searchRoot,
    ]

    const { stdout } = await runCommand('rg', args, { signal })
    const matches = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((o): o is Record<string, unknown> => o !== null && o['type'] === 'match')
      .map((o) => {
        const data = o['data'] as {
          path: { text: string }
          line_number: number
          lines: { text: string }
        }
        return `${toRelativePath(data.path.text)}:${data.line_number}: ${data.lines.text.trimEnd()}`
      })

    if (matches.length === 0) return 'No matches found.'
    return (
      matches.join('\n') +
      (matches.length >= max_results
        ? `\n[Truncated at ${max_results} results. Narrow your search.]`
        : '')
    )
  },
}

export const findFilesTool: ToolDefinition = {
  name: 'find_files',
  description: 'Find files in the workspace by name or glob pattern. Fast — uses pre-built index.',
  parameters: z.object({
    pattern: z
      .string()
      .describe('Filename or glob. Examples: "*.ts", "package.json", "src/**/*service*"'),
    max_results: z.number().int().min(1).max(200).optional().default(50),
  }),
  async execute({ pattern, max_results }) {
    const idx = getIndex()
    if (!idx) return 'File index not available. Try opening the workspace again.'
    const matches = micromatch(idx.paths, pattern).slice(0, max_results)
    if (matches.length === 0) return `No files match: ${pattern}`
    return (
      matches.join('\n') + (matches.length >= max_results ? `\n[Truncated at ${max_results}]` : '')
    )
  },
}

async function slowSearch(root: string, pattern: string, max: number): Promise<string> {
  const regex = new RegExp(pattern, 'i')
  const results: string[] = []
  await walk(root, root, regex, results, max)
  return results.length
    ? results.join('\n') + '\n[Note: ripgrep not found — results may be slower and incomplete]'
    : 'No matches found.'
}

async function walk(root: string, dir: string, re: RegExp, out: string[], max: number) {
  if (out.length >= max) return
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      await walk(root, full, re, out, max)
      continue
    }
    try {
      const content = await fs.readFile(full, 'utf-8')
      content.split('\n').forEach((line, i) => {
        if (out.length < max && re.test(line))
          out.push(`${toRelativePath(full)}:${i + 1}: ${line.trim()}`)
      })
    } catch {
      /* ignore unreadable files */
    }
  }
}
