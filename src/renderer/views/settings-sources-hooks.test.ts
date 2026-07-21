// Sources → Hooks rendering (issue A4 of docs/plans/hooks-and-feature-packs.md):
// the cursorHooksEnabled toggle, per-entry validation warning rows, "unsupported"
// badges for declared-but-unwired events, and the per-hook runtime error state.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type {
  HooksListResult,
  HookSummary,
  HookTestResult,
  HookValidationWarning,
} from '@shared/types/hooks.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

/** Records the last `hooks:test` request the stub received (for click-through assertions). */
let lastTestRequest: unknown

/**
 * Recursive never-settling stub (as in settings-dialog.test.ts) with the five
 * Sources list endpoints overridden so `refreshSources` can actually complete.
 * `hooks.test` (G2 dry-run) resolves to `testResult` and records its request.
 */
function stubApi(hooksResult: HooksListResult, testResult?: HookTestResult): ApiClient {
  const fallback: unknown = new Proxy(() => new Promise(() => {}), {
    get: () => fallback,
    apply: () => new Promise(() => {}),
  })
  const overrides: Record<string, unknown> = {
    instructions: { list: () => Promise.resolve([]) },
    cursorRules: { list: () => Promise.resolve([]) },
    skills: { list: () => Promise.resolve([]) },
    plugins: { list: () => Promise.resolve([]) },
    hooks: {
      list: () => Promise.resolve(hooksResult),
      test: (req: unknown) => {
        lastTestRequest = req
        return Promise.resolve(testResult ?? { ran: false, error: 'no result' })
      },
    },
  }
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === 'string' && prop in overrides ? overrides[prop] : fallback,
    },
  )
  return proxy as ApiClient
}

const VALID_HOOK: HookSummary = {
  family: 'cursor',
  event: 'beforeShellExecution',
  command: './audit.sh',
  source: '/home/user/.cursor/hooks.json',
  scope: 'user',
  supported: true,
}

const UNSUPPORTED_HOOK: HookSummary = {
  family: 'cursor',
  event: 'stop',
  command: './notify.sh',
  source: '/home/user/.cursor/hooks.json',
  scope: 'user',
  supported: false,
}

const FAILED_HOOK: HookSummary = {
  family: 'cursor',
  event: 'beforeMCPExecution',
  command: './broken.sh',
  source: '/home/user/.cursor/hooks.json',
  scope: 'user',
  supported: true,
  lastError: 'printed invalid JSON — response ignored',
}

const UNSANDBOXED_HOOK: HookSummary = {
  family: 'copse',
  event: 'toolGate',
  command: './escape.sh',
  source: '/home/user/.copse/hooks.json',
  scope: 'user',
  supported: true,
  sandbox: false,
}

const WARNING: HookValidationWarning = {
  source: '/home/user/.cursor/hooks.json',
  scope: 'user',
  message: 'Unknown hook event "notARealEvent" — entries skipped',
}

async function openSources(
  hooksResult: HooksListResult,
  testResult?: HookTestResult,
  developerMode = true,
): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(createStore({ developerMode }), stubApi(hooksResult, testResult))
  const sourcesBtn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="sources"]',
  )
  assert.ok(sourcesBtn)
  sourcesBtn.click()
  // refreshSources awaits the five list promises; let the microtask queue drain.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const list = document.getElementById('sources-hooks-list')
  assert.ok(list)
  return list
}

