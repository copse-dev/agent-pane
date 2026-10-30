import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseAcpAuthStatusArgs, parseIpcArgs } from './ipc-guards.ts'
import { probeAcpAgentForSettings } from '../services/acp/acp-agent-service.ts'
import { detectAcpAuthStatus } from '../services/acp/acp-auth-status.ts'
import { runAcpAutoSetup } from '../services/acp/acp-auto-setup.ts'
import { detectAcpAgents } from '../services/acp/acp-detect.ts'
import { browseAcpRegistry } from '../services/acp/acp-registry-discovery.ts'

export function registerAcpHandlers(win: BrowserWindow): void {
  ipcMain.handle('acp:detect-agents', (event) => {
    assertMainFrameSender(event, win)
    return detectAcpAgents()
  })
  ipcMain.handle('acp:browse-registry', (event, refresh: unknown) => {
    assertMainFrameSender(event, win)
    const force = parseIpcArgs(z.boolean().optional(), [refresh])
    return browseAcpRegistry(force)
  })
  ipcMain.handle('acp:probe-agent', (event, agentId: unknown) => {
    assertMainFrameSender(event, win)
    if (typeof agentId !== 'string') throw new Error('acp:probe-agent requires an agent id')
    return probeAcpAgentForSettings(agentId)
  })
  ipcMain.handle('acp:auth-status', (event, ids: unknown) => {
    assertMainFrameSender(event, win)
    const agentIds = parseAcpAuthStatusArgs([ids])
    return detectAcpAuthStatus(agentIds)
  })
  ipcMain.handle('acp:auto-setup', (event) => {
    assertMainFrameSender(event, win)
    return runAcpAutoSetup(new AbortController().signal)
  })
}
