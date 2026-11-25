/**
 * `afterFileEdit` hook — a targeted preview of `npm run check:local`, for one file.
 *
 * Wired from `.copse/hooks.json`, `.cursor/hooks.json` and `.claude/settings.json`
 * so an agent editing this repo through any of the three harnesses gets the same
 * feedback in a couple of seconds, instead of discovering it in a full `npm run
 * check` at the end of a long turn.
 *
 * What it runs, and what it deliberately does not:
 *
 *   • **Prettier** on the edited file (~1s). With `--fix` it **rewrites** the
 *     file rather than reporting it — formatting is deterministic and
 *     semantically neutral, and `afterFileEdit` is the formatter event
 *     (`after-file-edit.ts` awaits blocking hooks precisely so a formatter
 *     lands before the agent proceeds). A rewrite is always reported, because
 *     it makes the agent's copy stale.
 *   • **oxlint** on the edited file, **type-aware rules included** (~1–2s),
 *     with `.oxlintrc.json` — a port of `eslint.config.mjs`. Typed ESLint on
 *     one file pays ~10s to build the whole TypeScript program, so this hook
 *     used to run ESLint with the typed rules off; oxlint's tsgo-based
 *     type-aware pass builds the same program fast enough to run per edit, so
 *     unsafe assertions, floating promises and `??` misses surface here too.
 *   • **No `oxlint --fix`.** Its fixes are real code changes (`prefer-const`,
 *     import rewrites), and silently rewriting the meaning of a line the agent
 *     just wrote is a different thing from re-indenting it.
 *   • **Not** `tsc` — its diagnostics need the whole program reported, not
 *     scoped to one file.
 *
 * ESLint stays the lint gate (`npm run lint`). The two configs agree on every
 * rule the repo enables except where `.oxlintrc.json` says otherwise, but the
 * rule implementations are separate ports, so a finding here that ESLint would
 * not raise — or the reverse — is possible. So this is a fast pre-filter, never
 * a substitute for a pre-commit gate. The report says so, because a hook that
 * implies more coverage than it has is worse than no hook.
 *
 * Usage:
 *   node scripts/hook-file-check.mts <file>            # check a path directly
 *   node scripts/hook-file-check.mts <file> --fix      # …and reformat it
 *   node scripts/hook-file-check.mts <file> --no-lint  # format only (see below)
 *   node scripts/hook-file-check.mts --dialect copse   # read the payload on stdin
 *
 * `--no-lint` exists for Copse's *blocking* afterFileEdit entry: Copse awaits a
 * blocking hook only for its side effect (the rewrite) and honours a
 * `queueMessage` only from an `async` one, so linting there would make the
 * agent wait for findings nobody reads. `.copse/hooks.json` pairs it with an
 * async entry that does lint.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatSource, isUnformatted } from './lib/oxfmt.mts'
import {
  type Finding,
  type HookDialect,
  checkPlanFor,
  editedPathsFromPayload,
  hookOutput,
  isHookDialect,
  oxlintErrorLines,
  renderReport,
  siblingTestCandidates,
} from './lib/edited-file-check.mts'
import { isNonNull } from '@copse/std/nullish.ts'

/**
 * The repo root, derived from this file's own location rather than `cwd`.
 * Project hooks run from the thread's execution root, while user hooks retain
 * their declaring config's directory. Anchoring checks here also keeps direct
 * invocations independent of the caller's cwd and locates this repo's config.
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

type Args = { dialect: HookDialect; files: string[]; fix: boolean; lint: boolean }

function parseArgs(argv: string[]): Args {
  let dialect: HookDialect = 'cli'
  let fix = false
  let lint = true
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dialect') {
      const value = argv[++i]
      if (value !== undefined && isHookDialect(value)) dialect = value
    } else if (arg === '--fix') fix = true
    else if (arg === '--no-lint') lint = false
    else if (arg !== undefined && !arg.startsWith('-')) files.push(arg)
  }
  return { dialect, files, fix, lint }
}

/** Repo-relative and forward-slashed, for stable output and ignore matching. */
function toRepoRelative(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(ROOT, path)
  return relative(ROOT, abs).replace(/\\/g, '/')
}

/**
 * oxlint's JS entry, run under this Node rather than through the
 * `node_modules/.bin` shim, which is a `.cmd` file on Windows.
 */
const OXLINT_BIN = resolve(ROOT, 'node_modules/oxlint/bin/oxlint')

