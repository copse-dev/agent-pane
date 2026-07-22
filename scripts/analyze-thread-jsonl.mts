/**
 * Deterministic metrics on an exported copse thread (JSONL from export-thread.ts).
 * Usage: node --experimental-strip-types scripts/analyze-thread-jsonl.mts <file.jsonl> [scenario.json]
 */
import { readFileSync } from 'node:fs'
import {
  scoreDoctrineCompliance,
  type DoctrineToolCall,
  type UserIntent,
} from '@shared/agent/doctrine-compliance.ts'
import { shouldSteerGithubLinks } from '@shared/git/github-link-steering.ts'
import { shouldSteerTodos } from '@shared/todos/todo-logic.ts'
import { expectString } from '../src/shared/unknown-value.mts'
import { z } from 'zod'

interface ScenarioExpect {
  shouldSteerGithubLinks?: boolean | undefined
  requireGithubLinksInReply?: boolean | undefined
  shouldSteerTodos?: boolean | undefined
  maxExplore?: number | undefined
  minExplore?: number | undefined
  requireTools?: string[] | undefined
  forbidTools?: string[] | undefined
  maxInputTokens?: number | undefined
  requireUpdateTodos?: boolean | undefined
  forbidParallelExploreTurn1?: boolean | undefined
  /** When true, score the transcript against the working-style doctrine (#744). */
  requireDoctrineCompliance?: boolean | undefined
  /** Optional intent label for doctrine scoring; inferred from the user message when omitted. */
  userIntent?: UserIntent | undefined
  /** Optional in-scope edit paths for doctrine scopeDiscipline. */
  inScopePaths?: string[] | undefined
}

interface Scenario {
  id?: string | undefined
  description?: string | undefined
  prompts?: string[] | undefined
  expect?: ScenarioExpect | undefined
}

type Usage = {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  cacheCreationTokens?: number | undefined
}

type JsonlRecord = {
  type: string
  role?: string | undefined
  content?: string | undefined
  toolCalls?:
    | Array<{
        id?: string | undefined
        name: string
        status?: string | undefined
        args?: Record<string, unknown> | undefined
        subagent?:
          | {
              prompt?: string | undefined
              usage?: Usage | undefined
              messages?:
                | Array<{
                    toolCalls?:
                      | Array<{ name: string; args?: Record<string, unknown> | undefined }>
                      | undefined
                  }>
                | undefined
            }
          | undefined
      }>
    | undefined
  usage?: Usage | undefined
  title?: string | undefined
}

const usageSchema: z.ZodType<Usage> = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
})
const nestedToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
})
const jsonlRecordSchema: z.ZodType<JsonlRecord> = z.object({
  type: z.string(),
  role: z.string().optional(),
  content: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        status: z.string().optional(),
        args: z.record(z.string(), z.unknown()).optional(),
        subagent: z
          .object({
            prompt: z.string().optional(),
            usage: usageSchema.optional(),
            messages: z
              .array(z.object({ toolCalls: z.array(nestedToolCallSchema).optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: usageSchema.optional(),
  title: z.string().optional(),
})
const scenarioSchema: z.ZodType<Scenario> = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  prompts: z.array(z.string()).optional(),
  expect: z
    .object({
      shouldSteerGithubLinks: z.boolean().optional(),
      requireGithubLinksInReply: z.boolean().optional(),
      shouldSteerTodos: z.boolean().optional(),
      maxExplore: z.number().optional(),
      minExplore: z.number().optional(),
      requireTools: z.array(z.string()).optional(),
      forbidTools: z.array(z.string()).optional(),
      maxInputTokens: z.number().optional(),
      requireUpdateTodos: z.boolean().optional(),
      forbidParallelExploreTurn1: z.boolean().optional(),
    })
    .optional(),
})

/** Cache-vs-fresh breakdown of a usage record (cache tokens are a subset of inputTokens). */
function cacheBreakdown(usage: Usage): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  freshInputTokens: number
  cacheHitRatio: number | null
} | null {
  const inputTokens = usage.inputTokens ?? 0
  const hasCache = usage.cacheReadTokens !== undefined || usage.cacheCreationTokens !== undefined
  if (!hasCache) return null
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0
  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens,
    freshInputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens),
    cacheHitRatio: inputTokens > 0 ? Number((cacheReadTokens / inputTokens).toFixed(3)) : null,
  }
}

