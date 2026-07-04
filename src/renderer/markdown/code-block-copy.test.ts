import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { attachCodeBlockCopyButtons } from './code-block-copy.ts'
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
})
