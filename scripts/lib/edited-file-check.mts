/**
 * Pure helpers for the `afterFileEdit` targeted check (`scripts/hook-file-check.mts`).
 *
 * The hook's job is to give an agent the same feedback `npm run check` would,
 * for the one file it just edited, in about the time it takes to read the tool
 * result — so a typo is fixed while the change is still in mind instead of
 * surfacing minutes later as a wall of unrelated failures.
 *
 * Everything here is I/O-free and unit-tested; `hook-file-check.mts` supplies
 * stdin, the linters, and the filesystem.
 */
import { z } from 'zod'
import { memberOf } from '@copse/std/member-of.ts'
import { isRecord } from '../../src/shared/unknown-value.mts'
import { isDefined } from '@copse/std/nullish.ts'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

/**
 * Which agent is running the hook. It decides only how a finding is *reported*,
 * because the three harnesses read a hook differently:
 *
 * - `claude` — Claude Code feeds a `PostToolUse` hook's **stderr** back to the
 *   model when it exits 2, and ignores it otherwise. That exit code is the only
 *   channel to the model, so findings must exit 2.
 * - `copse`  — Copse's `afterFileEdit` is notification-only; the one route back
 *   to the agent is a `queueMessage` on **stdout**, honoured for `async` hooks.
 *   Its adapter parses stdout regardless of exit code.
 * - `cursor` — Cursor's `afterFileEdit` "cannot block the agent or return data
 *   to it", and a non-zero exit is recorded as *the hook failing*. Findings are
 *   a successful run, so this one always exits 0 and writes to stderr for the
 *   human reading the hook log.
 * - `cli`    — run by hand (`node scripts/hook-file-check.mts <file>`); plain
 *   text and a conventional non-zero exit.
 */
export type HookDialect = 'claude' | 'copse' | 'cursor' | 'cli'

export const HOOK_DIALECTS: readonly HookDialect[] = ['claude', 'copse', 'cursor', 'cli']

export const isHookDialect: (value: string) => value is HookDialect = memberOf(HOOK_DIALECTS)

/** One tool's complaint about the edited file. */
export type Finding = {
  /** The tool that produced it, e.g. `oxlint` / `oxfmt`. */
  tool: string
  /** Human-readable detail, already formatted by that tool. */
  detail: string
  /** The command that reproduces (and for prettier, fixes) it. */
  fix: string
}

/**
 * The part of `oxlint --format=json` the hook reads. oxlint is a separate
 * binary, so its stdout is untrusted input: anything that does not match is
 * rejected rather than half-read. `code` is absent on diagnostics that belong
 * to no rule (an unused-directive report, say); a diagnostic with no label has
 * no position, and oxlint writes a `null` line and column for a label whose
 * span it cannot place in the source.
 */
const oxlintReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      message: z.string(),
      code: z.string().optional(),
      severity: z.string(),
      labels: z
        .array(
          z.object({
            span: z.object({ line: z.number().nullable(), column: z.number().nullable() }),
          }),
        )
        .optional(),
    }),
  ),
})

/**
 * One line per error in an `oxlint --format=json` report, in the
 * `line:column  message  rule` shape the hook prints, or null when `stdout` is
 * not such a report. Warnings are dropped: the hook reports what would fail
 * the gate, and every rule the repo enables is an error. Sorted by position,
 * because oxlint groups its output by rule and an agent reads a file top down;
 * an unknown position prints as `?` and sorts last.
 */
export function oxlintErrorLines(stdout: string): string[] | null {
  const report = safeJsonParse(stdout, decodeWithSchema(oxlintReportSchema))
  if (report === null) return null
  return report.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => {
      // No label at all is a file-level diagnostic: report it first, at 0:0.
      const span = diagnostic.labels?.[0]?.span ?? { line: 0, column: 0 }
      const position = `${String(span.line ?? '?')}:${String(span.column ?? '?')}`
      return {
        line: span.line ?? Number.POSITIVE_INFINITY,
        column: span.column ?? Number.POSITIVE_INFINITY,
        text: `  ${position}  ${diagnostic.message}  ${diagnostic.code ?? ''}`.trimEnd(),
      }
    })
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map(({ text }) => text)
}

