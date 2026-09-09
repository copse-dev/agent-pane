import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerRuntimeAttestation } from '@shared/types/unattended-run.ts'
import { runHeadlessAgent } from '../headless-agent-host.ts'
import { disposeAllAcpSessions } from '../acp/acp-session-pool.ts'
import { readDecisionLog } from '../security/decision-log-store.ts'
import { readPendingDeferrals } from '../security/deferred-approval-store.ts'
import { clearDeferralModesForTests } from '../security/deferral-mode.ts'
import {
  clearRuntimeContainmentForTests,
  declareContainerRuntime,
} from '../security/runtime-containment.ts'
import {
  armUnattendedRun,
  clearUnattendedRunsForTests,
  disarmUnattendedRun,
} from '../security/unattended-run.ts'
import { storageSet } from '../storage/storage.ts'
import { guestAcpAgentConfig } from './guest-acp-agent.ts'
import { SCRIPTED_ACP_AGENT_SOURCE } from './scripted-acp-agent.ts'

/**
 * The guest's ACP path without the container: the same `runHeadlessAgent`
 * call the worker makes, under a declared container runtime and an armed
 * unattended run, driving the scripted agent the Docker integration test
 * carries in. What this proves that the unit tests cannot is the seam
 * between them — the agent registered through the settings overlay, the real
 * ACP client speaking to a real agent process, its `session/request_permission`
 * answered by the contained policy, and the refusals landing in the decision
 * log the worker reads its `denials` from. Everything the container adds on
 * top (the image, the mounts, the broker) is the integration test's.
 */

const PROJECT = 'acp-harness-project'
const THREAD = 'acp-harness-thread'
const KEY = 'scripted-key-9876543210'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function attestation(): ContainerRuntimeAttestation {
  return {
    runtimeId: 'rt-acp-harness',
    image: 'copse-worker:test',
    user: 1001,
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    pidsLimit: 512,
    memoryLimit: '4g',
    network: 'none',
    egressAllowlist: [],
    hostMounts: ['/run/copse'],
  }
}

describe('a thread under an ACP agent, contained', () => {
  it(
    'answers the agent by blast radius, records the refusals, and keeps the work',
    { timeout: 60_000 },
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'copse-acp-harness-'))
      const store = mkdtempSync(join(tmpdir(), 'copse-acp-harness-store-'))
      const previousStore = process.env['COPSE_WORKSPACE_DIR']
      process.env['COPSE_WORKSPACE_DIR'] = store
      git(workspace, ['init', '--quiet', '--initial-branch=main'])
      git(workspace, ['config', 'user.name', 'test'])
      git(workspace, ['config', 'user.email', 'test@copse.invalid'])
      writeFileSync(join(workspace, 'README.md'), '# demo\n')
      const agentPath = join(workspace, 'scripted-acp-agent.cjs')
      writeFileSync(agentPath, SCRIPTED_ACP_AGENT_SOURCE)
      git(workspace, ['add', '-A'])
      git(workspace, ['commit', '--quiet', '-m', 'init'])

      storageSet('activeProjectId', PROJECT)
      storageSet('projects', [{ id: PROJECT, path: workspace }])
      declareContainerRuntime(attestation())
      armUnattendedRun(THREAD, {
        runtimeId: 'rt-acp-harness',
        budgets: { wallClockMs: 60_000, tokenCeiling: 1_000_000 },
      })
      let promptsAttempted = 0
      try {
        const agent = guestAcpAgentConfig(
          {
            agent: {
              id: 'scripted',
              title: 'Scripted agent',
              command: process.execPath,
              args: [agentPath],
              sandbox: false,
              enabled: true,
            },
            keyEnvName: 'SCRIPTED_AGENT_KEY',
          },
          KEY,
        )
        const result = await runHeadlessAgent(
          {
            workspaceRoot: workspace,
            model: 'acp:scripted',
            settings: {
              autoRunSandboxCommands: true,
              browserToolsEnabled: false,
              bundledCursorSkillsEnabled: false,
              cursorHooksEnabled: false,
              skillsEnabled: false,
              subagentsEnabled: false,
              safetyClassifierEnabled: false,
              safeInstallEnabled: false,
              registeredAcpAgents: [agent],
            },
            enabledPluginIds: [],
            toolAvailability: { rg: true, git: true, gh: false },
            loadMcpServers: false,
            workspaceTrusted: true,
            interaction: {
              approve: (request) => {
                promptsAttempted += 1
                console.error(`PROMPT REACHED HANDLER: ${request.title}`)
                return Promise.resolve({ approved: false, remember: false })
              },
              stagedDiff: () => Promise.resolve(true),
            },
          },
          {
            prompt: 'Build the project, push it, and tidy the README.',
            threadId: THREAD,
            projectId: PROJECT,
          },
        )

        // The agent's own account of the run, written from inside its process.
        const agentEnv = readFileSync(join(workspace, 'agent-env.txt'), 'utf8')
        assert.match(agentEnv, new RegExp(`^key=${KEY}$`, 'm'))
        assert.match(agentEnv, /^build=allowed$/m)
        assert.match(agentEnv, /^push=refused$/m)
        assert.match(agentEnv, /^escape=refused$/m)
        // The allowed work happened and was committed by the agent itself.
        assert.ok(existsSync(join(workspace, 'build', 'out.txt')))
        assert.match(git(workspace, ['log', '--format=%s', '-1']), /agent: edit readme/)
        assert.match(readFileSync(join(workspace, 'README.md'), 'utf8'), /edited by the agent/)
        // Nothing reached a handler, and nothing was queued for a replay.
        assert.equal(promptsAttempted, 0)
        assert.equal((await readPendingDeferrals({ threadId: THREAD })).length, 0)
        // The two refusals are in the log the worker reads `denials` from.
        const denials = (await readDecisionLog(PROJECT)).filter(
          (event) => event.verdict === 'blocked' && event.scope === 'container',
        )
        assert.equal(denials.length, 2, JSON.stringify(denials))
        assert.ok(denials.some((event) => /push|remote/.test((event.reasons ?? []).join(' '))))
        assert.ok(denials.some((event) => /docker|host/.test((event.reasons ?? []).join(' '))))
        // The agent's final text made it into the transcript.
        assert.ok(
          result.messages.some(
            (message) =>
              message.role === 'assistant' &&
              typeof message.content === 'string' &&
              /push was refused/.test(message.content),
          ),
        )
      } finally {
        disarmUnattendedRun(THREAD)
        await disposeAllAcpSessions()
        clearUnattendedRunsForTests()
        clearRuntimeContainmentForTests()
        clearDeferralModesForTests()
        if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
        else process.env['COPSE_WORKSPACE_DIR'] = previousStore
        rmSync(workspace, { recursive: true, force: true })
        rmSync(store, { recursive: true, force: true })
      }
    },
  )
})
