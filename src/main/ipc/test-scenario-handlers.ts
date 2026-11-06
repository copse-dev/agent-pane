import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { registerAllowedWorkspaceRoot } from '../services/workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zPathString,
} from './ipc-guards.ts'
import { setSemanticIndexScaleGuarded } from '../services/search/index-status.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import {
  requestAcpPackageInstallApproval,
  type AcpPackageChange,
} from '../services/acp/acp-auto-setup.ts'
import { requestSshPrompt } from '../services/ssh-workspace/ssh-prompt.ts'
import { approveRemoteWatcherInstall } from '../services/ssh-workspace/remote-watcher-install-approval.ts'
import { formatRemoteWatcherInstallApproval } from '../services/ssh-workspace/remote-native-watcher.ts'
import { requestCloseConfirmation } from '../services/close-confirm.ts'
import { setSeededVncNearbyServersForTests } from '../services/vnc/vnc-service.ts'
import { setSeededSimulatorDesktopForTests } from '../services/simulator-desktop/simulator-desktop-service.ts'
import { showSimulatorDesktop } from '../services/simulator-desktop/simulator-desktop-panel.ts'
import { setSeededPortRows } from '../services/ports/ports-registry.ts'
import {
  setMockScenario,
  clearMockScenarios,
  releaseMockScenario,
  assertMockScenarioComplete,
  mockScenarioStatus,
  parseMockScenario,
} from '@copse/llm/mock-script.ts'
import { createMainWindow, freezeMainWindowStateForQuit } from '../windows/create-main-window.ts'

