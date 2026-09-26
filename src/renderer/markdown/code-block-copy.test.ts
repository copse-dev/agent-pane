import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachCodeBlockCopyButtons,
  bindCodeBlockRunRequests,
  setCodeBlockRunOutcome,
} from './code-block-copy.ts'
import { qs, qsRequired } from '../dom/helpers.ts'

function installClipboard(): string[] {
  const writes: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: (text: string): Promise<void> => {
          writes.push(text)
          return Promise.resolve()
        },
      },
    },
  })
  return writes
}

function preWithCode(code: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<pre><code>${code}</code></pre>`
  return root
}

describe('attachCodeBlockCopyButtons', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
  })
  afterEach(() => {
    mock.timers.reset()
  })

  it('wraps a code block in a shell with a copy button', () => {
    const root = preWithCode('const x = 1')
    attachCodeBlockCopyButtons(root)

    const button = qsRequired<HTMLButtonElement>(root, '.code-block-shell button.code-block-copy')
    assert.equal(button.textContent, 'Copy')
    const pre = qsRequired<HTMLPreElement>(root, 'pre')
    assert.equal(pre.dataset['copyAttached'], 'true')
    assert.equal(pre.classList.contains('code-block'), true)
  })

  it('copies the code text and flips to Copied, then resets', () => {
    const writes = installClipboard()
    const root = preWithCode('  spaced start')
    attachCodeBlockCopyButtons(root)
    const button = qsRequired<HTMLButtonElement>(root, 'button.code-block-copy')

    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    // Microtask for the clipboard promise, then assert the copied label + reset.
    return Promise.resolve().then(() => {
      assert.deepEqual(writes, ['spaced start']) // textContent.trimStart()
      assert.equal(button.textContent, 'Copied')
      mock.timers.tick(1300)
      assert.equal(button.textContent, 'Copy')
    })
  })

  it('offers run only for shell fences and conservative unlabelled commands', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<pre><code class="hljs lang-typescript">export const x = 1</code></pre>' +
      '<pre><code class="hljs lang-bash">pnpm test</code></pre>' +
      '<pre><code>node scripts/check.mts</code></pre>'

    attachCodeBlockCopyButtons(root, { runCommands: true })

    assert.equal(root.querySelectorAll('.code-block-copy').length, 3)
    assert.equal(root.querySelectorAll('.code-block-run').length, 2)
  })

  it('emits the exact command and reflects its completion outcome', () => {
    const root = preWithCode('node scripts/check.mts --focused')
    const requests: Array<{ id: string; command: string }> = []
    const unbind = bindCodeBlockRunRequests(root, (request) => requests.push(request))
    attachCodeBlockCopyButtons(root, { runCommands: true })
    const button = qsRequired<HTMLButtonElement>(root, '.code-block-run')

    button.click()

    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.ok(request)
    assert.equal(request.command, 'node scripts/check.mts --focused')
    assert.equal(button.dataset['runState'], 'running')
    assert.equal(button.disabled, true)
    const requestId = request.id
    setCodeBlockRunOutcome(root, requestId, { exitCode: 0, output: 'checked\n' })
    assert.equal(button.dataset['runState'], 'succeeded')
    assert.equal(button.disabled, false)
    assert.equal(button.querySelector('svg')?.dataset['icon'], 'check')
    unbind()
  })

  it('shows the run under its code block, from running to its output', () => {
    const root = preWithCode('pnpm test')
    attachCodeBlockCopyButtons(root, { runCommands: true })
    const button = qsRequired<HTMLButtonElement>(root, '.code-block-run')

    button.click()

    const panel = qsRequired<HTMLDetailsElement>(root, '.code-block-shell > .code-block-output')
    assert.equal(panel.open, true)
    assert.equal(panel.dataset['runState'], 'running')
    assert.equal(panel.querySelector('summary')?.textContent, 'Running…')
    assert.equal(panel.querySelector('.code-block-output-text'), null)

    const requestId = button.dataset['runId'] ?? ''
    setCodeBlockRunOutcome(root, requestId, { exitCode: 1, output: '$ pnpm test\nFAIL\n\n' })
    assert.equal(panel.dataset['runState'], 'failed')
    assert.equal(panel.querySelector('summary')?.textContent, 'Output · exit 1')
    assert.equal(panel.querySelector('.code-block-output-text')?.textContent, '$ pnpm test\nFAIL')
    assert.equal(root.querySelectorAll('.code-block-output').length, 1, 'one panel per block')
  })

  it('says so when a run produced no output or never started', () => {
    const root = document.createElement('div')
    root.innerHTML = '<pre><code>pnpm lint</code></pre><pre><code>pnpm build</code></pre>'
    attachCodeBlockCopyButtons(root, { runCommands: true })
    const [quiet, unstarted] = root.querySelectorAll<HTMLButtonElement>('.code-block-run')
    assert.ok(quiet && unstarted)
    quiet.click()
    unstarted.click()

    setCodeBlockRunOutcome(root, quiet.dataset['runId'] ?? '', { exitCode: 0, output: '  \n' })
    setCodeBlockRunOutcome(root, unstarted.dataset['runId'] ?? '', { exitCode: null, output: '' })

    const [quietPanel, unstartedPanel] = root.querySelectorAll('.code-block-output')
    assert.ok(quietPanel && unstartedPanel)
    assert.equal(quietPanel.querySelector('summary')?.textContent, 'Output · exit 0')
    assert.equal(quietPanel.querySelector('.code-block-output-empty')?.textContent, 'No output')
    assert.equal(unstartedPanel.querySelector('summary')?.textContent, 'Could not run')
  })

  it('picks a run back up when its message is rendered again', async () => {
    const message = document.createElement('div')
    message.dataset['messageId'] = 'msg-rerender'
    const first = preWithCode('pnpm test --filter rerender')
    message.append(first)
    attachCodeBlockCopyButtons(first, { runCommands: true })
    const button = qsRequired<HTMLButtonElement>(first, '.code-block-run')
    button.click()
    const requestId = button.dataset['runId'] ?? ''

    // A thread switch rebuilds the body before it rejoins its message element.
    const running = preWithCode('pnpm test --filter rerender')
    attachCodeBlockCopyButtons(running, { runCommands: true })
    message.replaceChildren(running)
    await Promise.resolve()
    const restored = qsRequired<HTMLButtonElement>(running, '.code-block-run')
    assert.equal(restored.dataset['runState'], 'running')
    assert.equal(qs(running, '.code-block-output summary')?.textContent, 'Running…')

    // The run finishes while that body is on screen, then it is rebuilt again.
    setCodeBlockRunOutcome(message, requestId, { exitCode: 0, output: 'ok' })
    assert.equal(restored.dataset['runState'], 'succeeded')
    const finished = preWithCode('pnpm test --filter rerender')
    attachCodeBlockCopyButtons(finished, { runCommands: true })
    message.replaceChildren(finished)
    await Promise.resolve()
    assert.equal(
      qs<HTMLButtonElement>(finished, '.code-block-run')?.dataset['runState'],
      'succeeded',
    )
    assert.equal(qs(finished, '.code-block-output-text')?.textContent, 'ok')
  })

  it('is idempotent and skips mermaid pre blocks', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="mermaid-diagram"><pre class="mermaid"><code>graph</code></pre></div>' +
      '<pre><code>real</code></pre>'
    attachCodeBlockCopyButtons(root)
    attachCodeBlockCopyButtons(root) // second pass must not double-wrap

    assert.equal(root.querySelectorAll('.code-block-shell').length, 1)
    assert.equal(root.querySelectorAll('button.code-block-copy').length, 1)
    // The mermaid block is untouched.
    assert.equal(qs<HTMLPreElement>(root, 'pre.mermaid')?.dataset['copyAttached'], undefined)
  })

  it('skips pre blocks without code children', () => {
    const root = document.createElement('div')
    root.innerHTML = '<pre>plain preformatted text</pre>'

    attachCodeBlockCopyButtons(root)

    assert.equal(root.querySelector('.code-block-shell'), null)
    assert.equal(qs<HTMLPreElement>(root, 'pre')?.dataset['copyAttached'], undefined)
  })
})
