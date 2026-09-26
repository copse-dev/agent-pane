import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import type { LLMProvider, ModelUsage } from '@shared/types'
import {
  DEFAULT_LM_STUDIO_URL,
  LM_STUDIO_MODEL_IDS,
  preferIpv4LoopbackUrl,
} from '@shared/lm-studio-defaults.ts'
import { cleanThreadTitle, threadTitlePrompt } from '@shared/thread-title.ts'
import { completeTextWithUsage } from '../src/main/services/providers/llm-complete-text.ts'
import {
  THREAD_TITLE_EVAL_CASES,
  type ThreadTitleEvalCase,
} from '../benchmarks/thread-titles/cases.ts'

export const THREAD_TITLE_EVAL_ARMS = ['legacy', 'candidate'] as const
export type ThreadTitleEvalArm = (typeof THREAD_TITLE_EVAL_ARMS)[number]

export interface ThreadTitleScore {
  pass: boolean
  formatPass: boolean
  conceptPass: boolean
  missingConcepts: string[][]
}

export interface ThreadTitleEvalAttempt {
  caseId: string
  arm: ThreadTitleEvalArm
  repeat: number
  raw: string
  title: string | null
  rawFormatPass: boolean
  score: ThreadTitleScore
  usage: ModelUsage
  durationMs: number
  error?: string
}

export interface ThreadTitleEvalSummary {
  arm: ThreadTitleEvalArm
  attempts: number
  passed: number
  passRate: number
  formatPassRate: number
  conceptPassRate: number
  rawFormatPassRate: number
  inputTokens: number
  outputTokens: number
}

export interface ThreadTitleEvalReport {
  schemaVersion: 1
  generatedAt: string
  model: string
  baseUrl: string
  repeats: number
  cases: string[]
  summaries: ThreadTitleEvalSummary[]
  attempts: ThreadTitleEvalAttempt[]
}

interface ThreadTitleEvalOptions {
  model: string
  baseUrl: string
  apiKey: string
  repeats: number
  arms: ThreadTitleEvalArm[]
  caseId?: string
  outDir: string
  requireCandidateNotWorse: boolean
}

function legacyThreadTitlePrompt(text: string): string {
  return (
    'Reply with ONLY a concise 3-5 word title in Title Case for the following request. ' +
    'If several messages are shown, they are one conversation: title it by its ' +
    'overall goal, not just the latest message. ' +
    'No quotes, no trailing punctuation.\n\nRequest:\n' +
    text.slice(0, 1500)
  )
}

