// Installed pnpm packages are reached through checkout-local symlinks, which
// the orchestrator's host-side file tools deliberately never follow. Read one
// dependency file through the execution cell instead: it has the same checkout
// as its cwd, a secret-free environment, and serialises this fixed helper with
// every model-selected command. The helper resolves the link, then refuses any
// canonical target outside the disposable node_modules tree before opening it.
import { posix } from 'node:path'
import type { CellCommandResult, ExecutionCell } from './isolation.ts'

const DEPENDENCY_READ_TIMEOUT_MS = 30_000
const MAX_DEPENDENCY_FILE_BYTES = 2 * 1024 * 1024

// This is trusted package code, not model or repository text. Passing the path
// and line window as argv keeps them data; no shell parses either value.
const DEPENDENCY_READER_SCRIPT = String.raw`
const fs = require('node:fs')
const path = require('node:path')

try {
  const root = fs.realpathSync(process.cwd())
  const dependencyRoot = fs.realpathSync(path.join(root, 'node_modules'))
  const dependencyRootRelative = path.relative(root, dependencyRoot)
  if (
    dependencyRootRelative === '..' ||
    dependencyRootRelative.startsWith('..' + path.sep) ||
    path.isAbsolute(dependencyRootRelative)
  ) {
    throw new Error('node_modules resolves outside the disposable checkout')
  }
  const requested = path.resolve(root, process.argv[1])
  const target = fs.realpathSync(requested)
  const relative = path.relative(dependencyRoot, target)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('dependency target resolves outside the disposable node_modules tree')
  }

  const flags = fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0)
  const fd = fs.openSync(target, flags)
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile()) throw new Error('dependency path is not a regular file')
    const maxBytes = Number(process.argv[5])
    if (info.size > maxBytes) throw new Error('dependency file exceeds the read limit')

    const text = fs.readFileSync(fd, 'utf8')
    if (text.includes('\u0000')) throw new Error('dependency file is binary')
    const lines = text.split(/\r?\n/)
    const start = Number(process.argv[2])
    const requestedEnd = process.argv[3] === '' ? lines.length : Number(process.argv[3])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 1 || requestedEnd < start) {
      throw new Error('invalid dependency line window')
    }
    if (start > lines.length) throw new Error('dependency line window starts past end of file')

    const end = Math.min(lines.length, requestedEnd)
    const width = String(end).length
    const rendered = lines
      .slice(start - 1, end)
      .map((line, index) => String(start + index).padStart(width) + ': ' + line)
      .join('\n')
    const maxChars = Number(process.argv[4])
    process.stdout.write(
      rendered.length <= maxChars
        ? rendered
        : rendered.slice(0, maxChars) + '\n…(output truncated at ' + String(maxChars) + ' characters)',
    )
  } finally {
    fs.closeSync(fd)
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
`

export interface DependencyFileRequest {
  readonly path: string
  readonly startLine?: number | undefined
  readonly endLine?: number | undefined
}

/** Normalise a model path and keep this tool scoped to installed packages. */
export function dependencyFilePath(path: string): string {
  const portable = path.replaceAll('\\', '/')
  const normal = posix.normalize(portable)
  if (
    posix.isAbsolute(portable) ||
    normal === 'node_modules' ||
    !normal.startsWith('node_modules/')
  ) {
    throw new Error('dependency paths must name a file below node_modules/')
  }
  return normal
}

export function readDependencyFileInCell(
  cell: ExecutionCell,
  request: DependencyFileRequest,
  maxOutputChars: number,
  signal: AbortSignal,
): Promise<CellCommandResult> {
  const path = dependencyFilePath(request.path)
  const startLine = request.startLine ?? 1
  const endLine = request.endLine
  if (endLine !== undefined && endLine < startLine) {
    throw new Error('endLine must not be before startLine')
  }
  return cell.run({
    target: 'head',
    argv: [
      'node',
      '-e',
      DEPENDENCY_READER_SCRIPT,
      path,
      String(startLine),
      endLine === undefined ? '' : String(endLine),
      String(maxOutputChars),
      String(MAX_DEPENDENCY_FILE_BYTES),
    ],
    timeoutMs: DEPENDENCY_READ_TIMEOUT_MS,
    maxOutputBytes: maxOutputChars * 4,
    signal,
  })
}
