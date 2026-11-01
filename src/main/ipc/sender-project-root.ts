import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { z } from 'zod'
import type { InvokeChannel } from './define-handler.ts'
import {
  parsePositionalIpcArgs,
  senderCheck,
  type IpcHandlerOptions,
  type PositionalArgsOptions,
} from './ipc-handler.ts'
import type { AgentRoots } from '../services/execution-root.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { getMainWindowNavigation } from '../windows/create-main-window.ts'

/**
 * The persisted root of the project open in the asking window, or null when it
 * shows none. Read from the sender's own window record, as
 * `docs/plans/multi-window-architecture.md` describes, never from the
 * process-global workspace, which is whichever window switched project last
 * (#3958). A sender that is not a full main window (a pop-out) follows the
 * primary window, as it did before.
 */
export function senderProjectRoot(sender: WebContents): string | null {
  const projectId = getMainWindowNavigation(sender).activeProjectId
  return projectId === null ? null : getProjectRoot(projectId)
}

/**
 * `defineHandler` for a handler that acts on the asking window's project: the
 * sender is checked, then `fn` receives {@link senderProjectRoot} ahead of the
 * parsed positional arguments.
 */
export function defineSenderRootHandler<T extends readonly z.ZodType[]>(
  win: BrowserWindow,
  channel: InvokeChannel,
  args: z.ZodTuple<T, null>,
  fn: (root: string | null, ...parsed: z.output<z.ZodTuple<T, null>>) => unknown,
  options?: IpcHandlerOptions & PositionalArgsOptions,
): void {
  const checkSender = senderCheck(win, options)
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => {
    checkSender(event)
    return fn(senderProjectRoot(event.sender), ...parsePositionalIpcArgs(args, rawArgs, options))
  })
}

/**
 * Instruction roots for the asking window: outside a turn there is no worktree
 * checkout, so the project root is both the trust anchor and the tree read.
 */
export function senderInstructionRoots(sender: WebContents): AgentRoots {
  const root = senderProjectRoot(sender)
  return { projectRoot: root, executionRoot: root }
}