function subagentUsages(records: JsonlRecord[]): Array<{
  prompt: string
  messages: number
  usage: Usage | null
}> {
  const out: Array<{ prompt: string; messages: number; usage: Usage | null }> = []
  for (const r of records) {
    if (r.role !== 'assistant') continue
    for (const tc of r.toolCalls ?? []) {
      if (tc.name !== 'explore' || !tc.subagent) continue
      out.push({
        prompt: (tc.subagent.prompt ?? '').slice(0, 80),
        messages: tc.subagent.messages?.length ?? 0,
        usage: tc.subagent.usage ?? null,
      })
    }
  }
  return out
}

function loadJsonl(path: string): JsonlRecord[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => jsonlRecordSchema.parse(JSON.parse(line) as unknown))
}

function subagentReads(records: JsonlRecord[]): { path: string; exploreId: string }[] {
  const out: { path: string; exploreId: string }[] = []
  for (const r of records) {
    if (r.role !== 'assistant') continue
    for (const tc of r.toolCalls ?? []) {
      if (tc.name !== 'explore') continue
      const eid = tc.id?.slice(0, 8) ?? '?'
      for (const m of tc.subagent?.messages ?? []) {
        for (const st of m.toolCalls ?? []) {
          if (st.name === 'read_file' && typeof st.args?.['path'] === 'string') {
            out.push({ path: st.args['path'], exploreId: eid })
          }
        }
      }
    }
  }
  return out
}

