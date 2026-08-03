import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import { runHeadlessAgent } from '../src/main/services/headless-agent-host.ts'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../src/main/project-sandbox/index.ts'
import {
  autonomyScenarioSchema,
  decodeAutonomyTrace,
  scoreAutonomyRegression,
  terminalReportFromAssistantText,
  type AutonomyTrace,
} from './lib/autonomy-regression.mts'
import {
  DEFAULT_LM_STUDIO_URL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '../src/shared/lm-studio-defaults.ts'
import type { LLMMessage } from '../src/shared/types/index.ts'

const runnableScenarioSchema = autonomyScenarioSchema.extend({
  workspace: z.object({
    type: z.literal('tempProject'),
    prefix: z.string().min(1).optional(),
    seedFiles: z.array(
      z.object({
        path: z.string().min(1),
        content: z.string().optional(),
        fixture: z.string().min(1).optional(),
      }),
    ),
  }),
  autonomy: z.object({
    tracePath: z.string().min(1),
    requireShellApproval: z.boolean().optional(),
  }),
})

function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return value
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0)
}

function selectedPrompt(variants: readonly string[]): { prompt: string; index: number } {
  const rawIndex = process.env['COPSE_EVAL_PROMPT_VARIANT'] ?? '0'
  const index = Number.parseInt(rawIndex, 10)
  const prompt = variants[index]
  if (!Number.isInteger(index) || index < 0 || prompt === undefined) {
    throw new Error(
      `COPSE_EVAL_PROMPT_VARIANT must select 0..${String(variants.length - 1)}; received ${rawIndex}`,
    )
  }
  return { prompt, index }
}