/** How one oxlint run ended, as `scripts/hook-file-check.mts` observed it. */
export type OxlintRun = { code: number | null; stdout: string; stderr: string }

/**
 * The hook's findings for one oxlint run on `rel`.
 *
 * Exit 0 is clean (an ignored path included, under
 * `--no-error-on-unmatched-pattern`). Exit 1 with a report is the errors it
 * lists. Anything else — a crash, a kill, a config oxlint rejects, exit 1
 * without a report — is a lint that did not happen, and it is reported as a
 * finding rather than thrown: a throw would unwind past the format step and
 * lose its "rewritten on disk" report, and a hook that stays silent when it
 * checked nothing reads as "clean" to the agent.
 */
export function oxlintFindings(rel: string, run: OxlintRun): Finding[] {
  if (run.code === 0) return []
  const lines = run.code === 1 ? oxlintErrorLines(run.stdout) : null
  if (lines !== null) {
    return lines.length === 0
      ? []
      : [{ tool: 'oxlint', detail: lines.join('\n'), fix: `npx oxlint --type-aware ${rel}` }]
  }
  // A bad config is reported on stdout, a crash on stderr: show whichever spoke.
  const said = (run.stderr.trim() || run.stdout.trim()).slice(-500)
  const exit = run.code === null ? 'was killed' : `exited ${String(run.code)}`
  return [
    lintSkipped(
      `oxlint ${exit}${said === '' ? '' : `: ${said}`}`,
      `npx oxlint --type-aware ${rel}`,
    ),
  ]
}

/** A finding that says the lint did not run, and how to make it run. */
export function lintSkipped(reason: string, fix: string): Finding {
  return { tool: 'oxlint', detail: `  skipped — ${reason}`, fix }
}

export type HookArgs = { dialect: HookDialect; files: string[]; fix: boolean; lint: boolean }

/**
 * The hook's command line. `--fix` rewrites an unformatted file; `--no-lint`
 * formats only (Copse's blocking entry, whose output Copse never reads);
 * `--dialect` picks the output channel. Bare arguments are paths; an unknown
 * dialect or flag is ignored rather than fatal, because a hook that refuses to
 * start reports nothing at all.
 */
export function parseHookArgs(argv: readonly string[]): HookArgs {
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

/** What the checker should run for a given file. */
export type CheckPlan = { lint: boolean; format: boolean }

const LINTABLE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/
const FORMATTABLE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|json|jsonc|css|html|md|ya?ml)$/

/**
 * What to run for `path`, or null when the file is outside both tools' reach.
 * Cheap extension gate only — ESLint's and Prettier's own ignore files are the
 * authority on exclusions, and both are consulted before anything runs.
 */
export function checkPlanFor(path: string): CheckPlan | null {
  const normalized = path.replace(/\\/g, '/')
  const lint = LINTABLE.test(normalized)
  const format = FORMATTABLE.test(normalized)
  return lint || format ? { lint, format } : null
}

/** Value at `key` if it is a non-empty string, else undefined. */
function stringField(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The edited file path(s) carried by a hook payload, in any dialect.
 *
 * Copse and Cursor put `file_path` at the top level; Claude Code nests the
 * tool's arguments under `tool_input` (`file_path` for Edit/Write/MultiEdit,
 * `notebook_path` for NotebookEdit) and echoes the result under
 * `tool_response`. Reading all of them means one script serves every harness,
 * and an unrecognised payload yields `[]` rather than a wrong path.
 */
