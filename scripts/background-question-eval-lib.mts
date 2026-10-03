import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { classifyBatch } from '@copse/llm/classifiers/index.ts'
import { classifierRequestSchema } from '@copse/llm/classifiers/schemas.ts'
import type {
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
} from '@copse/llm/classifiers/types.ts'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import type { ModelUsage } from '@shared/types'
import {
  DEFAULT_LM_STUDIO_URL,
  LM_STUDIO_MODEL_IDS,
  preferIpv4LoopbackUrl,
} from '@shared/lm-studio-defaults.ts'
import { memberOf } from '@shared/member-of.ts'
import { MODEL_FOLLOW_UP_PRESETS } from '@shared/follow-ups/presets.ts'
import { parseCoverageMatches } from '@shared/roadmap/coverage.ts'
import { parseFitVerdict } from '@shared/roadmap/fit.ts'
import { parseReviewVerdict } from '@shared/roadmap/review.ts'
import type { GhIssueSummary } from '@shared/types/git.ts'
import { completeTextWithUsage } from '../src/main/services/providers/llm-complete-text.ts'
import {
  backgroundChoicePrompt,
  backgroundClassifierQuestion,
  likeliestChoice,
  parseChoiceWord,
  type BackgroundChoiceQuestion,
  type askClassifierBatch,
} from '../src/main/services/classifiers/background-classification.ts'
import { ROADMAP_COMPLEXITY_QUESTION } from '../src/main/services/roadmap-complexity.ts'
import { ROADMAP_CATEGORY_QUESTION } from '../src/main/services/roadmap-category.ts'
import { classifyCoverage, coveragePrompt } from '../src/main/services/roadmap-issue-coverage.ts'
import {
  classifyFollowUps,
  followUpPicksFromModel,
  followUpPrompt,
} from '../src/main/services/follow-up-service.ts'
import {
  classifyRoadmapFit,
  fitEvidence,
  fitPrompt,
} from '../src/main/services/roadmap-fit-check.ts'
import {
  classifyRoadmapReview,
  reviewEvidence,
  reviewPrompt,
  reviewSectionChars,
} from '../src/main/services/roadmap-review.ts'
import { parseClassifierEvalProfile } from './classifier-eval.ts'
import {
  CATEGORY_CASES,
  COMPLEXITY_CASES,
  COVERAGE_ISSUES,
  COVERAGE_ROADMAP,
  FIT_CASES,
  FOLLOW_UP_CASES,
  REVIEW_CASES,
  type LabelCase,
  type ReviewCase,
} from '../benchmarks/background-questions/cases.ts'

/**
 * Compares the two backends a background question can use — the classifier
 * connection and the small-tasks model — on the labelled cases in
 * `benchmarks/background-questions/`. Each arm is asked exactly what the
 * product asks it: the classifier through the product's own classify functions,
 * the model through the product's prompt builders and parsers.
 */

export const BACKGROUND_QUESTIONS = [
  'complexity',
  'category',
  'coverage',
  'follow-ups',
  'fit',
  'review',
] as const
export type BackgroundQuestion = (typeof BACKGROUND_QUESTIONS)[number]
const isBackgroundQuestion = memberOf(BACKGROUND_QUESTIONS)

export const EVAL_ARMS = ['classifier', 'model'] as const
export type EvalArm = (typeof EVAL_ARMS)[number]
const isEvalArm = memberOf(EVAL_ARMS)