/** Run oxlint on one repo-relative path, from the repo root so it finds `.oxlintrc.json`. */
function runOxlint(rel: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [OXLINT_BIN, '--type-aware', '--quiet', '--format=json', rel],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

/**
 * oxlint, type-aware, on one file. Exit 0 is clean. Exit 1 means errors were
 * found *or* `.oxlintrc.json` ignores the path (see `oxlintErrorLines`), and
 * either way stdout holds a JSON report. Anything else, or exit 1 without a
 * report (a bad config), is a crash, thrown so `main` reports it and lets the
 * agent carry on.
 *
 * `abs` for every filesystem/tool call, `rel` for everything the agent reads.
 */
async function lintFindings(abs: string, rel: string): Promise<Finding[]> {
  if (!existsSync(OXLINT_BIN)) throw new Error('oxlint is not installed — run `pnpm install`')
  const result = await runOxlint(rel)
  if (result.code === 0) return []
  const lines = result.code === 1 ? oxlintErrorLines(result.stdout) : null
  if (lines === null) {
    throw new Error(
      // oxlint reports a bad config on stdout, a crash on stderr: show whichever said something.
      `oxlint exited ${String(result.code)} on ${abs}: ${(result.stderr.trim() || result.stdout.trim()).slice(-500)}`,
    )
  }
  if (lines.length === 0) return []
  return [{ tool: 'oxlint', detail: lines.join('\n'), fix: `npx oxlint --type-aware ${rel}` }]
}

/**
 * oxfmt on one file. Under `--fix` an unformatted file is **rewritten** and
 * reported as repaired rather than as a finding: formatting is deterministic
 * and semantically neutral, so making the agent spend a turn running
 * `oxfmt --write` on its own edit buys nothing.
 *
 * oxlint deliberately has no equivalent. `oxlint --fix` applies real code
 * changes (`prefer-const`, import rewrites), and rewriting the semantics of a
 * line the agent just wrote — without it seeing the change — is a different
 * thing from re-indenting it. Those stay reported, with the fix command.
 *
 * `isUnformatted` answers on the real path, so an ignored file and a file type
 * oxfmt does not handle both come back as "nothing to say" without a special
 * case here. The rewrite then formats the bytes we read, via stdin, so the
 * re-read guard below still means what it says.
 */
async function formatFile(
  abs: string,
  rel: string,
  fix: boolean,
): Promise<{ findings: Finding[]; repaired: string[] }> {
  const none = { findings: [], repaired: [] }
  if (!(await isUnformatted(abs))) return none

  if (!fix) {
    return {
      findings: [
        { tool: 'oxfmt', detail: '  file is not formatted', fix: `npx oxfmt --write ${rel}` },
      ],
      repaired: [],
    }
  }
  const source = await readFile(abs, 'utf8')
  const formatted = await formatSource(abs, source)
  // Re-read guard: only write when the file still holds what we formatted, so a
  // concurrent edit between the read and the write is never clobbered.
  if ((await readFile(abs, 'utf8')) !== source) return none
  await writeFile(abs, formatted, 'utf8')
  return { findings: [], repaired: ['oxfmt'] }
}

/** Run the checks for one file and return its report, or null when it is clean. */
async function checkFile(rawPath: string, args: Args): Promise<string | null> {
  const rel = toRepoRelative(rawPath)
  // An edit outside the repo (or to a file since deleted) is not ours to check.
  if (rel.startsWith('..')) return null
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs)) return null
  const plan = checkPlanFor(rel)
  if (plan === null) return null

  // Format first, serially: it can rewrite the file, and linting the pre-format
  // text would report columns that no longer exist by the time the agent reads.
  const formatted = plan.format
    ? await formatFile(abs, rel, args.fix)
    : { findings: [], repaired: [] }
  const lint = plan.lint && args.lint ? await lintFindings(abs, rel) : []
  const findings = [...lint, ...formatted.findings]

  const testHint =
    siblingTestCandidates(rel).find((candidate) => existsSync(resolve(ROOT, candidate))) ?? null
  return renderReport(rel, findings, formatted.repaired, testHint)
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

  const reports = (await Promise.all(files.map((f) => checkFile(f, args)))).filter(isNonNull)
  const { stdout, stderr, exitCode } = hookOutput(
    args.dialect,
    reports.length > 0 ? reports.join('\n\n') : null,
  )
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(`${stderr}\n`)
  process.exit(exitCode)
}

// A hook that throws must not wedge the agent: report the crash and exit clean.
// The checks are advisory; `npm run check:local` is the minimum pre-commit gate.
await main().catch((err: unknown) => {
  process.stderr.write(
    `[hook-file-check] skipped: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(0)
})
