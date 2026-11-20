import { BrowserWindow, ipcMain } from 'electron'
import { getWorkspaceRoot } from '../services/workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zPathString,
} from './ipc-guards.ts'
import { listUnsandboxedProjectHooks } from '../services/hooks/copse-adapter.ts'
import { discoverCursorRules, toCursorRuleSummaries } from '../services/skills/cursor-rules.ts'
import { loadProjectInstructionSources } from '../services/project-instructions.ts'
import { senderInstructionRoots } from './sender-project-root.ts'

export function registerInstructionHandlers(win: BrowserWindow): void {
  // Decision 7 / F3: the workspace-trust prompt surfaces project hooks that
  // declare `sandbox: false` at the consent moment. Read-only display parsing —
  // trust-independent by design (the whole point is showing this BEFORE trust).
  ipcMain.handle('hooks:unsandboxed-project-hooks', async () => {
    const root = getWorkspaceRoot()
    if (!root) return []
    return listUnsandboxedProjectHooks(root)
  })
  ipcMain.handle('instructions:list', async (event) =>
    (
      await loadProjectInstructionSources({
        useLatestNestedActivation: true,
        refreshNestedDiscovery: true,
        roots: senderInstructionRoots(event.sender),
      })
    ).map(
      ({
        path,
        name,
        scope,
        content,
        active,
        trusted,
        scopePath,
        duplicateOf,
        discoveryTruncated,
      }) => ({
        path,
        name,
        scope,
        bytes: Buffer.byteLength(content, 'utf-8'),
        active,
        trusted,
        ...(scopePath !== undefined ? { scopePath } : {}),
        ...(duplicateOf !== undefined ? { duplicateOf } : {}),
        ...(discoveryTruncated ? { discoveryTruncated } : {}),
      }),
    ),
  )
  /**
   * Read one instruction file for display (Settings → Sources opens it in the
   * shared preview dialog). Narrow and fail-closed: the path must still be a
   * discovered instruction source, so this is not a general file-read channel.
   * Reading is trust-independent on purpose — seeing what a repo's AGENTS.md
   * says is how the user decides whether to trust the workspace at all — and it
   * returns the same trimmed text the prompt would get, not the raw bytes.
   */
  ipcMain.handle('instructions:read', async (event, rawPath: unknown) => {
    assertMainFrameSender(event, win)
    const path = parseIpcArgs(zPathString, [rawPath])
    const source = (
      await loadProjectInstructionSources({ roots: senderInstructionRoots(event.sender) })
    ).find((s) => s.path === path)
    if (!source) throw new IpcValidationError('Not a discovered instruction file')
    return source.content
  })
  ipcMain.handle('cursor-rules:list', async () => {
    const root = getWorkspaceRoot()
    if (!root) return []
    return toCursorRuleSummaries(await discoverCursorRules(root))
  })
}
