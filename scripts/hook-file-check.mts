/**
 * `afterFileEdit` hook — the targeted half of `npm run check`, for one file.
 *
 * Wired from `.copse/hooks.json`, `.cursor/hooks.json` and `.claude/settings.json`
 * so an agent editing this repo through any of the three harnesses gets the same
 * feedback in a couple of seconds, instead of discovering it in a full `npm run
 * check` at the end of a long turn.
 *
 * What it runs, and what it deliberately does not:
 *
 *   • **Prettier** on the edited file (~1s).
 *   • **ESLint** on the edited file with the **type-aware rules switched off**
 *     (~2s). The repo lints with `strictTypeChecked` and a `project`, so a
 *     single-file typed lint pays ~10s to build the whole TypeScript program —
 *     per edit, that is a tax an agent will route around. Dropping type-aware
 *     rules keeps the fast, high-frequency findings (unused vars, undefined
 *     references, missing return types, `no-empty`) at hook latency.
 *   • **Not** `tsc`, and **not** the type-aware rules — both need the whole
 *     program, and neither can be scoped to one file honestly.
 *
 * So this is a fast pre-filter, never a substitute for `npm run check`. The
 * report says so, because a hook that implies more coverage than it has is
 * worse than no hook.
 *
 * Usage:
 *   node scripts/hook-file-check.mts <file>            # check a path directly
 *   node scripts/hook-file-check.mts --dialect copse   # read the payload on stdin
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import * as prettier from 'prettier'
import {
  type Finding,
  type HookDialect,
  checkPlanFor,
  editedPathsFromPayload,
  hookOutput,
  isHookDialect,
  renderReport,
  siblingTestCandidates,
} from './lib/edited-file-check.mts'

/**
 * The repo root, derived from this file's own location rather than `cwd`.
 * Cursor and Copse spawn a hook with the *declaring config's* directory as its
 * working directory (`.cursor/`, `.copse/`), so `process.cwd()` would resolve
 * every path — and the ESLint/Prettier config lookup — one level down and find
 * nothing.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read all of stdin, or '' when nothing is piped (so a bare run still works). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, 'utf8'))
  }
  return Buffer.concat(chunks).toString('utf8')
}

type Args = { dialect: HookDialect; files: string[] }

function parseArgs(argv: string[]): Args {
  let dialect: HookDialect = 'cli'
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dialect') {
      const value = argv[++i]
      if (value !== undefined && isHookDialect(value)) dialect = value
    } else if (arg !== undefined && !arg.startsWith('-')) files.push(arg)
  }
  return { dialect, files }
}

/** Repo-relative and forward-slashed, for stable output and ignore matching. */
function toRepoRelative(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(ROOT, path)
  return relative(ROOT, abs).replace(/\\/g, '/')
}

/**
 * ESLint pointed at `eslint.hook.config.mjs` — the project config with the
 * type-aware rules off, which is what drops a one-file lint from ~10s to ~2s.
 * That file documents the trade; the config lives on disk rather than being
 * composed here so ESLint loads and validates it exactly as it would any other,
 * and it can be run by hand: `npx eslint --config eslint.hook.config.mjs <file>`.
 */
function createFastEslint(): ESLint {
  return new ESLint({ cwd: ROOT, overrideConfigFile: resolve(ROOT, 'eslint.hook.config.mjs') })
}

/** `abs` for every filesystem/tool call, `rel` for everything the agent reads. */
async function lintFindings(abs: string, rel: string): Promise<Finding[]> {
  const eslint = createFastEslint()
  if (await eslint.isPathIgnored(abs)) return []
  const results = await eslint.lintFiles([abs])
  const messages = results.flatMap((r) => r.messages).filter((m) => m.severity === 2)
  if (messages.length === 0) return []
  const detail = messages
    .map((m) =>
      `  ${String(m.line)}:${String(m.column)}  ${m.message}  ${m.ruleId ?? ''}`.trimEnd(),
    )
    .join('\n')
  return [{ tool: 'eslint', detail, fix: `npx eslint ${rel}` }]
}

async function formatFindings(abs: string, rel: string): Promise<Finding[]> {
  const info = await prettier.getFileInfo(abs, { ignorePath: resolve(ROOT, '.prettierignore') })
  if (info.ignored || info.inferredParser === null) return []
  const source = await readFile(abs, 'utf8')
  const options = await prettier.resolveConfig(abs)
  if (await prettier.check(source, { ...options, filepath: abs })) return []
  return [
    { tool: 'prettier', detail: '  file is not formatted', fix: `npx prettier --write ${rel}` },
  ]
}

/** Run the checks for one file and return its report, or null when it is clean. */
async function checkFile(rawPath: string): Promise<string | null> {
  const rel = toRepoRelative(rawPath)
  // An edit outside the repo (or to a file since deleted) is not ours to check.
  if (rel.startsWith('..')) return null
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs)) return null
  const plan = checkPlanFor(rel)
  if (plan === null) return null

  const findings = (
    await Promise.all([
      plan.lint ? lintFindings(abs, rel) : Promise.resolve([]),
      plan.format ? formatFindings(abs, rel) : Promise.resolve([]),
    ])
  ).flat()
  if (findings.length === 0) return null

  const testHint =
    siblingTestCandidates(rel).find((candidate) => existsSync(resolve(ROOT, candidate))) ?? null
  return renderReport(rel, findings, testHint)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let files = args.files
  if (files.length === 0) {
    const stdin = (await readStdin()).trim()
    if (stdin) {
      try {
        files = editedPathsFromPayload(JSON.parse(stdin))
      } catch {
        // A payload we can't parse is not a reason to interrupt the agent.
        files = []
      }
    }
  }

  const reports = (await Promise.all(files.map((f) => checkFile(f)))).filter(
    (r): r is string => r !== null,
  )
  const { stdout, stderr, exitCode } = hookOutput(
    args.dialect,
    reports.length > 0 ? reports.join('\n\n') : null,
  )
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(`${stderr}\n`)
  process.exit(exitCode)
}

// A hook that throws must not wedge the agent: report the crash and exit clean.
// The checks are advisory, and `npm run check` is the real gate.
await main().catch((err: unknown) => {
  process.stderr.write(
    `[hook-file-check] skipped: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(0)
})