function safeWorkspacePath(workspaceRoot: string, path: string): string {
  const target = resolve(workspaceRoot, path)
  const relativeTarget = relative(workspaceRoot, target)
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Path escapes the eval workspace: ${path}`)
  }
  return target
}

async function seedWorkspace(
  workspaceRoot: string,
  seedFiles: z.infer<typeof runnableScenarioSchema>['workspace']['seedFiles'],
): Promise<void> {
  for (const seedFile of seedFiles) {
    const target = safeWorkspacePath(workspaceRoot, seedFile.path)
    await mkdir(dirname(target), { recursive: true })
    if (seedFile.content !== undefined) {
      writeFileSync(target, seedFile.content, 'utf8')
    } else if (seedFile.fixture) {
      await copyFile(resolve(process.cwd(), seedFile.fixture), target)
    } else {
      throw new Error(`Seed file ${seedFile.path} must define content or fixture`)
    }
  }
}

function finalAssistantText(messages: readonly LLMMessage[]): string {
  const message = messages.findLast((candidate) => candidate.role === 'assistant')
  return message && typeof message.content === 'string' ? message.content.trim() : ''
}

async function main(): Promise<void> {
  const scenarioPath = resolve(
    process.env['COPSE_EVAL_SCENARIO'] ?? 'tests/e2e/scenarios/autonomy-regression.json',
  )
  const scenario = runnableScenarioSchema.parse(readJson(scenarioPath))
  const selected = selectedPrompt(scenario.promptVariants)
  const workspaceRoot = mkdtempSync(join(tmpdir(), scenario.workspace.prefix ?? `${scenario.id}-`))
  const artifactDir = resolve(process.env['COPSE_EVAL_ARTIFACT_DIR'] ?? 'tests/e2e/artifacts')
  const keepWorkspace = process.env['COPSE_EVAL_KEEP_WORKSPACE'] === '1'
  const modelId = firstNonEmpty(process.env['COPSE_EVAL_MODEL']?.trim()) ?? LM_STUDIO_MODEL_IDS.chat
  const serverUrl =
    firstNonEmpty(
      process.env['COPSE_EVAL_LOCAL_SERVER_URL']?.trim(),
      process.env['COPSE_EVAL_LM_STUDIO_URL']?.trim(),
    ) ?? DEFAULT_LM_STUDIO_URL
  const apiKey =
    firstNonEmpty(process.env['LM_STUDIO_API_KEY']?.trim(), process.env['LM_API_TOKEN']?.trim()) ??
    'lm-studio'
  const timeoutMs = Number(process.env['COPSE_EVAL_IDLE_MS'] ?? 15 * 60_000)
  let approvalCount = 0

  try {
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      throw new Error('Autonomy eval requires an active ASRT project sandbox')
    }
    await seedWorkspace(workspaceRoot, scenario.workspace.seedFiles)
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    process.stdout.write(
      `autonomy eval model=${modelId} variant=${String(selected.index)} workspace=${workspaceRoot}\n`,
    )

    const result = await runHeadlessAgent(
      {
        workspaceRoot,
        model: lmStudioChatModelValue(modelId),
        settings: {
          autoRunSandboxCommands: scenario.autonomy.requireShellApproval !== true,
          browserToolsEnabled: false,
          bundledCursorSkillsEnabled: false,
          cursorHooksEnabled: false,
          skillsEnabled: false,
          subagentsEnabled: false,
        },
        enabledPackIds: [],
        toolAvailability: { rg: false, git: false, gh: false },
        loadMcpServers: false,
        workspaceTrusted: true,
        interaction: {
          approve: () => {
            approvalCount++
            return Promise.resolve({ approved: true, remember: false })
          },
          stagedDiff: () => Promise.resolve(true),
        },
        limits: { maxSteps: 12, maxLlmCalls: 12 },
      },
      {
        prompt: selected.prompt,
        threadId: `${scenario.id}-variant-${String(selected.index)}`,
        projectId: `${scenario.id}-project`,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (chunk.type === 'text') process.stdout.write(chunk.text)
        },
      },
      {
        provider: createLMStudioProvider(serverUrl, modelId, apiKey),
        contextWindow: 64_000,
      },
    ).finally(() => {
      clearTimeout(timeout)
    })

    const tracePath = safeWorkspacePath(workspaceRoot, scenario.autonomy.tracePath)
    const trace = decodeAutonomyTrace(readJson(tracePath))
    const harnessEvents: AutonomyTrace['events'] = Array.from({ length: approvalCount }, () => ({
      type: 'approval_requested',
      capability: 'synthetic-matrix-execution',
    }))
    const traceWithoutReport: AutonomyTrace = {
      scenarioId: trace.scenarioId,
      events: [...harnessEvents, ...trace.events.filter((event) => event.type !== 'report')],
    }
    const completedTrace: AutonomyTrace = {
      ...traceWithoutReport,
      events: [
        ...traceWithoutReport.events,
        terminalReportFromAssistantText(
          scenario,
          traceWithoutReport,
          finalAssistantText(result.messages),
        ),
      ],
    }
    const report = scoreAutonomyRegression(scenario, completedTrace)
    const timestamp = Date.now()
    mkdirSync(artifactDir, { recursive: true })
    const traceOut = join(
      artifactDir,
      `${scenario.id}-variant-${String(selected.index)}-${String(timestamp)}-trace.json`,
    )
    const reportOut = join(
      artifactDir,
      `${scenario.id}-variant-${String(selected.index)}-${String(timestamp)}-report.json`,
    )
    const conversationOut = join(
      artifactDir,
      `${scenario.id}-variant-${String(selected.index)}-${String(timestamp)}-messages.json`,
    )
    writeFileSync(traceOut, `${JSON.stringify(completedTrace, null, 2)}\n`, 'utf8')
    writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    writeFileSync(conversationOut, `${JSON.stringify(result.messages, null, 2)}\n`, 'utf8')
    process.stdout.write(`\nCOPSE_AUTONOMY_TRACE=${traceOut}\n`)
    process.stdout.write(`COPSE_AUTONOMY_REPORT=${reportOut}\n`)
    process.stdout.write(`COPSE_AUTONOMY_MESSAGES=${conversationOut}\n`)
    process.stdout.write(`COPSE_AUTONOMY_PASS=${String(report.pass)}\n`)
    if (!report.pass) process.exitCode = 1
  } finally {
    await shutdownProjectSandbox()
    if (keepWorkspace) {
      process.stdout.write(`COPSE_AUTONOMY_WORKSPACE=${workspaceRoot}\n`)
    } else {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