export function registerTestScenarioHandlers(win: BrowserWindow): void {
  // Scripted model controls are compiled out of release builds, even if COPSE_E2E is set.
  if (__COPSE_TEST_SCENARIOS__ && process.env['COPSE_E2E'] === '1') {
    const testAgentChunkSchema = z.discriminatedUnion('type', [
      z.object({
        type: z.literal('tool_call'),
        toolCall: z.object({
          id: z.string().min(1).max(256),
          name: z.string().min(1).max(2_000),
          args: z.unknown(),
          kind: z.string().max(128).optional(),
        }),
      }),
      z.object({
        type: z.literal('tool_call_update'),
        toolCallId: z.string().min(1).max(256),
        name: z.string().max(2_000).optional(),
        args: z.unknown().optional(),
        status: z.enum(['running', 'done', 'error']).optional(),
        result: z.string().max(200_000).optional(),
        resultFormat: z.literal('markdown').optional(),
      }),
    ])
    const testApprovalRequestSchema = z.object({
      id: z.string().min(1).max(256),
      title: z.string().min(1).max(2_000),
      body: z.string().max(20_000),
      bodyAdvice: z.string().max(20_000).optional(),
      bodyFooter: z.string().max(20_000).optional(),
      type: z.string().min(1).max(128),
      collapseDetails: z.boolean().optional(),
      approveOnceLabel: z.string().max(500).optional(),
      approveLabel: z.string().max(500).optional(),
    })

    ipcMain.handle('test:setMockScenario', (event, id: unknown, raw: unknown, scope: unknown) => {
      assertMainFrameSender(event, win)
      const [scenarioId, threadId] = parseIpcArgs(
        z.tuple([z.string().min(1).max(200), z.string().min(1).max(200).optional()]),
        [id, scope],
      )
      setMockScenario(scenarioId, parseMockScenario(raw), threadId)
      return mockScenarioStatus(scenarioId)
    })
    ipcMain.handle('test:mockScenarioStatus', (event, id: unknown) => {
      assertMainFrameSender(event, win)
      const scenarioId = parseIpcArgs(z.string().min(1).max(200), [id])
      return mockScenarioStatus(scenarioId)
    })
    ipcMain.handle('test:releaseMockScenario', (event, id: unknown, hold: unknown) => {
      assertMainFrameSender(event, win)
      const [scenarioId, holdName] = parseIpcArgs(
        z.tuple([z.string().min(1).max(200), z.string().min(1).max(200)]),
        [id, hold],
      )
      releaseMockScenario(scenarioId, holdName)
    })
    ipcMain.handle('test:assertMockScenarioComplete', (event, id: unknown) => {
      assertMainFrameSender(event, win)
      const scenarioId = parseIpcArgs(z.string().min(1).max(200), [id])
      assertMockScenarioComplete(scenarioId)
    })
    ipcMain.handle('test:clearMockScenarios', (event) => {
      assertMainFrameSender(event, win)
      clearMockScenarios()
    })
    ipcMain.handle('test:emitAgentChunks', (event, rawThreadId: unknown, rawChunks: unknown) => {
      assertMainFrameSender(event, win)
      const [threadId, chunks] = parseIpcArgs(
        z.tuple([z.string().min(1).max(256), z.array(testAgentChunkSchema).max(16)]),
        [rawThreadId, rawChunks],
      )
      for (const chunk of chunks) win.webContents.send('agent:chunk', threadId, chunk)
    })
    ipcMain.handle('test:emitApprovalRequests', (event, raw: unknown) => {
      assertMainFrameSender(event, win)
      const requests = parseIpcArgs(z.array(testApprovalRequestSchema).min(1).max(16), [raw])
      for (const request of requests) win.webContents.send('agent:approval-request', request)
    })
    ipcMain.handle('test:cancelApprovalRequest', (event, rawId: unknown) => {
      assertMainFrameSender(event, win)
      const id = parseIpcArgs(z.string().min(1).max(256), [rawId])
      win.webContents.send('agent:approval-cancelled', { id })
    })
    ipcMain.handle('test:requestSshPrompt', (event, prompt: unknown, kind: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedPrompt, parsedKind] = parseIpcArgs(
        z.tuple([z.string().min(1).max(2_000), z.enum(['confirm', 'secret'])]),
        [prompt, kind],
      )
      return requestSshPrompt({ prompt: parsedPrompt, kind: parsedKind })
    })
    // Drives the real main→renderer close question without actually quitting —
    // an e2e that closed the app would take its own session down with it.
    ipcMain.handle('test:requestCloseConfirm', (event) => {
      assertMainFrameSender(event, win)
      return requestCloseConfirmation()
    })
    ipcMain.handle('test:createMainWindow', (event) => {
      assertMainFrameSender(event, win)
      createMainWindow()
    })
    // The wdio harness closes a window before reloadSession so Electron can
    // release its single-instance lock (wdio.conf.ts beforeCommand). Without
    // this, that close reads as the user discarding the window (its persisted
    // record is dropped) and the close-time state capture re-writes this
    // process's stale records over whatever the spec just seeded on disk —
    // which is how the multi-window restore spec broke. Quit + freeze keeps
    // the on-disk state exactly as the spec left it.
    ipcMain.handle('test:markQuit', (event) => {
      assertMainFrameSender(event, win)
      freezeMainWindowStateForQuit()
    })
    // Local macOS WebDriver sessions cannot always relaunch Electron after a
    // fixture rewrite. Let focused specs drive the same workspace-open event as
    // the native folder picker while keeping this seam entirely e2e-only.
    ipcMain.handle('test:openWorkspace', async (event, rawRoot: unknown) => {
      assertMainFrameSender(event, win)
      const parsedRoot = parseIpcArgs(zPathString, [rawRoot])
      const root = await registerAllowedWorkspaceRoot(parsedRoot)
      win.webContents.send('workspace:opened', root)
      return root
    })
    ipcMain.handle('test:requestAcpPackageInstallApproval', (event, rawScenario: unknown) => {
      assertMainFrameSender(event, win)
      const codex = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'codex-acp')
      if (!codex) throw new IpcValidationError('The Codex agent preset is missing')
      // Fixture at the detection boundary; no global package mutation runs here.
      const scenario = parseIpcArgs(z.enum(['install', 'upgrade', 'mixed']).default('install'), [
        rawScenario,
      ])
      const upgrade: AcpPackageChange = {
        agent: codex,
        action: 'upgrade',
        fromVersion: '1.1.0',
        toVersion: '1.1.7',
      }
      if (scenario === 'mixed') {
        const claude = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'claude-acp')
        if (!claude) throw new IpcValidationError('The Claude agent preset is missing')
        return requestAcpPackageInstallApproval([{ agent: claude, action: 'install' }, upgrade])
      }
      return requestAcpPackageInstallApproval(
        scenario === 'upgrade' ? [upgrade] : [{ agent: codex, action: 'install' }],
      )
    })
    ipcMain.handle('test:requestRemoteWatcherInstallApproval', (event) => {
      assertMainFrameSender(event, win)
      return approveRemoteWatcherInstall(formatRemoteWatcherInstallApproval('Build server'))
    })
    ipcMain.handle('test:setPortRows', (event, raw: unknown) => {
      assertMainFrameSender(event, win)
      // Scanning is a property of the host, and the CI image has neither `ss` nor
      // `lsof` — so the Ports spec seeds rows instead of starting real listeners.
      const rows = parseIpcArgs(
        z
          .array(
            z.object({
              port: z.number().int().min(1).max(65535),
              pid: z.number().int().positive().nullable(),
              command: z.string().max(200),
              address: z.string().max(64),
              owner: z
                .object({
                  kind: z.enum(['terminal', 'background']),
                  id: z.string().max(128),
                  label: z.string().max(200),
                })
                .nullable(),
              url: z.string().max(2048).nullable(),
            }),
          )
          .max(64),
        [raw],
      )
      setSeededPortRows({ rows, tool: 'seeded' })
    })
    ipcMain.handle('test:setVncNearbyServers', (event, raw: unknown) => {
      assertMainFrameSender(event, win)
      const servers = parseIpcArgs(
        z
          .array(
            z.object({
              name: z.string().min(1).max(256),
              host: z.string().min(1).max(253),
              port: z.number().int().min(1).max(65535),
              addresses: z.array(z.string().min(1).max(64)).max(16),
            }),
          )
          .max(64),
        [raw],
      )
      setSeededVncNearbyServersForTests(servers)
    })
    ipcMain.handle('test:setSimulatorDesktop', (event, raw: unknown) => {
      assertMainFrameSender(event, win)
      const value = parseIpcArgs(
        z.object({
          devices: z
            .array(
              z.object({
                udid: z.uuid(),
                name: z.string().min(1).max(256),
                runtime: z.string().min(1).max(128),
                platform: z.literal('android').optional(),
              }),
            )
            .max(8),
          frame: z
            .object({
              base64: z.string().max(2_000_000),
              mimeType: z.enum(['image/jpeg', 'image/png', 'image/svg+xml']),
              pixelWidth: z.number().int().positive().max(10_000),
              pixelHeight: z.number().int().positive().max(10_000),
            })
            .nullable(),
        }),
        [raw],
      )
      setSeededSimulatorDesktopForTests(
        value.devices,
        value.frame
          ? {
              bytes: Uint8Array.from(Buffer.from(value.frame.base64, 'base64')),
              mimeType: value.frame.mimeType,
              pixelWidth: value.frame.pixelWidth,
              pixelHeight: value.frame.pixelHeight,
            }
          : null,
      )
    })
    ipcMain.handle('test:showSimulatorDesktop', (event, raw: unknown) => {
      assertMainFrameSender(event, win)
      const udid = parseIpcArgs(z.uuid(), [raw])
      showSimulatorDesktop(udid)
    })
    ipcMain.handle('test:setSemanticIndexScaleGuard', (event, phase: unknown, reason: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedPhase, parsedReason] = parseIpcArgs(
        z.tuple([z.enum(['limited', 'skipped']), z.string().min(1).max(500)]),
        [phase, reason],
      )
      setSemanticIndexScaleGuarded(parsedPhase, parsedReason)
    })
  }
}
