import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveOnPath } from '../acp/acp-detect.ts'

/** A GUI editor we know how to detect and launch with a folder argument. */
export interface KnownExternalEditor {
  id: string
  name: string
  /** CLI launcher looked up on PATH (all platforms), e.g. `code`. */
  command: string
  /** macOS bundle names probed under /Applications and ~/Applications. */
  macAppNames: string[]
}

/** An editor found on this device plus how to launch it. */
export interface DetectedEditorLaunch {
  editor: KnownExternalEditor
  /** Absolute path of the CLI launcher, when found on PATH. */
  cliPath: string | null
  /** Absolute path of the macOS .app bundle, when found. */
  macAppPath: string | null
}

export const KNOWN_EXTERNAL_EDITORS: readonly KnownExternalEditor[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    command: 'code',
    macAppNames: ['Visual Studio Code.app'],
  },
  { id: 'cursor', name: 'Cursor', command: 'cursor', macAppNames: ['Cursor.app'] },
  { id: 'windsurf', name: 'Windsurf', command: 'windsurf', macAppNames: ['Windsurf.app'] },
  { id: 'zed', name: 'Zed', command: 'zed', macAppNames: ['Zed.app', 'Zed Preview.app'] },
  { id: 'sublime', name: 'Sublime Text', command: 'subl', macAppNames: ['Sublime Text.app'] },
  {
    id: 'intellij',
    name: 'IntelliJ IDEA',
    command: 'idea',
    macAppNames: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'],
  },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm', macAppNames: ['WebStorm.app'] },
]

/**
 * E2E determinism: `COPSE_PANEL_MOCK_EDITORS` is a comma-separated list of known
 * editor ids to report as installed (launching is then a no-op), so specs don't
 * depend on what the CI runner happens to have on PATH. Same pattern as
 * COPSE_PANEL_MOCK_GH / COPSE_PANEL_MOCK_BRANCH.
 */
export function parseMockEditorIds(raw: string | undefined): string[] | null {
  if (raw === undefined) return null
  const known = new Set(KNOWN_EXTERNAL_EDITORS.map((e) => e.id))
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => known.has(id))
}

function findMacAppPath(editor: KnownExternalEditor): string | null {
  for (const appName of editor.macAppNames) {
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      const candidate = join(dir, appName)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Best-effort scan for installed editors: the CLI launcher on PATH everywhere,
 * plus the .app bundle on macOS (many users never install the shell command).
 * Probing never throws — a failed lookup just means "not installed".
 */
export async function detectExternalEditors(
  platform: NodeJS.Platform = process.platform,
): Promise<DetectedEditorLaunch[]> {
  const mockIds = parseMockEditorIds(process.env['COPSE_PANEL_MOCK_EDITORS'])
  if (mockIds !== null) {
    return KNOWN_EXTERNAL_EDITORS.filter((e) => mockIds.includes(e.id)).map((editor) => ({
      editor,
      cliPath: null,
      macAppPath: null,
    }))
  }
  const probed = await Promise.all(
    KNOWN_EXTERNAL_EDITORS.map(async (editor) => ({
      editor,
      cliPath: await resolveOnPath(editor.command),
      macAppPath: platform === 'darwin' ? findMacAppPath(editor) : null,
    })),
  )
  return probed.filter((p) => p.cliPath !== null || p.macAppPath !== null)
}

/**
 * How to launch a detected editor on a folder. On macOS prefer `open -a` on the
 * bundle — it works even when the editor's shell command was never installed and
 * matches Finder semantics; elsewhere the CLI is the only launcher.
 */
export function buildEditorLaunch(
  detected: DetectedEditorLaunch,
  root: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'darwin' && detected.macAppPath) {
    return { command: 'open', args: ['-a', detected.macAppPath, root] }
  }
  if (detected.cliPath) {
    return { command: detected.cliPath, args: [root] }
  }
  throw new Error(`No launcher available for ${detected.editor.name}`)
}
