import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { parseAcpAuthStatusArgs } from './ipc-guards.ts'
import { probeAcpAgentForSettings } from '../services/acp/acp-agent-service.ts'
import { detectAcpAuthStatus } from '../services/acp/acp-auth-status.ts'
import { runAcpAutoSetup } from '../services/acp/acp-auto-setup.ts'
import { detectAcpAgents } from '../services/acp/acp-detect.ts'
import { browseAcpRegistry } from '../services/acp/acp-registry-discovery.ts'

export function registerAcpHandlers(win: BrowserWindow): void {
  defineHandler(win, 'acp:detect-agents', z.tuple([]), () => detectAcpAgents())
  defineHandler(win, 'acp:browse-registry', z.tuple([z.boolean().optional()]), (force) =>
    browseAcpRegistry(force),
  )
  // The agent id keeps its hand-written check and error message.
  defineHandler(win, 'acp:probe-agent', z.tuple([z.unknown()]), (agentId) => {
    if (typeof agentId !== 'string') throw new Error('acp:probe-agent requires an agent id')
    return probeAcpAgentForSettings(agentId)
  })
  // The ids keep their shared decoder, which `ipc-guards.test.ts` covers.
  defineHandler(win, 'acp:auth-status', z.tuple([z.unknown()]), (ids) =>
    detectAcpAuthStatus(parseAcpAuthStatusArgs([ids])),
  )
  defineHandler(win, 'acp:auto-setup', z.tuple([]), () =>
    runAcpAutoSetup(new AbortController().signal),
  )
}