export function editedPathsFromPayload(payload: unknown): string[] {
  if (!isRecord(payload)) return []
  const toolInput = payload['tool_input']
  const toolResponse = payload['tool_response']
  const candidates = [
    stringField(payload, 'file_path'),
    stringField(payload, 'filePath'),
    stringField(toolInput, 'file_path'),
    stringField(toolInput, 'notebook_path'),
    stringField(toolResponse, 'filePath'),
  ]
  return [...new Set(candidates.filter(isDefined))]
}

/**
 * The unit test that most directly covers `path`: the `*.test.ts` beside it.
 * Deliberately only the sibling — the import graph would find more, but walking
 * it costs more than the whole check and the answer would arrive too late to
 * act on. Callers filter these by what exists on disk.
 */
export function siblingTestCandidates(path: string): string[] {
  const normalized = path.replace(/\\/g, '/')
  const match = /\.(ts|mts|tsx)$/.exec(normalized)
  if (match === null) return []
  if (/\.test\.(?:ts|mts|tsx)$/.test(normalized)) return [normalized]
  const ext = match[1]
  if (ext === undefined) return []
  const stem = normalized.slice(0, -(ext.length + 1))
  // `.test.ts` as well as the source's own extension: the suite is bundled from
  // `*.test.ts` only, so a `.mts`/`.tsx` module's tests live in a `.test.ts`.
  return [...new Set([`${stem}.test.${ext}`, `${stem}.test.ts`])]
}

/**
 * The report an agent reads, or null when there is nothing to say.
 *
 * `repaired` names what the hook changed on disk. Reporting a repair is not
 * optional politeness: the agent's picture of the file is now stale, and a
 * later edit matching against remembered text would fail against content it
 * never saw. So a silent auto-fix is worse than none — the report always leads
 * with the rewrite and tells the agent to re-read.
 */
export function renderReport(
  file: string,
  findings: Finding[],
  repaired: string[],
  testHint: string | null,
): string | null {
  if (findings.length === 0 && repaired.length === 0) return null
  const lines: string[] = []
  if (repaired.length > 0) {
    lines.push(`${file}: rewritten on disk by ${repaired.join(', ')}.`)
    lines.push('Re-read it before your next edit — your copy is stale.')
    lines.push('')
  }
  if (findings.length > 0) {
    lines.push(`${file}: ${String(findings.length)} issue(s) the hook cannot fix for you.`)
    lines.push('')
  }
  for (const finding of findings) {
    lines.push(`[${finding.tool}]`)
    lines.push(finding.detail.trimEnd())
    lines.push(`  fix: ${finding.fix}`)
    lines.push('')
  }
  lines.push('This check is a fast subset: formatting and oxlint, type-aware rules included.')
  lines.push(
    '`npm run check:local` is the minimum gate — it adds tsc and ESLint, which remains the lint gate.',
  )
  lines.push('Use `npm run check` when the AGENTS.md risk policy requires the complete suite.')
  if (testHint !== null) lines.push(`Covering unit test: npm test -- ${testHint}`)
  return lines.join('\n')
}

/** Where the report goes and what to exit with, for one dialect. */
export type HookOutput = { stdout: string; stderr: string; exitCode: number }

/**
 * Route a report to the channel its harness actually reads. See
 * {@link HookDialect} for why each one differs.
 */
export function hookOutput(dialect: HookDialect, report: string | null): HookOutput {
  if (report === null) return { stdout: '', stderr: '', exitCode: 0 }
  switch (dialect) {
    case 'claude':
      return { stdout: '', stderr: report, exitCode: 2 }
    case 'copse':
      // Exit 0: the check found something, which is the hook working. Copse
      // parses stdout either way, but a non-zero exit would also badge the hook
      // as failed in Settings → Sources.
      return { stdout: JSON.stringify({ queueMessage: { text: report } }), stderr: '', exitCode: 0 }
    case 'cursor':
      return { stdout: '', stderr: report, exitCode: 0 }
    case 'cli':
      return { stdout: '', stderr: report, exitCode: 1 }
  }
}