/** The cleaner the product used with the legacy prompt, so each arm is scored as it shipped. */
function legacyCleanTitle(out: string): string | null {
  const firstLine = out.trim().split('\n')[0] ?? ''
  const title = firstLine.replace(/^["'#\s-]+|["'.\s]+$/g, '').slice(0, 60)
  return title || null
}

function promptForArm(arm: ThreadTitleEvalArm, input: string): string {
  return arm === 'candidate' ? threadTitlePrompt(input) : legacyThreadTitlePrompt(input)
}

export function cleanForArm(arm: ThreadTitleEvalArm, raw: string): string | null {
  return arm === 'candidate' ? cleanThreadTitle(raw) : legacyCleanTitle(raw)
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@+.#-]+/gu, ' ')
    .trim()
}

function containsConcept(title: string, alternatives: readonly string[]): boolean {
  const haystack = normalized(title)
  return alternatives.some((alternative) => haystack.includes(normalized(alternative)))
}

function titleFormatPass(title: string): boolean {
  const words = title.split(/\s+/).filter(Boolean)
  return (
    words.length >= 2 &&
    words.length <= 6 &&
    title.length <= 60 &&
    !/[\n\r]/.test(title) &&
    !/[`"'“”‘’]/.test(title) &&
    !/^\s*(?:#|\/\/|[-*•>])/.test(title) &&
    !/[.!?,:;]$/.test(title) &&
    !/^(?:can|could|would|will|please|help|sometimes|whenever|i'd|i want|got it)\b/i.test(title) &&
    !/^(?:fix|debug|investigate|improve|change|update)\s+(?:this|that|it)$/i.test(title)
  )
}

export function scoreThreadTitle(
  evalCase: ThreadTitleEvalCase,
  title: string | null,
): ThreadTitleScore {
  if (!title) {
    return {
      pass: false,
      formatPass: false,
      conceptPass: false,
      missingConcepts: evalCase.concepts.map((group) => [...group]),
    }
  }
  const missingConcepts = evalCase.concepts
    .filter((group) => !containsConcept(title, group))
    .map((group) => [...group])
  const formatPass = titleFormatPass(title)
  const conceptPass = missingConcepts.length === 0
  return { pass: formatPass && conceptPass, formatPass, conceptPass, missingConcepts }
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

export function summarizeThreadTitleEval(
  arms: readonly ThreadTitleEvalArm[],
  attempts: readonly ThreadTitleEvalAttempt[],
): ThreadTitleEvalSummary[] {
  return arms.map((arm) => {
    const selected = attempts.filter((attempt) => attempt.arm === arm)
    return {
      arm,
      attempts: selected.length,
      passed: selected.filter((attempt) => attempt.score.pass).length,
      passRate: rate(selected.filter((attempt) => attempt.score.pass).length, selected.length),
      formatPassRate: rate(
        selected.filter((attempt) => attempt.score.formatPass).length,
        selected.length,
      ),
      conceptPassRate: rate(
        selected.filter((attempt) => attempt.score.conceptPass).length,
        selected.length,
      ),
      rawFormatPassRate: rate(
        selected.filter((attempt) => attempt.rawFormatPass).length,
        selected.length,
      ),
      inputTokens: selected.reduce((sum, attempt) => sum + attempt.usage.inputTokens, 0),
      outputTokens: selected.reduce((sum, attempt) => sum + attempt.usage.outputTokens, 0),
    }
  })
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderReport(report: ThreadTitleEvalReport): string {
  const lines = [
    '# Thread title prompt eval',
    '',
    `Model: \`${report.model}\`  `,
    `Cases: ${String(report.cases.length)} × ${String(report.repeats)} repeat(s)`,
    '',
    '| Arm | End-to-end pass | Format | Concepts | Raw format | Tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const summary of report.summaries) {
    lines.push(
      `| ${summary.arm} | ${percentage(summary.passRate)} | ${percentage(summary.formatPassRate)} | ${percentage(summary.conceptPassRate)} | ${percentage(summary.rawFormatPassRate)} | ${String(summary.inputTokens + summary.outputTokens)} |`,
    )
  }
  lines.push(
    '',
    '| Case | Arm | Result | Clean title | Missing concepts |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const attempt of report.attempts) {
    const missing = attempt.score.missingConcepts.map((group) => group.join('/')).join(', ')
    lines.push(
      `| ${attempt.caseId} | ${attempt.arm} | ${attempt.score.pass ? 'pass' : 'fail'} | ${markdownCell(attempt.title ?? attempt.error ?? '(empty)')} | ${markdownCell(missing)} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function armOrder(
  arms: readonly ThreadTitleEvalArm[],
  caseIndex: number,
  repeat: number,
): ThreadTitleEvalArm[] {
  if (arms.length < 2 || (caseIndex + repeat) % 2 === 0) return [...arms]
  return [...arms].reverse()
}

async function runAttempt(
  provider: LLMProvider,
  evalCase: ThreadTitleEvalCase,
  arm: ThreadTitleEvalArm,
  repeat: number,
): Promise<ThreadTitleEvalAttempt> {
  const started = Date.now()
  try {
    const { text: raw, usage } = await completeTextWithUsage(
      provider,
      promptForArm(arm, evalCase.input),
      20_000,
    )
    const title = cleanForArm(arm, raw)
    const score = scoreThreadTitle(evalCase, title)
    return {
      caseId: evalCase.id,
      arm,
      repeat,
      raw,
      title,
      rawFormatPass: title !== null && raw.trim() === title && titleFormatPass(title),
      score,
      usage,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      caseId: evalCase.id,
      arm,
      repeat,
      raw: '',
      title: null,
      rawFormatPass: false,
      score: scoreThreadTitle(evalCase, null),
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runThreadTitleEval(
  options: ThreadTitleEvalOptions,
): Promise<ThreadTitleEvalReport> {
  const cases = options.caseId
    ? THREAD_TITLE_EVAL_CASES.filter((evalCase) => evalCase.id === options.caseId)
    : [...THREAD_TITLE_EVAL_CASES]
  if (cases.length === 0) throw new Error(`Unknown thread-title case '${options.caseId ?? ''}'.`)

  const provider = createLMStudioProvider(options.baseUrl, options.model, options.apiKey)
  const attempts: ThreadTitleEvalAttempt[] = []
  mkdirSync(options.outDir, { recursive: true })

  console.log(
    `eval:thread-titles model=${options.model} cases=${String(cases.length)} arms=${options.arms.join(',')} repeats=${String(options.repeats)}`,
  )
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    for (const [caseIndex, evalCase] of cases.entries()) {
      for (const arm of armOrder(options.arms, caseIndex, repeat)) {
        const attempt = await runAttempt(provider, evalCase, arm, repeat)
        attempts.push(attempt)
        console.log(
          `  ${attempt.score.pass ? 'PASS' : 'fail'} ${evalCase.id}/${arm}: ${attempt.title ?? attempt.error ?? '(empty)'}`,
        )
      }
    }
  }

  const report: ThreadTitleEvalReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: options.model,
    baseUrl: options.baseUrl,
    repeats: options.repeats,
    cases: cases.map((evalCase) => evalCase.id),
    summaries: summarizeThreadTitleEval(options.arms, attempts),
    attempts,
  }
  writeFileSync(join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(join(options.outDir, 'report.md'), renderReport(report), 'utf8')
  console.log(`eval:thread-titles report=${join(options.outDir, 'report.md')}`)

  if (attempts.every((attempt) => attempt.error !== undefined)) {
    throw new Error('Every model call failed; the report contains the provider errors.')
  }
  if (options.requireCandidateNotWorse) {
    const legacy = report.summaries.find((summary) => summary.arm === 'legacy')
    const candidate = report.summaries.find((summary) => summary.arm === 'candidate')
    if (!legacy || !candidate) {
      throw new Error('--require-candidate-not-worse requires both legacy and candidate arms.')
    }
    if (candidate.passRate < legacy.passRate) {
      throw new Error(
        `Candidate pass rate ${percentage(candidate.passRate)} is below legacy ${percentage(legacy.passRate)}.`,
      )
    }
  }
  return report
}

/** A trimmed environment value, treating an empty or blank value as unset. */
function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === '' ? undefined : value
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function positiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`)
  }
  return parsed
}

function parseArms(value: string | undefined): ThreadTitleEvalArm[] {
  const requested = (value ?? THREAD_TITLE_EVAL_ARMS.join(','))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const arms: ThreadTitleEvalArm[] = []
  for (const arm of requested) {
    const found = THREAD_TITLE_EVAL_ARMS.find((candidate) => candidate === arm)
    if (!found) throw new Error(`--arms must use: ${THREAD_TITLE_EVAL_ARMS.join(', ')}`)
    if (!arms.includes(found)) arms.push(found)
  }
  if (arms.length === 0) throw new Error('--arms must name at least one arm.')
  return arms
}

export function parseThreadTitleEvalArgs(args: readonly string[]): ThreadTitleEvalOptions {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const model =
    argValue(args, '--model') ?? envValue('LM_STUDIO_MODEL') ?? LM_STUDIO_MODEL_IDS.smallTasks
  const caseId = argValue(args, '--case')
  return {
    model,
    baseUrl: preferIpv4LoopbackUrl(
      argValue(args, '--base-url') ??
        envValue('COPSE_EVAL_LM_STUDIO_URL') ??
        envValue('LM_STUDIO_BASE_URL') ??
        DEFAULT_LM_STUDIO_URL,
    ),
    apiKey: envValue('LM_STUDIO_API_KEY') ?? envValue('LM_API_TOKEN') ?? 'lm-studio',
    repeats: positiveInteger(argValue(args, '--repeats'), 1, '--repeats'),
    arms: parseArms(argValue(args, '--arms')),
    ...(caseId ? { caseId } : {}),
    outDir:
      argValue(args, '--out-dir') ??
      resolve('bench-results', 'thread-titles', `${stamp}-${model.replace(/[^a-z0-9]+/gi, '-')}`),
    requireCandidateNotWorse: args.includes('--require-candidate-not-worse'),
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  await runThreadTitleEval(parseThreadTitleEvalArgs(args))
}

if (
  process.argv[1]?.endsWith('thread-title-eval-lib.mts') ||
  process.argv[1]?.endsWith('thread-title-eval-lib.cjs')
) {
  main().catch((error: unknown) => {
    console.error(`eval:thread-titles: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
