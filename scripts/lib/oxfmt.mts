/**
 * The one place anything in this repo shells out to oxfmt.
 *
 * oxfmt ships a Node API (`format(fileName, source, options)`), but it does
 * **not** discover `.oxfmtrc.json` — called without an explicit options object
 * it silently falls back to oxfmt's own defaults, which are semicolons and
 * double quotes. Passing the options from a second copy in TypeScript is the
 * other half of that trap: the copy and `.oxfmtrc.json` would drift, and the
 * gate (`format:check`) reads the file while the scripts read the copy.
 *
 * So everything here goes through the CLI, which does discover the config —
 * and `.prettierignore` / `.gitignore` with it. One source of truth, and the
 * scripts format a file exactly the way the gate decides whether it is
 * formatted.
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OXFMT = resolve(ROOT, 'node_modules', '.bin', 'oxfmt')

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

function runOxfmt(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((settle, fail) => {
    const child = spawn(OXFMT, args, { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', fail)
    child.on('close', (code) => {
      settle({ stdout, stderr, code: code ?? 1 })
    })
    if (stdin === undefined) {
      child.stdin.end()
    } else {
      child.stdin.end(stdin, 'utf8')
    }
  })
}

/**
 * Format `source` as though it were the file at `path`, without touching disk.
 *
 * `--stdin-filepath` picks the parser from the extension and reads
 * `.oxfmtrc.json`, but cannot consult the ignore files — there is no real path
 * to match. Callers that need ignores honoured ask {@link isUnformatted} first.
 */
export async function formatSource(path: string, source: string): Promise<string> {
  const { stdout, stderr, code } = await runOxfmt([`--stdin-filepath=${path}`], source)
  if (code !== 0)
    throw new Error(`oxfmt failed on ${path}: ${stderr.trim() || `exit ${String(code)}`}`)
  return stdout
}

/**
 * Whether the file at `path` is formattable *and* currently unformatted.
 *
 * `--list-different` prints the path when it would change, and prints nothing
 * when the file is already formatted, ignored by `.prettierignore` /
 * `.gitignore`, or of a type oxfmt does not handle — which is exactly the
 * "nothing to say about this file" answer callers want. The
 * excluded-by-ignore-rules notice goes to stderr, so stdout stays a clean
 * signal.
 */
export async function isUnformatted(path: string): Promise<boolean> {
  const { stdout } = await runOxfmt(['--list-different', path])
  return stdout.trim() !== ''
}

/** Rewrite the files at `paths` in place. Returns oxfmt's exit code. */
export async function writeFormatted(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0
  const { code, stderr } = await runOxfmt(['--write', ...paths])
  if (code !== 0)
    throw new Error(`oxfmt --write failed: ${stderr.trim() || `exit ${String(code)}`}`)
  return code
}
