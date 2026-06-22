/**
 * Deterministic metrics on an exported copse thread (JSONL from export-thread.ts).
 * Usage: node --experimental-strip-types scripts/analyze-thread-jsonl.mts <file.jsonl> [scenario.json]
 */
import { readFileSync } from 'node:fs'
import { shouldSteerGithubLinks } from '@shared/git/github-link-steering.ts'
import { shouldSteerTodos } from '@shared/todos/todo-logic.ts'

interface ScenarioExpect {
  shouldSteerGithubLinks?: boolean
  requireGithubLinksInReply?: boolean
  shouldSteerTodos?: boolean
  maxExplore?: number
  minExplore?: number
  requireTools?: string[]
  forbidTools?: string[]
  maxInputTokens?: number
  requireUpdateTodos?: boolean
  forbidParallelExploreTurn1?: boolean
}

interface Scenario {
  id?: string
  description?: string
  prompts?: string[]
  expect?: ScenarioExpect
}

type JsonlRecord = {
  type: string
  role?: string
  content?: string
  toolCalls?: Array<{
    name: string
    status?: string
    args?: Record<string, unknown>
    subagent?: {
      messages?: Array<{ toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> }>
    }
  }>
  usage?: { inputTokens?: number; outputTokens?: number }
  title?: string
}

function loadJsonl(path: string): JsonlRecord[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlRecord)
}

function subagentReads(records: JsonlRecord[]): { path: string; exploreId: string }[] {
  const out: { path: string; exploreId: string }[] = []
  for (const r of records) {
    if (r.role !== 'assistant') continue
    for (const tc of r.toolCalls ?? []) {
      if (tc.name !== 'explore') continue
      const eid = (tc as { id?: string }).id?.slice(0, 8) ?? '?'
      for (const m of tc.subagent?.messages ?? []) {
        for (const st of m.toolCalls ?? []) {
          if (st.name === 'read_file' && typeof st.args?.path === 'string') {
            out.push({ path: st.args.path, exploreId: eid })
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
  const userText =
    typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '')

  const toolHist: Record<string, number> = {}
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
    typeof assistants.at(-1)?.content === 'string' ? (assistants.at(-1)?.content as string) : ''

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
    violations.push(`explore count ${exploreCount} > max ${exp.maxExplore}`)
  }
  if (exp?.minExplore !== undefined && exploreCount < exp.minExplore) {
    violations.push(`explore count ${exploreCount} < min ${exp.minExplore}`)
  }
  for (const t of exp?.requireTools ?? []) {
    if ((toolHist[t] ?? 0) <= 0) violations.push(`missing required tool: ${t}`)
  }
  for (const t of exp?.forbidTools ?? []) {
    if ((toolHist[t] ?? 0) > 0) violations.push(`forbidden tool used: ${t}`)
  }
  if (exp?.maxInputTokens !== undefined && (usage.inputTokens ?? 0) > exp.maxInputTokens) {
    violations.push(`input tokens ${usage.inputTokens} > max ${exp.maxInputTokens}`)
  }
  if (exp?.forbidParallelExploreTurn1 && firstAssistantExploreCount > 1) {
    violations.push(
      `first assistant turn had ${firstAssistantExploreCount} parallel explore calls (turn had ${firstAssistantToolCount} tools total)`,
    )
  }

  const report = {
    file: path,
    scenarioId: scenario?.id ?? null,
    title: thread?.title,
    userMessage: userText.slice(0, 500),
    shouldSteerGithubLinks: steerGithubLinks,
    shouldSteerTodos: steerTodos,
    usage,
    toolHistogram: toolHist,
    exploreCount,
    updateTodosCount: updateTodos,
    assistantTurns: assistants.length,
    finalAnswerChars: finalText.length,
    subagentReadCount: reads.length,
    duplicateReadPaths: dupPaths
      .slice(0, 15)
      .map(([p, ex]) => ({ path: p, count: ex.length, explores: [...new Set(ex)] })),
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
  ? (JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario)
  : undefined
analyze(jsonlPath, scenario)