describe('settings sources → hooks list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the cursorHooksEnabled toggle inside the Hooks fieldset', async () => {
    await openSources({ hooks: [], warnings: [] })
    const toggle = document.querySelector<HTMLInputElement>('input[name="cursorHooksEnabled"]')
    assert.ok(toggle)
    assert.equal(toggle.type, 'checkbox')
    const fieldset = toggle.closest('fieldset')
    assert.ok(fieldset)
    assert.equal(fieldset.querySelector('legend')?.textContent.trim(), 'Hooks')
    // The security copy names the hot-path and workspace-trust caveats.
    assert.match(fieldset.textContent, /hot path/)
    assert.match(fieldset.textContent, /workspace trust/)
  })

  it('hides the Hooks fieldset by default outside Developer mode', async () => {
    await openSources({ hooks: [], warnings: [] }, undefined, false)
    const fieldset = document.querySelector<HTMLElement>('[data-developer-only="hooks"]')
    assert.ok(fieldset)
    assert.equal(fieldset.hidden, true)
  })

  it('shows the empty state when nothing is configured', async () => {
    const list = await openSources({ hooks: [], warnings: [] })
    assert.match(list.textContent, /No Cursor or Claude Code hooks configured\./)
    assert.equal(list.querySelectorAll('.sources-row').length, 0)
  })

  it('renders a plain supported hook row without extra badges', async () => {
    const list = await openSources({ hooks: [VALID_HOOK], warnings: [] })
    const row = list.querySelector('.sources-row')
    assert.ok(row)
    assert.equal(row.querySelector('.sources-row-title')?.textContent, 'beforeShellExecution')
    assert.equal(row.querySelector('.sources-badge')?.textContent, 'user')
    assert.equal(row.querySelector('.sources-badge-unsupported'), null)
    assert.equal(row.querySelector('.sources-badge-error'), null)
    assert.equal(row.querySelector('.sources-row-detail')?.textContent, 'Cursor · ./audit.sh')
  })

  it('badges declared-but-unwired events as unsupported', async () => {
    const list = await openSources({ hooks: [UNSUPPORTED_HOOK], warnings: [] })
    const badge = list.querySelector('.sources-badge-unsupported')
    assert.ok(badge)
    assert.equal(badge.textContent, 'unsupported')
  })

  it('badges a `sandbox: false` (Copse) hook as running outside the sandbox (F3)', async () => {
    const list = await openSources({ hooks: [UNSANDBOXED_HOOK], warnings: [] })
    const badge = list.querySelector('.sources-badge-unsandboxed')
    assert.ok(badge)
    assert.equal(badge.textContent, 'outside sandbox')
    // The Copse family label is used (not the Cursor fallback).
    assert.equal(list.querySelector('.sources-row-detail')?.textContent, 'Copse · ./escape.sh')
  })

  it('shows the per-hook runtime error badge and message', async () => {
    const list = await openSources({ hooks: [FAILED_HOOK], warnings: [] })
    assert.equal(list.querySelector('.sources-badge-error')?.textContent, 'error')
    assert.match(
      list.querySelector('.sources-row-error')?.textContent ?? '',
      /Last run failed: printed invalid JSON/,
    )
  })

  it('renders validation warnings as warning rows above the hooks', async () => {
    const list = await openSources({ hooks: [VALID_HOOK], warnings: [WARNING] })
    const rows = Array.from(list.querySelectorAll('.sources-row'))
    assert.equal(rows.length, 2)
    const [warningRow, hookRow] = rows
    assert.ok(warningRow)
    assert.ok(warningRow.classList.contains('sources-row-warning'))
    assert.equal(warningRow.querySelector('.sources-badge-warning')?.textContent, 'warning')
    assert.match(warningRow.textContent, /notARealEvent/)
    assert.match(warningRow.textContent, /\.cursor\/hooks\.json/)
    assert.ok(hookRow && !hookRow.classList.contains('sources-row-warning'))
  })

  it('renders a per-hook Test (dry-run) button on each hook row (G2)', async () => {
    const list = await openSources({ hooks: [VALID_HOOK], warnings: [] })
    const row = list.querySelector('.sources-row')
    assert.ok(row)
    const btn = row.querySelector<HTMLButtonElement>('.sources-hook-test-btn')
    assert.ok(btn)
    assert.equal(btn.textContent, 'Test')
  })

  it('runs a dry-run and shows stdin/stdout/stderr/exit/duration + outcome (G2)', async () => {
    const testResult: HookTestResult = {
      ran: true,
      canonicalEvent: 'toolGate',
      wireEvent: 'beforeShellExecution',
      stdin: '{\n  "command": "echo hi"\n}',
      stdout: '{"permission":"allow"}',
      stderr: 'debug line',
      exitCode: 0,
      durationMs: 42,
      parseOk: true,
      sandboxed: false,
      outcomeSummary: 'allow',
    }
    const list = await openSources({ hooks: [VALID_HOOK], warnings: [] }, testResult)
    const btn = list.querySelector<HTMLButtonElement>('.sources-hook-test-btn')
    assert.ok(btn)
    btn.click()
    // The click handler awaits the async dry-run; let microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The request echoed the hook's identity to the IPC.
    assert.deepEqual(lastTestRequest, {
      family: 'cursor',
      event: 'beforeShellExecution',
      command: './audit.sh',
      source: '/home/user/.cursor/hooks.json',
      scope: 'user',
    })

    const result = list.querySelector('.hook-test')
    assert.ok(result)
    const summaryText = result.querySelector('.hook-test-summary')?.textContent ?? ''
    assert.match(summaryText, /event beforeShellExecution/)
    assert.match(summaryText, /exit 0/)
    assert.match(summaryText, /42 ms/)
    assert.match(summaryText, /parsed ok/)
    assert.match(result.querySelector('.hook-test-outcome')?.textContent ?? '', /Outcome: allow/)

    // All three streams render with their labels + captured text.
    const labels = Array.from(result.querySelectorAll('.hook-test-stream-label')).map(
      (el) => el.textContent,
    )
    assert.deepEqual(labels, ['stdin', 'stdout', 'stderr'])
    const pres = Array.from(result.querySelectorAll('.hook-test-stream pre')).map(
      (el) => el.textContent,
    )
    assert.equal(pres[1], '{"permission":"allow"}')
    assert.equal(pres[2], 'debug line')
  })

  it('shows the not-runnable notice when a dry-run cannot synthesize a payload (G2)', async () => {
    const list = await openSources(
      { hooks: [UNSUPPORTED_HOOK], warnings: [] },
      { ran: false, error: 'The "stop" event has no synthetic payload to dry-run (unsupported).' },
    )
    const btn = list.querySelector<HTMLButtonElement>('.sources-hook-test-btn')
    assert.ok(btn)
    btn.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const err = list.querySelector('.hook-test .hook-test-error')
    assert.ok(err)
    assert.match(err.textContent, /unsupported/)
  })
})
