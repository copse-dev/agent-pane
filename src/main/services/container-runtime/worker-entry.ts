/**
 * The guest side of a container run (`docs/plans/thread-in-container.md`).
 *
 * Bundled as a standalone main bundle (`scripts/main-bundles.mts`) and started
 * by the image's entrypoint as an unprivileged user inside a hardened container. It reads the
 * spec and the host's attestation from the read-only run directory, carries the
 * workspace in from the bundle, arms an unattended run on the thread, and drives
 * the product's own headless agent host. It never opens a prompt: the approval
 * handler installed here refuses and counts, and it should count zero — every
 * would-be prompt is either allowed by the contained-effect policy or queued by
 * deferral mode before it could reach a handler.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createLocalOpenAIProvider } from '@copse/llm/create-provider.ts'
import { runHeadlessAgent } from '../headless-agent-host.ts'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../../project-sandbox/index.ts'
import {
  declareContainerRuntime,
  parseContainerRuntimeAttestation,
} from '../security/runtime-containment.ts'
import { armUnattendedRun, disarmUnattendedRun } from '../security/unattended-run.ts'
import { readPendingDeferrals } from '../security/deferred-approval-store.ts'
import { readDecisionLog } from '../security/decision-log-store.ts'
import { disposeAllAcpSessions } from '../acp/acp-session-pool.ts'
import { acpAgentConfigSchema } from '../storage/settings-writable.ts'
import { storageSet } from '../storage/storage.ts'
import { guestAcpAgentConfig } from './guest-acp-agent.ts'
import type { ThreadContainerAcpHarness } from './thread-container.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { GUEST_EGRESS_PROXY } from './egress-rules.ts'
import { startGuestEgressProxy } from './guest-egress-proxy.ts'
import type { LLMMessage } from '@shared/types/index.ts'

const RUN_DIR = '/run/copse'

const specSchema = z.object({
  runtimeId: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  providerUrl: z.url().nullable(),
  productProvider: z.object({ apiKeySlug: z.string().min(1) }).nullable(),
  apiKeyEnv: z.string().min(1).nullable(),
  acp: z.object({ agent: acpAgentConfigSchema, keyEnvName: z.string() }).nullable(),
  budgets: z.object({
    wallClockMs: z.number().positive(),
    tokenCeiling: z.number().positive(),
  }),
  workspace: z.string().min(1),
  carryInRef: z.string().min(1),
  carryInBase: z.string().min(1),
  maxSteps: z.number().int().positive().nullable(),
})

type Spec = z.infer<typeof specSchema>

/**
 * The parsed harness as the shared type: zod leaves every optional field
 * `| undefined`, and the config type (under exact optional properties) does
 * not admit that, so the absent ones are dropped rather than carried as
 * explicit undefineds.
 */
function harnessFromSpec(acp: NonNullable<Spec['acp']>): ThreadContainerAcpHarness {
  const { agent } = acp
  return {
    keyEnvName: acp.keyEnvName,
    agent: {
      id: agent.id,
      title: agent.title,
      command: agent.command,
      enabled: agent.enabled,
      ...(agent.args !== undefined ? { args: agent.args } : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.permissionMode !== undefined ? { permissionMode: agent.permissionMode } : {}),
      ...(agent.configOptions !== undefined ? { configOptions: agent.configOptions } : {}),
    },
  }
}

type StopReason = 'completed' | 'budget:wall-clock' | 'budget:tokens' | 'aborted' | 'error'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function readSpec(): Spec {
  const spec = safeJsonParse(
    readFileSync(join(RUN_DIR, 'run.json'), 'utf8'),
    decodeWithSchema(specSchema),
  )
  if (spec === null) throw new Error('run.json is not a valid run spec')
  return spec
}

function carryIn(spec: Spec): void {
  const bundle = join(RUN_DIR, 'carry-in.bundle')
  mkdirSync(spec.workspace, { recursive: true })
  // Start on an unborn placeholder branch: git refuses to fetch into the
  // branch that is checked out, even an unborn one.
  git(spec.workspace, ['init', '--quiet', '--initial-branch=carry-in'])
  git(spec.workspace, ['config', 'user.name', 'copse-worker'])
  git(spec.workspace, ['config', 'user.email', 'copse-worker@copse.invalid'])
  git(spec.workspace, [
    'fetch',
    '--quiet',
    '--no-tags',
    bundle,
    `${spec.carryInRef}:refs/heads/work`,
  ])
  git(spec.workspace, ['checkout', '--quiet', 'work'])
  const head = git(spec.workspace, ['rev-parse', 'HEAD'])
  if (head !== spec.carryInBase)
    throw new Error(`carry-in mismatch: ${head} != ${spec.carryInBase}`)
}

