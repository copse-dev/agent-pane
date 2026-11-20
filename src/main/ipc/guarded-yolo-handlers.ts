import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { listReadOutsideProjectGrants } from '../services/security/read-outside-grant.ts'
import { browserSessionOrigins } from '../services/browser/browser-network-grants.ts'
import { browserThreadScope } from '@shared/browser-session.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { LOOPBACK_BIND_PERMISSION } from '@copse/agent/plugins/background-tasks-plugin.ts'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zNonEmptyString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { zGuardedYoloThreadId } from './security-handler-args.ts'
import {
  projectAllowsPortBinding,
  revokeProjectPortBinding,
} from '../services/security/project-port-grants.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { getThreadMeta } from '../services/thread-store.ts'
import { requestApproval } from '../services/approval.ts'
import {
  armGuardedYolo,
  disableGuardedYolo,
  getGuardedYoloState,
} from '../services/security/guarded-yolo.ts'

export function registerGuardedYoloHandlers(win: BrowserWindow): void {
  ipcMain.handle('security:get-guarded-yolo', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getGuardedYoloState(id)
  })
  ipcMain.handle(
    'security:get-context-permissions',
    (event, projectId: unknown, threadId: unknown, projectRoot: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, root] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zNonEmptyString.max(4096)]),
        [projectId, threadId, projectRoot],
      )
      return {
        outsideReadPaths: listReadOutsideProjectGrants(tid),
        browserOrigins: browserSessionOrigins(browserThreadScope(pid, tid)),
        portBindingAllowed:
          getDefaultPluginRegistry().isPermissionDeclared(LOOPBACK_BIND_PERMISSION) &&
          projectAllowsPortBinding(root),
      }
    },
  )
  ipcMain.handle(
    'security:revoke-project-port-binding',
    async (event, projectId: unknown, threadId: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
      const root = getProjectRoot(pid)
      const thread = await getThreadMeta(pid, tid)
      if (!root || thread?.id !== tid)
        throw new Error('The project or thread is no longer available.')
      await revokeProjectPortBinding(root)
    },
  )
  ipcMain.handle('security:enable-guarded-yolo', async (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    const current = getGuardedYoloState(id)
    if (current.phase !== 'off') return current
    const containment =
      current.containment === 'project-sandbox'
        ? 'The project sandbox remains in use where possible. Outside-project reads of non-credential paths auto-run inside a widened seatbelt; other external commands may run unsandboxed.'
        : 'No OS sandbox is active on this platform, so commands run with your full user permissions. Outside-project reads of non-credential paths still auto-run; credential paths and home-root listings stay refused.'
    const { approved } = await requestApproval({
      title: 'Enable Guarded YOLO for this thread?',
      cause: 'mode-arming',
      body: [
        'Routine shell commands will run without approval in this thread, including outside-project reads of non-credential paths.',
        '',
        containment,
        '',
        'GitHub CLI writes (for example `gh pr create`) still require confirmation. Credential files, `~`, and `/` remain refused.',
        '',
        'A deterministic host-owned checker will still ask about bounded destructive work and permanently block obvious catastrophic commands. It reduces obvious harm, but it is not a complete security boundary and cannot understand every script or obfuscation.',
        '',
        'Guarded YOLO stays enabled for this thread until you disable it or restart the app.',
      ].join('\n'),
      type: 'shell',
      allowRemember: false,
    })
    if (approved) armGuardedYolo(id)
    return getGuardedYoloState(id)
  })
  ipcMain.handle('security:disable-guarded-yolo', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    disableGuardedYolo(id)
    return getGuardedYoloState(id)
  })
}
