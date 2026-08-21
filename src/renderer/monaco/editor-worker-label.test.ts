import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EDITOR_WORKER_SERVICE_LABEL } from './setup.ts'

// This test exists to catch label drift on monaco-editor upgrades.
//
// setup.ts pre-warms one worker under EDITOR_WORKER_SERVICE_LABEL so the first
// diff computes without waiting on a cold boot. The label is Monaco's own —
// its EditorWorkerService passes it to `MonacoEnvironment.getWorker` — and
// Monaco exports no constant for it, so nothing in the type system pins the
// coupling. If an upgrade renames it, the warm slot would sit under a label no
// request ever takes: exactly the orphan-worker behaviour the old 'editor'
// label caused (#1753), restored silently. Reading Monaco's shipped source
// keeps the drift loud instead.

const EDITOR_WORKER_SERVICE_JS = join(
  process.cwd(),
  'node_modules',
  'monaco-editor',
  'esm',
  'vs',
  'editor',
  'browser',
  'services',
  'editorWorkerService.js',
)

describe('monaco editor-worker label coupling', () => {
  it('monaco still requests the label setup.ts pre-warms', () => {
    if (!existsSync(EDITOR_WORKER_SERVICE_JS)) {
      // Environments without node_modules — skip rather than fail the suite.
      // (If monaco-editor moved the file, the content assertion below is the
      // one meant to fire: re-locate the EditorWorkerService source and update
      // the path here.)
      return
    }
    const source = readFileSync(EDITOR_WORKER_SERVICE_JS, 'utf8')
    assert.match(
      source,
      new RegExp(`label:\\s*['"]${EDITOR_WORKER_SERVICE_LABEL}['"]`),
      `monaco-editor no longer passes '${EDITOR_WORKER_SERVICE_LABEL}' to getWorker — ` +
        'update EDITOR_WORKER_SERVICE_LABEL in setup.ts to the new label, or the ' +
        'pre-warmed diff worker will never be claimed (#1753 regression)',
    )
  })
})
