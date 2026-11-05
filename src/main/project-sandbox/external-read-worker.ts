import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import micromatch from 'micromatch'
import { z } from 'zod'
import { sensitiveTargetReason } from '@copse/shell-guard/read-outside-project.ts'

/** Fixed read operations only; this worker never accepts executable code. */
export const externalReadRequestSchema = z.object({
  op: z.literal('externalRead'),
  path: z.string(),
  excludedRoots: z.array(z.string()),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('read') }),
    z.object({ kind: z.literal('list'), recursive: z.boolean() }),
    z.object({
      kind: z.literal('search'),
      pattern: z.string().max(256),
      fixed: z.boolean(),
      caseSensitive: z.boolean(),
      glob: z.string().optional(),
      maxResults: z.number().int().min(1).max(500),
      contextLines: z.number().int().min(0).max(20),
    }),
  ]),
})

export type ExternalReadAction = z.infer<typeof externalReadRequestSchema>['action']

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Run only inside a one-shot sandbox; the host checks consent before spawning. */
export async function executeExternalRead(
  request: z.infer<typeof externalReadRequestSchema>,
): Promise<string> {
  const root = resolve(request.path)
  const permitted = (path: string): boolean =>
    inside(path, root) &&
    !sensitiveTargetReason(path, path) &&
    !sensitiveTargetReason(path, `${path}${sep}`) &&
    !request.excludedRoots.some((excluded) => inside(path, excluded))
  if (!permitted(root) || (await realpath(root)) !== root) {
    throw new Error('External read target changed or is protected.')
  }
  const read = async (path: string): Promise<string> => {
    if (!permitted(path) || (await realpath(path)) !== path)
      throw new Error('External read target changed or is protected.')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('External read requires a regular file.')
      const limit = request.action.kind === 'read' ? 16 * 1024 * 1024 : 512 * 1024
      if (stat.size > limit) throw new Error('External file exceeds the read size limit.')
      // A bounded read also caps files which grow after stat.
      const buffer = Buffer.alloc(limit + 1)
      let size = 0
      while (size <= limit) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
        if (bytesRead === 0) break
        size += bytesRead
      }
      if (size > limit) throw new Error('External file exceeds the read size limit.')
      return buffer.subarray(0, size).toString('utf8')
    } finally {
      await handle.close()
    }
  }
  const action = request.action
  if (action.kind === 'read') return read(root)
  const paths: Array<{ path: string; directory: boolean }> = []
  let visited = 0
  const walk = async (path: string, depth: number): Promise<void> => {
    if (++visited > 10_000 || depth > 48 || paths.length >= 1000) return
    if (!permitted(path) || (await realpath(path)) !== path) return
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (paths.length >= 1000 || visited >= 10_000) break
      const child = join(path, entry.name)
      if (!permitted(child) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (action.kind === 'list' && !action.recursive)
          paths.push({ path: child, directory: true })
        else if (!['.git', 'node_modules', 'dist', 'vendor'].includes(entry.name))
          await walk(child, depth + 1)
      } else if (entry.isFile()) paths.push({ path: child, directory: false })
    }
  }
  const stat = await lstat(root)
  if (stat.isDirectory()) await walk(root, 0)
  else if (stat.isFile() && action.kind === 'search') paths.push({ path: root, directory: false })
  else throw new Error('External listing requires a directory.')
  const truncated = paths.length >= 1000 || visited >= 10_000
  if (action.kind === 'list') {
    return (
      paths
        .map(
          (entry) =>
            `${action.recursive ? '' : entry.directory ? 'd ' : 'f '}${relative(root, entry.path)}`,
        )
        .join('\n') + (truncated ? '\n[Truncated at the external directory scan limit.]' : '')
    )
  }
  const regex = action.fixed ? null : new RegExp(action.pattern, action.caseSensitive ? '' : 'i')
  const needle = action.caseSensitive ? action.pattern : action.pattern.toLowerCase()
  const output: string[] = []
  let matches = 0
  let skipped = false
  for (const entry of paths) {
    const label = relative(root, entry.path) || basename(entry.path)
    if (action.glob && !micromatch.isMatch(label, action.glob, { matchBase: true, dot: true }))
      continue
    let text: string
    try {
      text = await read(entry.path)
    } catch {
      skipped = true
      continue
    }
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    const selected = new Map<number, boolean>()
    for (let i = 0; i < lines.length && matches < action.maxResults; i++) {
      const line = (lines[i] ?? '').slice(0, 8192)
      if (
        !(regex
          ? regex.test(line)
          : (action.caseSensitive ? line : line.toLowerCase()).includes(needle))
      )
        continue
      matches++
      for (
        let j = Math.max(0, i - action.contextLines);
        j <= Math.min(lines.length - 1, i + action.contextLines);
        j++
      ) {
        selected.set(j, selected.get(j) === true || j === i)
      }
    }
    for (const [line, match] of selected) {
      output.push(
        `${entry.path}${match ? ':' : '-'}${String(line + 1)}${match ? ': ' : '- '}${(lines[line] ?? '').slice(0, 8192)}`,
      )
    }
    if (matches >= action.maxResults) break
  }
  return (
    (output.join('\n') || 'No matches found.') +
    (truncated || matches >= action.maxResults ? '\n[Truncated. Narrow your search.]' : '') +
    (skipped ? '\n[Some files could not be read or exceeded the size limit.]' : '')
  )
}