export type ClassifierInvoker = (
  requests: ClassifierRequest[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<ClassifierResult[]>

export type ModelInvoker = (
  prompt: string,
  timeoutMs: number,
) => Promise<{ text: string; usage: ModelUsage }>

/** How each question's cases render an answer: one string per case, null when none was given. */
type CaseAnswers = ReadonlyMap<string, string>

/** One product call: a single case, or every coverage issue at once. */
interface EvalUnit {
  id: string
  caseIds: readonly string[]
  /** The product's model timeout for this question. */
  timeoutMs: number
  classify: (ask: typeof askClassifierBatch) => Promise<CaseAnswers | null>
  prompt: string
  /** Null when the reply carries no answer the product would use. */
  parse: (text: string) => CaseAnswers | null
}

interface QuestionSet {
  question: BackgroundQuestion
  units: EvalUnit[]
  expected: ReadonlyMap<string, string>
  /** The label vocabulary, for a confusion matrix; absent for set-valued answers. */
  labels?: readonly string[]
  score: (caseId: string, answer: string | null) => { correct: boolean; costly: boolean }
}

export interface EvalAttempt {
  question: BackgroundQuestion
  arm: EvalArm
  repeat: number
  caseId: string
  expected: string
  answer: string | null
  correct: boolean
  /** A wrong answer that costs the user: a fit `likely`, a review `resolved`, a coverage `likely`. */
  costly: boolean
}

export interface EvalCall {
  question: BackgroundQuestion
  arm: EvalArm
  repeat: number
  unitId: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  raw?: string
  error?: string
}

export interface EvalSummary {
  question: BackgroundQuestion
  arm: EvalArm
  attempts: number
  answered: number
  correct: number
  accuracy: number
  answeredRate: number
  costly: number
  errors: number
  p50Ms: number
  p95Ms: number
  inputTokens: number
  outputTokens: number
  /** expected → answer ("(none)" when unanswered) → count, for label questions. */
  confusion?: Record<string, Record<string, number>>
}

export interface BackgroundQuestionEvalReport {
  schemaVersion: 1
  generatedAt: string
  classifier: string | null
  model: string | null
  repeats: number
  questions: BackgroundQuestion[]
  summaries: EvalSummary[]
  attempts: EvalAttempt[]
  calls: EvalCall[]
}

const NONE = '(none)'

function single(caseId: string, answer: string | null): CaseAnswers | null {
  return answer === null ? null : new Map([[caseId, answer]])
}

function labelSet<T extends string>(
  question: 'complexity' | 'category',
  definition: BackgroundChoiceQuestion<T>,
  cases: readonly LabelCase<T>[],
): QuestionSet {
  return {
    question,
    labels: definition.choices,
    expected: new Map(cases.map((c) => [c.id, c.expected])),
    score: (caseId, answer) => ({
      correct: answer === cases.find((c) => c.id === caseId)?.expected,
      costly: false,
    }),
    units: cases.map((c) => {
      // The product classifies the first 2,000 characters of a prompt.
      const state = c.text.slice(0, 2000)
      return {
        id: c.id,
        caseIds: [c.id],
        timeoutMs: 10_000,
        classify: async (ask): Promise<CaseAnswers | null> => {
          const results = await ask([
            { state, questions: { answer: backgroundClassifierQuestion(definition) } },
          ])
          const answer = likeliestChoice(definition.choices, results?.[0]?.answers['answer'])
          return single(c.id, answer?.choice ?? null)
        },
        prompt: backgroundChoicePrompt(definition, state),
        parse: (text) => single(c.id, parseChoiceWord(definition.choices, text)),
      }
    }),
  }
}

function coverageAnswer(match: { itemId: string; verdict: string } | null | undefined): string {
  return match ? `${match.itemId} ${match.verdict}` : NONE
}

function coverageSet(): QuestionSet {
  const open = COVERAGE_ISSUES.map(({ number, title, body }) => ({ number, title, body }))
  const caseId = (n: number): string => `#${String(n)}`
  const answers = (
    matches: readonly { issueNumber: number; itemId: string; verdict: string }[],
  ): CaseAnswers =>
    new Map(
      COVERAGE_ISSUES.map((issue) => [
        caseId(issue.number),
        coverageAnswer(matches.find((m) => m.issueNumber === issue.number)),
      ]),
    )
  const expected = new Map(
    COVERAGE_ISSUES.map((i) => [caseId(i.number), coverageAnswer(i.expected)]),
  )
  return {
    question: 'coverage',
    expected,
    score: (id, answer): { correct: boolean; costly: boolean } => {
      const want = expected.get(id)
      return {
        correct: answer === want,
        // A likely match disables importing the issue.
        costly: answer !== want && (answer?.endsWith(' likely') ?? false),
      }
    },
    units: [
      {
        id: 'roadmap',
        caseIds: COVERAGE_ISSUES.map((i) => caseId(i.number)),
        timeoutMs: 30_000,
        classify: async (ask): Promise<CaseAnswers | null> => {
          const matches = await classifyCoverage(open, COVERAGE_ROADMAP, ask)
          return matches && answers(matches)
        },
        prompt: coveragePrompt(open, COVERAGE_ROADMAP),
        parse: (text) =>
          answers(parseCoverageMatches(text, new Set(COVERAGE_ROADMAP.map((item) => item.id)))),
      },
    ],
  }
}

function followUpAnswer(picks: readonly { id: string }[]): string {
  return picks.length === 0
    ? NONE
    : picks
        .map((p) => p.id)
        .sort()
        .join(',')
}

/** The picks an answer names, from {@link followUpAnswer}. */
function followUpIds(answer: string | null): string[] {
  return answer === null || answer === NONE ? [] : answer.split(',')
}

/** Every required preset offered, and nothing outside required ∪ allowed. */
export function scoreFollowUps(
  required: readonly string[],
  allowed: readonly string[],
  answer: string | null,
): { correct: boolean; missed: string[]; unwanted: string[] } {
  const picks = followUpIds(answer)
  const missed = required.filter((id) => !picks.includes(id))
  const unwanted = picks.filter((id) => !required.includes(id) && !allowed.includes(id))
  return {
    correct: answer !== null && missed.length === 0 && unwanted.length === 0,
    missed,
    unwanted,
  }
}

function followUpSet(): QuestionSet {
  return {
    question: 'follow-ups',
    expected: new Map(
      FOLLOW_UP_CASES.map((c) => [c.id, followUpAnswer(c.required.map((id) => ({ id })))]),
    ),
    score: (caseId, answer): { correct: boolean; costly: boolean } => {
      const c = FOLLOW_UP_CASES.find((candidate) => candidate.id === caseId)
      return {
        correct: !!c && scoreFollowUps(c.required, c.allowed ?? [], answer).correct,
        costly: false,
      }
    },
    units: FOLLOW_UP_CASES.map((c) => ({
      id: c.id,
      caseIds: [c.id],
      timeoutMs: 15_000,
      classify: async (ask): Promise<CaseAnswers | null> => {
        const picks = await classifyFollowUps(c.context, ask)
        return picks && single(c.id, followUpAnswer(picks))
      },
      prompt: followUpPrompt(c.context),
      // An unreadable reply offers nothing in the product; score it as that answer.
      parse: (text) => single(c.id, followUpAnswer(followUpPicksFromModel(text))),
    })),
  }
}

function fitSet(): QuestionSet {
  return {
    question: 'fit',
    labels: ['unlikely', 'partial', 'likely'],
    expected: new Map(FIT_CASES.map((c) => [c.id, c.expected])),
    score: (caseId, answer): { correct: boolean; costly: boolean } => {
      const want = FIT_CASES.find((c) => c.id === caseId)?.expected
      return { correct: answer === want, costly: answer === 'likely' && want !== 'likely' }
    },
    units: FIT_CASES.map((c) => {
      const evidence = fitEvidence(c.issue, c.prompt)
      return {
        id: c.id,
        caseIds: [c.id],
        timeoutMs: 30_000,
        classify: async (ask) => single(c.id, await classifyRoadmapFit(evidence, ask)),
        prompt: fitPrompt(evidence),
        parse: (text) => single(c.id, parseFitVerdict(text)),
      }
    }),
  }
}

function pinnedIssue(c: ReviewCase): GhIssueSummary | null {
  if (!c.pinned) return null
  return {
    owner: 'copse-dev',
    repo: 'eval',
    number: c.pinned.number,
    title: c.pinned.title,
    url: `https://github.com/copse-dev/eval/issues/${String(c.pinned.number)}`,
    body: c.pinned.body,
    labels: [],
    state: c.pinned.state,
  }
}

function reviewSet(): QuestionSet {
  // The bulk review's section ceilings: the cases are far below them, so no
  // model context window trims the evidence.
  const sections = reviewSectionChars(1_000_000, 'bulk')
  return {
    question: 'review',
    labels: ['open', 'partial', 'likely', 'resolved'],
    expected: new Map(REVIEW_CASES.map((c) => [c.id, c.expected])),
    score: (caseId, answer): { correct: boolean; costly: boolean } => {
      const want = REVIEW_CASES.find((c) => c.id === caseId)?.expected
      return { correct: answer === want, costly: answer === 'resolved' && want !== 'resolved' }
    },
    units: REVIEW_CASES.map((c) => {
      const pinned = pinnedIssue(c)
      const linked = c.linked.map((issue) => ({ ref: `#${String(issue.number)}`, ...issue }))
      const evidence = reviewEvidence(c.item, pinned, linked, c.commits, 'bulk', sections)
      return {
        id: c.id,
        caseIds: [c.id],
        timeoutMs: 45_000,
        classify: async (ask) => single(c.id, await classifyRoadmapReview(evidence, 45_000, ask)),
        prompt: reviewPrompt(c.item, pinned, linked, c.commits, 'bulk', sections),
        parse: (text) => single(c.id, parseReviewVerdict(text)),
      }
    }),
  }
}

export function questionSet(question: BackgroundQuestion): QuestionSet {
  switch (question) {
    case 'complexity':
      return labelSet('complexity', ROADMAP_COMPLEXITY_QUESTION, COMPLEXITY_CASES)
    case 'category':
      return labelSet('category', ROADMAP_CATEGORY_QUESTION, CATEGORY_CASES)
    case 'coverage':
      return coverageSet()
    case 'follow-ups':
      return followUpSet()
    case 'fit':
      return fitSet()
    case 'review':
      return reviewSet()
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The product's classifier seam over an eval invoker: records the call's
 * tokens and error instead of swallowing them, and answers null on failure as
 * the product's own seam does.
 */
function recordingAsk(invoke: ClassifierInvoker, call: EvalCall): typeof askClassifierBatch {
  return async (requests, options) => {
    try {
      const results = await invoke([...requests], options)
      for (const result of results) {
        call.inputTokens += result.usage?.inputTokens ?? 0
        call.outputTokens += result.usage?.outputTokens ?? 0
      }
      if (results.length === requests.length) return results
      call.error = `expected ${String(requests.length)} results, got ${String(results.length)}`
    } catch (error) {
      call.error = errorText(error)
    }
    return null
  }
}

async function runUnit(
  unit: EvalUnit,
  arm: EvalArm,
  call: EvalCall,
  invokers: { classifier?: ClassifierInvoker; model?: ModelInvoker },
  modelTimeoutMs: number | undefined,
): Promise<CaseAnswers | null> {
  const started = performance.now()
  try {
    if (arm === 'classifier') {
      if (!invokers.classifier) throw new Error('No classifier configured.')
      const answers = await unit.classify(recordingAsk(invokers.classifier, call))
      if (!answers) call.error ??= 'unusable answer'
      return answers
    }
    if (!invokers.model) throw new Error('No model configured.')
    const { text, usage } = await invokers.model(unit.prompt, modelTimeoutMs ?? unit.timeoutMs)
    call.raw = text
    call.inputTokens += usage.inputTokens
    call.outputTokens += usage.outputTokens
    const answers = unit.parse(text)
    if (!answers) call.error = 'off-format reply'
    return answers
  } catch (error) {
    call.error = errorText(error)
    return null
  } finally {
    call.durationMs = Math.round(performance.now() - started)
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

export function summarize(
  sets: readonly QuestionSet[],
  arms: readonly EvalArm[],
  attempts: readonly EvalAttempt[],
  calls: readonly EvalCall[],
): EvalSummary[] {
  const summaries: EvalSummary[] = []
  for (const set of sets) {
    for (const arm of arms) {
      const mine = attempts.filter((a) => a.question === set.question && a.arm === arm)
      const myCalls = calls.filter((c) => c.question === set.question && c.arm === arm)
      const answered = mine.filter((a) => a.answer !== null).length
      const correct = mine.filter((a) => a.correct).length
      const durations = myCalls.map((c) => c.durationMs)
      let confusion: Record<string, Record<string, number>> | undefined
      if (set.labels) {
        confusion = {}
        for (const attempt of mine) {
          const row = (confusion[attempt.expected] ??= {})
          const column = attempt.answer ?? NONE
          row[column] = (row[column] ?? 0) + 1
        }
      }
      summaries.push({
        question: set.question,
        arm,
        attempts: mine.length,
        answered,
        correct,
        accuracy: mine.length === 0 ? 0 : correct / mine.length,
        answeredRate: mine.length === 0 ? 0 : answered / mine.length,
        costly: mine.filter((a) => a.costly).length,
        errors: myCalls.filter((c) => c.error !== undefined).length,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        inputTokens: myCalls.reduce((sum, c) => sum + c.inputTokens, 0),
        outputTokens: myCalls.reduce((sum, c) => sum + c.outputTokens, 0),
        ...(confusion ? { confusion } : {}),
      })
    }
  }
  return summaries
}

export interface EvalRunInput {
  questions: readonly BackgroundQuestion[]
  arms: readonly EvalArm[]
  repeats: number
  classifier?: ClassifierInvoker
  model?: ModelInvoker
  modelTimeoutMs?: number
  log?: (line: string) => void
}

export async function runBackgroundQuestionEval(
  input: EvalRunInput,
): Promise<{ summaries: EvalSummary[]; attempts: EvalAttempt[]; calls: EvalCall[] }> {
  const sets = input.questions.map(questionSet)
  const attempts: EvalAttempt[] = []
  const calls: EvalCall[] = []
  for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
    for (const set of sets) {
      for (const unit of set.units) {
        for (const arm of input.arms) {
          const call: EvalCall = {
            question: set.question,
            arm,
            repeat,
            unitId: unit.id,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
          }
          const answers = await runUnit(unit, arm, call, input, input.modelTimeoutMs)
          calls.push(call)
          for (const caseId of unit.caseIds) {
            const answer = answers?.get(caseId) ?? null
            const expected = set.expected.get(caseId) ?? NONE
            const { correct, costly } = set.score(caseId, answer)
            attempts.push({
              question: set.question,
              arm,
              repeat,
              caseId,
              expected,
              answer,
              correct,
              costly,
            })
            input.log?.(
              `  ${correct ? 'PASS' : 'fail'} ${set.question}/${caseId}/${arm}: ${answer ?? call.error ?? NONE}` +
                (correct ? '' : ` (want ${expected})`),
            )
          }
        }
      }
    }
  }
  return { summaries: summarize(sets, input.arms, attempts, calls), attempts, calls }
}

/** One classifier request per case, as the product builds it, with the labels as `expected`. */
export interface ClassifierFixtureLine {
  id: string
  state: ClassifierRequest['state']
  questions: ClassifierRequest['questions']
  expected?: Record<string, JsonValue>
}

function expectedAnswers(
  question: BackgroundQuestion,
  caseId: string,
): Record<string, JsonValue> | undefined {
  switch (question) {
    case 'complexity':
      return { answer: COMPLEXITY_CASES.find((c) => c.id === caseId)?.expected ?? null }
    case 'category':
      return { answer: CATEGORY_CASES.find((c) => c.id === caseId)?.expected ?? null }
    case 'fit':
      return { fit: FIT_CASES.find((c) => c.id === caseId)?.expected ?? null }
    case 'review':
      return { review: REVIEW_CASES.find((c) => c.id === caseId)?.expected ?? null }
    case 'follow-ups': {
      const c = FOLLOW_UP_CASES.find((candidate) => candidate.id === caseId)
      if (!c) return undefined
      // An allowed preset may go either way, so it has no expected answer.
      return Object.fromEntries(
        MODEL_FOLLOW_UP_PRESETS.filter((p) => !(c.allowed ?? []).includes(p.id)).map((p) => [
          p.id,
          c.required.includes(p.id),
        ]),
      )
    }
    case 'coverage': {
      const issue = COVERAGE_ISSUES.find((i) => `#${String(i.number)}` === caseId)
      if (!issue) return undefined
      return Object.fromEntries(
        COVERAGE_ROADMAP.map((item, index) => [
          `item-${String(index)}`,
          issue.expected?.itemId === item.id ? issue.expected.verdict : 'none',
        ]),
      )
    }
  }
}

/**
 * Every classifier request the product would send for these questions,
 * captured from the product's own classify functions and checked against the
 * classifier request schema.
 */
export async function classifierFixtures(
  questions: readonly BackgroundQuestion[],
): Promise<Map<BackgroundQuestion, ClassifierFixtureLine[]>> {
  const out = new Map<BackgroundQuestion, ClassifierFixtureLine[]>()
  for (const question of questions) {
    const lines: ClassifierFixtureLine[] = []
    for (const unit of questionSet(question).units) {
      const captured: { requests: readonly ClassifierRequest[] } = { requests: [] }
      await unit.classify((requests) => {
        captured.requests = requests
        return Promise.resolve(null)
      })
      for (const [index, request] of captured.requests.entries()) {
        const parsed = classifierRequestSchema.safeParse(request)
        if (!parsed.success) {
          throw new Error(
            `${question}/${unit.id}: invalid classifier request: ${parsed.error.message}`,
          )
        }
        // One request per case (coverage asks one per issue); otherwise number them.
        const caseId =
          captured.requests.length === unit.caseIds.length ? unit.caseIds[index] : undefined
        const expected = caseId === undefined ? undefined : expectedAnswers(question, caseId)
        lines.push({
          id: `${question}/${caseId ?? `${unit.id}-${String(index)}`}`,
          state: request.state,
          questions: request.questions,
          ...(expected ? { expected } : {}),
        })
      }
    }
    out.set(question, lines)
  }
  return out
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderReport(report: BackgroundQuestionEvalReport): string {
  const lines = [
    '# Background question eval',
    '',
    `Classifier: ${report.classifier ? `\`${report.classifier}\`` : '(not run)'}  `,
    `Model: ${report.model ? `\`${report.model}\`` : '(not run)'}  `,
    `Repeats: ${String(report.repeats)}`,
    '',
    '| Question | Arm | Correct | Answered | Costly | Errors | p50 ms | p95 ms | Tokens |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const s of report.summaries) {
    lines.push(
      `| ${s.question} | ${s.arm} | ${String(s.correct)}/${String(s.attempts)} (${percentage(s.accuracy)}) | ${percentage(s.answeredRate)} | ${String(s.costly)} | ${String(s.errors)} | ${String(s.p50Ms)} | ${String(s.p95Ms)} | ${String(s.inputTokens + s.outputTokens)} |`,
    )
  }
  for (const s of report.summaries) {
    if (!s.confusion) continue
    const columns = [
      ...new Set(Object.values(s.confusion).flatMap((row) => Object.keys(row))),
    ].sort()
    lines.push(
      '',
      `## ${s.question} — ${s.arm}`,
      '',
      `| Expected \\ answer | ${columns.map(cell).join(' | ')} |`,
      `| --- | ${columns.map(() => '---:').join(' | ')} |`,
    )
    for (const [expected, row] of Object.entries(s.confusion)) {
      lines.push(`| ${cell(expected)} | ${columns.map((c) => String(row[c] ?? 0)).join(' | ')} |`)
    }
  }
  const misses = report.attempts.filter((a) => !a.correct)
  if (misses.length > 0) {
    lines.push(
      '',
      '## Misses',
      '',
      '| Question | Case | Arm | Expected | Answer |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const a of misses) {
      lines.push(
        `| ${a.question} | ${cell(a.caseId)} | ${a.arm} | ${cell(a.expected)} | ${cell(a.answer ?? NONE)}${a.costly ? ' ⚠' : ''} |`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

export interface BackgroundQuestionEvalOptions {
  questions: BackgroundQuestion[]
  arms: EvalArm[]
  repeats: number
  classifierConfig?: string
  model: string
  baseUrl: string
  apiKey: string
  modelTimeoutMs?: number
  outDir: string
  dryRun: boolean
  writeFixtures?: string
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === '' ? undefined : value
}

const FLAGS_WITH_VALUES = [
  '--questions',
  '--arms',
  '--repeats',
  '--classifier-config',
  '--model',
  '--base-url',
  '--model-timeout-ms',
  '--out-dir',
  '--write-fixtures',
] as const
const takesValue = memberOf(FLAGS_WITH_VALUES)

function listFlag<T extends string>(
  value: string | undefined,
  valid: readonly T[],
  isValid: (candidate: unknown) => candidate is T,
  flag: string,
): T[] | undefined {
  if (value === undefined) return undefined
  const parts = [
    ...new Set(
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ]
  if (parts.length === 0 || !parts.every(isValid)) {
    throw new Error(`${flag} takes a comma-separated list of: ${valid.join(', ')}`)
  }
  return parts.filter(isValid)
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

export function parseBackgroundQuestionEvalArgs(
  args: readonly string[],
): BackgroundQuestionEvalOptions {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? ''
    // `pnpm run eval:background-questions -- …` passes the separator through.
    if (flag === '--') continue
    if (flag === '--dry-run') {
      switches.add(flag)
      continue
    }
    const value = args[index + 1]
    if (!takesValue(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(
        `Unknown or incomplete argument '${flag}'. Flags: --dry-run, ${FLAGS_WITH_VALUES.join(', ')}.`,
      )
    }
    values.set(flag, value)
    index += 1
  }
  const classifierConfig = values.get('--classifier-config')
  const arms =
    listFlag(values.get('--arms'), EVAL_ARMS, isEvalArm, '--arms') ??
    (classifierConfig ? ['classifier', 'model'] : ['model'])
  if (arms.includes('classifier') && !classifierConfig) {
    throw new Error('The classifier arm needs --classifier-config PATH.')
  }
  const model =
    values.get('--model') ?? envValue('LM_STUDIO_MODEL') ?? LM_STUDIO_MODEL_IDS.smallTasks
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const modelTimeoutMs = positiveInteger(values.get('--model-timeout-ms'), '--model-timeout-ms')
  const writeFixtures = values.get('--write-fixtures')
  return {
    questions: listFlag(
      values.get('--questions'),
      BACKGROUND_QUESTIONS,
      isBackgroundQuestion,
      '--questions',
    ) ?? [...BACKGROUND_QUESTIONS],
    arms,
    repeats: positiveInteger(values.get('--repeats'), '--repeats') ?? 1,
    ...(classifierConfig ? { classifierConfig } : {}),
    model,
    baseUrl: preferIpv4LoopbackUrl(
      values.get('--base-url') ??
        envValue('COPSE_EVAL_LM_STUDIO_URL') ??
        envValue('LM_STUDIO_BASE_URL') ??
        DEFAULT_LM_STUDIO_URL,
    ),
    apiKey: envValue('LM_STUDIO_API_KEY') ?? envValue('LM_API_TOKEN') ?? 'lm-studio',
    ...(modelTimeoutMs ? { modelTimeoutMs } : {}),
    outDir: values.get('--out-dir') ?? resolve('bench-results', 'background-questions', stamp),
    dryRun: switches.has('--dry-run'),
    ...(writeFixtures ? { writeFixtures } : {}),
  }
}

function loadClassifier(path: string): { label: string; invoke: ClassifierInvoker } {
  const profile = parseClassifierEvalProfile(readFileSync(path, 'utf8'))
  const connection = profile.connection
  const needsKey = connection.type === 'http' && connection.auth === 'bearer'
  const apiKey = needsKey && connection.apiKeyEnv ? envValue(connection.apiKeyEnv) : undefined
  if (needsKey && !apiKey) {
    throw new Error('Set the API key in the environment variable named by connection.apiKeyEnv.')
  }
  return {
    label: `${profile.id} (${profile.model})`,
    invoke: (requests, options) =>
      classifyBatch(profile, requests, { ...options, ...(apiKey ? { apiKey } : {}) }),
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseBackgroundQuestionEvalArgs(args)
  const fixtures = await classifierFixtures(options.questions)

  if (options.dryRun || options.writeFixtures) {
    for (const question of options.questions) {
      const set = questionSet(question)
      const longest = Math.max(...set.units.map((unit) => unit.prompt.length))
      console.log(
        `${question}: ${String(set.expected.size)} cases, ${String(fixtures.get(question)?.length ?? 0)} classifier requests (schema-valid), ${String(set.units.length)} model prompts (longest ${String(longest)} chars)`,
      )
    }
  }
  if (options.writeFixtures) {
    mkdirSync(options.writeFixtures, { recursive: true })
    for (const [question, lines] of fixtures) {
      const path = join(options.writeFixtures, `${question}.jsonl`)
      writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
      console.log(`wrote ${path}`)
    }
  }
  if (options.dryRun || options.writeFixtures) return

  const classifier = options.classifierConfig ? loadClassifier(options.classifierConfig) : null
  const useModel = options.arms.includes('model')
  const provider = useModel
    ? createLMStudioProvider(options.baseUrl, options.model, options.apiKey)
    : null
  const model: ModelInvoker | undefined = provider
    ? (prompt, timeoutMs): Promise<{ text: string; usage: ModelUsage }> =>
        completeTextWithUsage(provider, prompt, timeoutMs)
    : undefined

  console.log(
    `eval:background-questions questions=${options.questions.join(',')} arms=${options.arms.join(',')} repeats=${String(options.repeats)}`,
  )
  const run = await runBackgroundQuestionEval({
    questions: options.questions,
    arms: options.arms,
    repeats: options.repeats,
    ...(classifier ? { classifier: classifier.invoke } : {}),
    ...(model ? { model } : {}),
    ...(options.modelTimeoutMs ? { modelTimeoutMs: options.modelTimeoutMs } : {}),
    log: console.log,
  })
  const report: BackgroundQuestionEvalReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    classifier: options.arms.includes('classifier') ? (classifier?.label ?? null) : null,
    model: useModel ? options.model : null,
    repeats: options.repeats,
    questions: options.questions,
    ...run,
  }
  mkdirSync(options.outDir, { recursive: true })
  writeFileSync(join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(join(options.outDir, 'report.md'), renderReport(report), 'utf8')
  console.log(`eval:background-questions report=${join(options.outDir, 'report.md')}`)
  if (run.calls.every((call) => call.error !== undefined)) {
    throw new Error('Every call failed; the report contains the errors.')
  }
}

if (
  process.argv[1]?.endsWith('background-question-eval-lib.mts') ||
  process.argv[1]?.endsWith('background-question-eval-lib.cjs')
) {
  main().catch((error: unknown) => {
    console.error(`eval:background-questions: ${errorText(error)}`)
    process.exit(1)
  })
}
