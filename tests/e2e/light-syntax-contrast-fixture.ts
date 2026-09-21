/**
 * Syntax-contrast seed data for `light-syntax-contrast.e2e.ts` (#2486).
 *
 * Lives next to the spec (not under `tests/e2e/helpers/`) so the e2e oracle
 * does not treat the change as a broad helpers edit and force
 * `check:screenshots` to mark every reference screenshot stale.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'

const USER_DATA = copseUserDataDir()
const SETTINGS_PATH = join(USER_DATA, 'settings.json')

/**
 * A JSON block (attr/string/number/literal tokens) and a TypeScript block
 * (comment/keyword/title/type tokens) in one thread, with the theme pinned —
 * the Electron e2e counterpart to `light-contrast-surfaces.demo.ts` for
 * issue #2486, used where a real, tokenised `.hljs-*` render (not a stylesheet
 * computation) is the evidence needed.
 */
export function seedSyntaxContrastFixture(workspaceRoot: string, theme: 'light' | 'dark'): void {
  const projectId = 'e2e-syntax-contrast-project'
  const threadId = 'e2e-syntax-contrast-thread'
  const content = [
    'Here is the resolved model configuration:',
    '',
    '```json',
    '{',
    '  "model": "claude-opus-4",',
    '  "temperature": 0.2,',
    '  "maxTokens": 8192,',
    '  "stream": true,',
    '  "systemPrompt": null',
    '}',
    '```',
    '',
    'and the loop that reads it:',
    '',
    '```ts',
    '// Resolve the model for this turn.',
    'function resolveModel(settings: Settings): string {',
    "  return settings.model ?? 'claude-opus-4'",
    '}',
    '```',
  ].join('\n')
  resetUserData()
  mkdirSync(USER_DATA, { recursive: true })
  // Mirrors helpers/seed-config.ts's private writeSettings() defaults
  // (deterministic screenshots, no real LM Studio probe) plus the theme this
  // fixture pins. Duplicated rather than exported from seed-config.ts so this
  // spec's fixture stays local and the oracle keeps mapping it to just this
  // spec.
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      onboardingCompleted: true,
      theme,
      uiTintStrength: 'off',
      localServerUrl: 'http://127.0.0.1:1/v1',
    }),
    'utf8',
  )
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Syntax contrast',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-syntax-contrast',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}