function analyze(path: string, scenario?: Scenario): void {
  const records = loadJsonl(path)
  const thread = records[0]
  const user = records.find((r) => r.role === 'user')
  const userText = typeof user?.content === 'string' ? user.content : JSON.stringify('')

  const toolHist: Record<string, number> = {}
  const doctrineToolCalls: DoctrineToolCall[] = []
  let exploreCount = 0
  let updateTodos = 0
  let firstAssistantToolCount = 0
  let firstAssistantExploreCount = 0

  for (const r of records) {
    if (r.role !== 'assistant') continue
    const tcs = r.toolCalls ?? []
    if (firstAssistantToolCount === 0 && tcs.length > 0) {
      firstAssistantToolCount = tcs.length
      firstAssistantExploreCount = tcs.filter((t) => t.name === 'explore').length
    }
    for (const tc of tcs) {
      toolHist[tc.name] = (toolHist[tc.name] ?? 0) + 1
      if (tc.name === 'explore') exploreCount++
      if (tc.name === 'update_todos') updateTodos++
      const doctrineCall: DoctrineToolCall = { name: tc.name }
      if (tc.args) doctrineCall.args = tc.args
      if (tc.status) doctrineCall.status = tc.status
      const resultText = (tc as { result?: unknown }).result
      if (typeof resultText === 'string') doctrineCall.result = resultText
      doctrineToolCalls.push(doctrineCall)
    }
  }

  const reads = subagentReads(records)
  const byPath = new Map<string, string[]>()
  for (const { path: p, exploreId } of reads) {
    const list = byPath.get(p) ?? []
    list.push(exploreId)
    byPath.set(p, list)
  }
  const dupPaths = [...byPath.entries()]
    .filter(([, ex]) => ex.length > 1)
    .sort((a, b) => b[1].length - a[1].length)

  const steerTodos = shouldSteerTodos(userText)
  const steerGithubLinks = shouldSteerGithubLinks(userText)
  const usage = thread?.usage ?? {}
  const assistants = records.filter((r) => r.role === 'assistant')
  const finalText =
    typeof assistants.at(-1)?.content === 'string' ? expectString(assistants.at(-1)?.content) : ''

  const violations: string[] = []
  const exp = scenario?.expect
  if (exp?.shouldSteerGithubLinks === true && !steerGithubLinks) {
    violations.push(
      'expected shouldSteerGithubLinks true for user message (check scenario prompt vs heuristic)',
    )
  }
  if (exp?.shouldSteerGithubLinks === false && steerGithubLinks) {
    violations.push('shouldSteerGithubLinks was true but scenario expected false')
  }
  if (exp?.requireGithubLinksInReply && !/https?:\/\/github\.com\//i.test(finalText)) {
    violations.push('expected at least one github.com URL in the final assistant reply')
  }
  if (exp?.shouldSteerTodos === true && !steerTodos) {
    violations.push(
      'expected shouldSteerTodos true for user message (check scenario prompt vs heuristic)',
    )
  }
  if (exp?.shouldSteerTodos === false && steerTodos) {
    violations.push('shouldSteerTodos was true but scenario expected false')
  }
  if (exp?.requireUpdateTodos && updateTodos === 0) {
    violations.push('expected at least one update_todos call')
  }
  if (exp?.maxExplore !== undefined && exploreCount > exp.maxExplore) {
    violations.push(`explore count ${String(exploreCount)} > max ${String(exp.maxExplore)}`)
  }
  if (exp?.minExplore !== undefined && exploreCount < exp.minExplore) {
    violations.push(`explore count ${String(exploreCount)} < min ${String(exp.minExplore)}`)
  }
  for (const t of exp?.requireTools ?? []) {
    if ((toolHist[t] ?? 0) <= 0) violations.push(`missing required tool: ${t}`)
  }
  for (const t of exp?.forbidTools ?? []) {
    if ((toolHist[t] ?? 0) > 0) violations.push(`forbidden tool used: ${t}`)
  }
  if (exp?.maxInputTokens !== undefined && (usage.inputTokens ?? 0) > exp.maxInputTokens) {
    violations.push(`input tokens ${String(usage.inputTokens)} > max ${String(exp.maxInputTokens)}`)
  }
  if (exp?.forbidParallelExploreTurn1 && firstAssistantExploreCount > 1) {
    violations.push(
      `first assistant turn had ${String(firstAssistantExploreCount)} parallel explore calls (turn had ${String(firstAssistantToolCount)} tools total)`,
    )
  }

  const doctrineTranscript = {
    userMessage: userText,
    toolCalls: doctrineToolCalls,
    finalMessage: finalText,
    ...(exp?.userIntent !== undefined ? { userIntent: exp.userIntent } : {}),
    ...(exp?.inScopePaths !== undefined ? { inScopePaths: exp.inScopePaths } : {}),
  }
  const doctrine = scoreDoctrineCompliance(doctrineTranscript)
  if (exp?.requireDoctrineCompliance && !doctrine.pass) {
    for (const id of doctrine.violations) {
      violations.push(`doctrine:${id}`)
    }
  }

  const report = {
    file: path,
    scenarioId: scenario?.id ?? null,
    title: thread?.title,
    userMessage: userText.slice(0, 500),
    shouldSteerGithubLinks: steerGithubLinks,
    shouldSteerTodos: steerTodos,
    usage,
    cache: cacheBreakdown(usage),
    subagents: subagentUsages(records),
    toolHistogram: toolHist,
    exploreCount,
    updateTodosCount: updateTodos,
    assistantTurns: assistants.length,
    finalAnswerChars: finalText.length,
    subagentReadCount: reads.length,
    duplicateReadPaths: dupPaths
      .slice(0, 15)
      .map(([p, ex]) => ({ path: p, count: ex.length, explores: [...new Set(ex)] })),
    doctrine,
    violations,
    pass: violations.length === 0,
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.pass) process.exitCode = 1
}

const jsonlPath = process.argv[2]
if (!jsonlPath) {
  console.error('Usage: analyze-thread-jsonl.mts <thread.jsonl> [scenario.json]')
  process.exit(1)
}
const scenarioPath = process.argv[3]
const scenario = scenarioPath
  ? scenarioSchema.parse(JSON.parse(readFileSync(scenarioPath, 'utf8')) as unknown)
  : undefined
analyze(jsonlPath, scenario)