/** Commit whatever the agent left uncommitted, then bundle everything since carry-in. */
function carryOut(spec: Spec): string[] {
  const status = git(spec.workspace, ['status', '--porcelain'])
  if (status.length > 0) {
    git(spec.workspace, ['add', '-A'])
    git(spec.workspace, ['commit', '--quiet', '-m', 'copse: end-of-run snapshot'])
  }
  const commits = git(spec.workspace, ['log', '--format=%H %s', `${spec.carryInBase}..HEAD`])
    .split('\n')
    .filter((line) => line.length > 0)
  if (commits.length > 0) {
    git(spec.workspace, [
      'bundle',
      'create',
      join(RUN_DIR, 'out', 'carry-out.bundle'),
      `${spec.carryInBase}..work`,
    ])
  }
  return commits
}

function finalAssistantText(messages: readonly LLMMessage[]): string {
  const message = messages.findLast((candidate) => candidate.role === 'assistant')
  return message && typeof message.content === 'string' ? message.content.trim() : ''
}

async function main(): Promise<void> {
  // First, before any client exists: the loopback proxy every outbound byte
  // goes through. Node's env-proxy dispatcher was pointed at this address when
  // the process started and only connects on the first request.
  const brokerSocket = process.env['COPSE_EGRESS_SOCKET']
  const egressProxy = brokerSocket
    ? await startGuestEgressProxy(brokerSocket, GUEST_EGRESS_PROXY)
    : null
  process.stdout.write(
    `[worker] egress proxy ${egressProxy ? `on ${egressProxy.address.host}:${String(egressProxy.address.port)}` : 'off (no broker socket)'}\n`,
  )
  const spec = readSpec()
  const attestationText = readFileSync(join(RUN_DIR, 'attestation.json'), 'utf8')
  const attestation = parseContainerRuntimeAttestation(attestationText)
  if (attestation === null) throw new Error('attestation.json is not a valid attestation')
  const apiKey = spec.apiKeyEnv ? (process.env[spec.apiKeyEnv] ?? '') : ''
  if (spec.apiKeyEnv) {
    // The key is consumed here and never reaches a child process or the record
    // through the environment. Under an ACP harness it reaches exactly one
    // child — the agent — as the one entry of its explicit env map.
    process.env[spec.apiKeyEnv] = ''
  }
  if (spec.acp) {
    process.stdout.write(
      `[worker] harness: ACP agent ${spec.acp.agent.id} (${spec.acp.agent.command})\n`,
    )
  }

  process.stdout.write(`[worker] run ${spec.runtimeId} thread ${spec.threadId}\n`)
  carryIn(spec)
  process.stdout.write(`[worker] carried in ${spec.carryInBase.slice(0, 12)}\n`)

  // The decision log and the deferred queue key off the active project; point
  // them at this run's project so both land in the mounted state directory.
  storageSet('activeProjectId', spec.projectId)
  storageSet('projects', [{ id: spec.projectId, path: spec.workspace }])

  let declineReason: string | null = null
  try {
    declareContainerRuntime(attestation)
  } catch (error) {
    declineReason = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[worker] container containment NOT declared: ${declineReason}\n`)
  }

  await initProjectSandbox()
  const projectSandbox = isProjectSandboxEnabled()
  process.stdout.write(`[worker] project sandbox (bubblewrap): ${String(projectSandbox)}\n`)

  armUnattendedRun(spec.threadId, {
    runtimeId: spec.runtimeId,
    budgets: spec.budgets,
  })

  let promptsAttempted = 0
  // A holder rather than a bare `let`: the timer and signal handlers below
  // assign it, which control-flow narrowing cannot see.
  const stop: { reason: StopReason } = { reason: 'completed' }
  let errorText: string | undefined
  let inputTokens = 0
  let outputTokens = 0
  const controller = new AbortController()
  // Leave the host a margin to collect the result before it stops the container.
  const selfDeadline = Math.max(1_000, spec.budgets.wallClockMs - 20_000)
  const timer = setTimeout(() => {
    stop.reason = 'budget:wall-clock'
    controller.abort()
  }, selfDeadline)
  const onSignal = (): void => {
    if (stop.reason === 'completed') stop.reason = 'aborted'
    controller.abort()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  let messages: readonly LLMMessage[] = []
  let toolNames: readonly string[] = []
  try {
    const result = await runHeadlessAgent(
      {
        workspaceRoot: spec.workspace,
        model: spec.model,
        settings: {
          autoRunSandboxCommands: true,
          browserToolsEnabled: false,
          bundledCursorSkillsEnabled: false,
          cursorHooksEnabled: false,
          skillsEnabled: false,
          subagentsEnabled: false,
          safetyClassifierEnabled: false,
          safeInstallEnabled: false,
          // The one agent this run may drive, registered in the run's own
          // settings overlay so `getAcpAgent` finds it and nothing else.
          ...(spec.acp
            ? { registeredAcpAgents: [guestAcpAgentConfig(harnessFromSpec(spec.acp), apiKey)] }
            : {}),
        },
        // Product-resolved providers (Anthropic) find their key here; nothing
        // else from the host's settings or environment is in the guest.
        ...(spec.productProvider !== null
          ? { apiKeys: { [spec.productProvider.apiKeySlug]: apiKey } }
          : {}),
        enabledPluginIds: [],
        toolAvailability: { rg: true, git: true, gh: false },
        loadMcpServers: false,
        workspaceTrusted: true,
        interaction: {
          approve: (request) => {
            promptsAttempted += 1
            process.stdout.write(`[worker] PROMPT REACHED HANDLER (refused): ${request.title}\n`)
            return Promise.resolve({ approved: false, remember: false })
          },
          stagedDiff: () => Promise.resolve(true),
        },
        ...(spec.maxSteps !== null
          ? {
              limits: {
                maxSteps: spec.maxSteps,
                maxLlmCalls: spec.maxSteps,
                adaptiveExtensions: false,
              },
            }
          : {}),
      },
      {
        prompt: spec.prompt,
        threadId: spec.threadId,
        projectId: spec.projectId,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (chunk.type === 'text') process.stdout.write(chunk.text)
          if (chunk.type === 'usage') {
            inputTokens += chunk.inputTokens
            outputTokens += chunk.outputTokens
            if (
              inputTokens + outputTokens > spec.budgets.tokenCeiling &&
              !controller.signal.aborted
            ) {
              stop.reason = 'budget:tokens'
              controller.abort()
            }
          }
        },
      },
      spec.providerUrl !== null
        ? {
            provider: createLocalOpenAIProvider(spec.providerUrl, spec.model, apiKey || 'copse'),
            contextWindow: 128_000,
          }
        : {},
    )
    messages = result.messages
    toolNames = result.toolNames
  } catch (error) {
    if (stop.reason === 'completed') {
      stop.reason = 'error'
      errorText = error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    disarmUnattendedRun(spec.threadId)
    // The desktop keeps an agent's session alive between turns; the guest has
    // no next turn, and a live child would keep this process from exiting.
    await disposeAllAcpSessions()
    await shutdownProjectSandbox()
    await egressProxy?.close()
  }

  const deferrals = (
    await readPendingDeferrals({ projectId: spec.projectId, threadId: spec.threadId })
  ).map((entry) => ({
    id: entry.id,
    title: entry.title,
    subject: entry.subject,
    ...(entry.reasons ? { reasons: entry.reasons } : {}),
  }))
  // What the contained policy refused, from the run's own decision log: host
  // escapes, and under an ACP harness the outward effects that could not be
  // queued for replay. The log is the source so a refusal cannot go unreported.
  const denials = (await readDecisionLog(spec.projectId).catch(() => []))
    .filter(
      (event) =>
        event.verdict === 'blocked' &&
        event.scope === 'container' &&
        (event.threadId === undefined || event.threadId === spec.threadId),
    )
    .map((event) => ({ subject: event.subject, reasons: event.reasons ?? [] }))
  const commits = carryOut(spec)
  const outDir = join(RUN_DIR, 'out')
  writeFileSync(join(outDir, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`)
  writeFileSync(
    join(outDir, 'result.json'),
    `${JSON.stringify(
      {
        threadId: spec.threadId,
        stopReason: stop.reason,
        ...(errorText !== undefined ? { error: errorText } : {}),
        usage: { inputTokens, outputTokens },
        harness: spec.acp ? { acp: spec.acp.agent.id } : 'copse',
        promptsAttempted,
        deferrals,
        denials,
        commits,
        containment: { declared: declineReason === null, declineReason, projectSandbox },
        toolNames,
        finalText: finalAssistantText(messages),
        envKeys: Object.keys(process.env).sort(),
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `\n[worker] done: ${stop.reason}; prompts=${String(promptsAttempted)} deferrals=${String(deferrals.length)} denials=${String(denials.length)} commits=${String(commits.length)}\n`,
  )
  if (!existsSync(join(outDir, 'result.json'))) throw new Error('result.json was not written')
}

void main().catch((error: unknown) => {
  console.error('[worker] fatal:', error)
  process.exitCode = 1
})
