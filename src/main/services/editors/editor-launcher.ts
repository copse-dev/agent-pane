import { spawn } from 'node:child_process'
import type { ExternalEditorList } from '@shared/types/editors.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import {
  type DetectedEditorLaunch,
  buildEditorLaunch,
  buildRemoteEditorLaunch,
  detectExternalEditors,
  parseMockEditorIds,
} from './editor-detect.ts'
import { findConfiguredSshHost } from '../ssh-workspace/hosts.ts'
import { getActiveProjectSshHost } from '../workspace.ts'

const LAST_USED_KEY = 'openInEditorLastUsed'

// Installed editors change rarely; scan once per app run and reuse. The scan is
// a handful of `which` calls plus fs.existsSync probes, so a stale miss costs a
// restart, not correctness — the dropdown only ever offers launchable entries.
let scanPromise: Promise<DetectedEditorLaunch[]> | null = null

function scanEditors(): Promise<DetectedEditorLaunch[]> {
  scanPromise ??= detectExternalEditors()
  return scanPromise
}

/** @internal test helper */
export function resetEditorScanForTest(): void {
  scanPromise = null
}

/** Installed editors plus the sticky default for the titlebar dropdown. */
export async function listExternalEditors(): Promise<ExternalEditorList> {
  const detected = await scanEditors()
  const lastUsed = storageGet(LAST_USED_KEY)
  const lastUsedId =
    typeof lastUsed === 'string' && detected.some((d) => d.editor.id === lastUsed) ? lastUsed : null
  return {
    editors: detected.map((d) => ({ id: d.editor.id, name: d.editor.name })),
    lastUsedId,
  }
}

/**
 * Launch a detected editor on the given workspace root. The renderer only ever
 * names an editor id — the folder argument comes from main-process workspace
 * state, so this IPC surface cannot be steered to run arbitrary commands.
 */
export async function openWorkspaceInExternalEditor(editorId: string, root: string): Promise<void> {
  const detected = (await scanEditors()).find((d) => d.editor.id === editorId)
  if (!detected) throw new Error(`Editor is not installed: ${editorId}`)
  storageSet(LAST_USED_KEY, editorId)
  // Under the e2e mock there is nothing real to launch.
  if (parseMockEditorIds(process.env['COPSE_PANEL_MOCK_EDITORS']) !== null) return
  const sshHostId = getActiveProjectSshHost()
  let launch: { command: string; args: string[] }
  if (sshHostId) {
    const host = findConfiguredSshHost(sshHostId)
    if (!host) throw new Error(`SSH host is not configured: ${sshHostId}`)
    launch = buildRemoteEditorLaunch(detected, root, host.host)
  } else {
    launch = buildEditorLaunch(detected, root)
  }
  const { command, args } = launch
  // Strip Copse's LLM/provider keys from the editor's env (#579): an external editor
  // never needs them, and it (or its extensions) can spawn arbitrary child processes.
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: envForRendererChildProcess(),
  })
  child.unref()
}
