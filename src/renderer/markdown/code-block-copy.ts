import { isRecord } from '@shared/unknown-value.ts'
import { el } from '../dom/helpers.ts'
import { checkIcon, playIcon, spinnerIcon, warningIcon } from '../dom/icons.ts'

const COPY_LABEL = 'Copy'
const COPIED_LABEL = 'Copied'
const FEEDBACK_MS = 1200
const CODE_BLOCK_RUN_REQUEST_EVENT = 'copse:code-block-run-request'

const SHELL_LANGUAGES = new Set([
  'bash',
  'bat',
  'cmd',
  'console',
  'fish',
  'powershell',
  'pwsh',
  'sh',
  'shell',
  'terminal',
  'zsh',
])

// Unlabelled one-line blocks are common in short "run this" replies. Keep the
// fallback deliberately conservative so examples of TypeScript, JSON, etc. do
// not gain an action that would feed them to a shell.
const COMMON_SHELL_COMMANDS = new Set([
  'adb',
  'bash',
  'bun',
  'bundle',
  'cargo',
  'cat',
  'cd',
  'cmake',
  'corepack',
  'curl',
  'deno',
  'docker',
  'electron',
  'eslint',
  'gh',
  'git',
  'go',
  'gradle',
  'java',
  'make',
  'mvn',
  'node',
  'npm',
  'npx',
  'pnpm',
  'podman',
  'powershell',
  'pwsh',
  'pytest',
  'python',
  'python3',
  'rg',
  'ruby',
  'sh',
  'swift',
  'terraform',
  'tofu',
  'tsc',
  'uv',
  'vite',
  'vitest',
  'wdio',
  'xcodebuild',
  'yarn',
  'zsh',
])

export interface CodeBlockRunRequest {
  id: string
  command: string
}

export interface CodeBlockCopyOptions {
  runCommands?: boolean
}

export interface CodeBlockRunOutcome {
  /** Null when the command never ran (no thread to run it for). */
  exitCode: number | null
  /** The terminal's text, ANSI-free, as the agent receives it. */
  output: string
}

type RunState = 'idle' | 'running' | 'succeeded' | 'failed'

interface CodeBlockRun {
  id: string
  state: RunState
  outcome: CodeBlockRunOutcome | null
}

// A run outlives the DOM that started it: switching threads, or the final
// render replacing the streaming scaffold, rebuilds every code block. Runs are
// remembered per message and command so a rebuilt block picks its run back up —
// still spinning if it has not finished, with its output if it has. In memory
// only; after a reload the sent result in the transcript is the record.
const REMEMBERED_RUN_LIMIT = 100
const runsByBlock = new Map<string, CodeBlockRun>()

function runKey(pre: HTMLElement, command: string): string | null {
  const messageId = pre.closest<HTMLElement>('[data-message-id]')?.dataset['messageId']
  return messageId ? `${messageId}\u0000${command}` : null
}

function rememberRun(key: string, run: CodeBlockRun): void {
  runsByBlock.delete(key)
  runsByBlock.set(key, run)
  for (const oldest of runsByBlock.keys()) {
    if (runsByBlock.size <= REMEMBERED_RUN_LIMIT) break
    runsByBlock.delete(oldest)
  }
}

function copyButtonText(code: HTMLElement): string {
  return code.textContent.trimStart()
}

function explicitCodeLanguage(code: HTMLElement): string | null {
  for (const className of code.classList) {
    if (className.startsWith('lang-')) return className.slice('lang-'.length).toLowerCase()
    if (className.startsWith('language-')) return className.slice('language-'.length).toLowerCase()
  }
  return null
}

function looksLikeUnlabelledCommand(source: string): boolean {
  const line = source.trim().replace(/^\$\s+/, '')
  if (!line || line.includes('\n')) return false
  const words = line.split(/\s+/)
  let index = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1
  const head = words[index]
  if (!head) return false
  if (/^(?:\.\.?[\\/])/.test(head)) return true
  const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  const basename = (slash >= 0 ? head.slice(slash + 1) : head).toLowerCase()
  return COMMON_SHELL_COMMANDS.has(basename)
}

export function isRunnableCodeBlock(code: HTMLElement): boolean {
  const language = explicitCodeLanguage(code)
  if (language !== null) return SHELL_LANGUAGES.has(language)
  return looksLikeUnlabelledCommand(copyButtonText(code))
}

function setRunButtonState(button: HTMLButtonElement, state: RunState): void {
  button.dataset['runState'] = state
  button.disabled = state === 'running'
  button.classList.toggle('is-running', state === 'running')
  if (state === 'running') {
    button.setAttribute('aria-label', 'Command running')
    button.setAttribute('data-tooltip', 'Command running')
    button.replaceChildren(spinnerIcon('ui-icon ui-icon-sm'))
  } else if (state === 'succeeded') {
    button.setAttribute('aria-label', 'Run command again')
    button.setAttribute('data-tooltip', 'Run again')
    button.replaceChildren(checkIcon('ui-icon ui-icon-sm'))
  } else if (state === 'failed') {
    button.setAttribute('aria-label', 'Run command again')
    button.setAttribute('data-tooltip', 'Command failed · Run again')
    button.replaceChildren(warningIcon('ui-icon ui-icon-sm'))
  } else {
    button.setAttribute('aria-label', 'Run command')
    button.setAttribute('data-tooltip', 'Run and send the result to the agent')
    button.replaceChildren(playIcon('ui-icon ui-icon-sm'))
  }
}

export function bindCodeBlockRunRequests(
  root: EventTarget,
  handler: (request: CodeBlockRunRequest) => void,
): () => void {
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent) || !isRecord(event.detail)) return
    const id = event.detail['id']
    const command = event.detail['command']
    if (typeof id !== 'string' || typeof command !== 'string') return
    handler({ id, command })
  }
  root.addEventListener(CODE_BLOCK_RUN_REQUEST_EVENT, listener)
  return () => {
    root.removeEventListener(CODE_BLOCK_RUN_REQUEST_EVENT, listener)
  }
}

function runSummary(run: CodeBlockRun): string {
  if (!run.outcome) return 'Running…'
  const { exitCode } = run.outcome
  return exitCode === null ? 'Could not run' : `Output · exit ${String(exitCode)}`
}

/** Show `run` in the panel under its code block, creating the panel on first use. */
function renderRunOutput(shell: HTMLElement, run: CodeBlockRun): void {
  let panel = shell.querySelector<HTMLDetailsElement>(':scope > .code-block-output')
  if (!panel) {
    panel = el('details', { class: 'code-block-output', open: true })
    shell.append(panel)
  }
  panel.dataset['runState'] = run.state
  const summary = el('summary', { class: 'code-block-output-summary' }, runSummary(run))
  if (!run.outcome) {
    panel.replaceChildren(summary)
    return
  }
  const output = run.outcome.output.trimEnd()
  panel.replaceChildren(
    summary,
    output
      ? el('div', { class: 'code-block-output-text' }, output)
      : el('div', { class: 'code-block-output-empty' }, 'No output'),
  )
}

function showRun(shell: HTMLElement, button: HTMLButtonElement, run: CodeBlockRun): void {
  button.dataset['runId'] = run.id
  setRunButtonState(button, run.state)
  renderRunOutput(shell, run)
}

export function setCodeBlockRunOutcome(
  root: ParentNode,
  requestId: string,
  outcome: CodeBlockRunOutcome,
): void {
  const state: RunState = outcome.exitCode === 0 ? 'succeeded' : 'failed'
  let run: CodeBlockRun | undefined
  for (const remembered of runsByBlock.values()) {
    if (remembered.id !== requestId) continue
    remembered.state = state
    remembered.outcome = outcome
    run = remembered
  }
  run ??= { id: requestId, state, outcome }
  const buttons = root.querySelectorAll<HTMLButtonElement>('.code-block-run')
  for (const button of buttons) {
    if (button.dataset['runId'] !== requestId) continue
    const shell = button.closest<HTMLElement>('.code-block-shell')
    if (shell) showRun(shell, button, run)
  }
}

export function attachCodeBlockCopyButtons(
  root: ParentNode,
  options: CodeBlockCopyOptions = {},
): void {
  // Keep the selector compatible with engines that do not yet implement
  // relational `:has()` in the Selectors API (notably Servo). The `code`
  // lookup below already provides the same filtering behavior.
  const blocks = root.querySelectorAll('pre:not(.mermaid)')
  for (const node of blocks) {
    if (!(node instanceof HTMLElement)) continue
    const pre = node
    if (pre.closest('.mermaid-diagram')) continue

    const code = pre.querySelector('code')
    if (!code) continue

    let shell = pre.parentElement?.classList.contains('code-block-shell') ? pre.parentElement : null
    if (!shell) {
      const parent = pre.parentNode
      if (!parent) continue
      pre.dataset['copyAttached'] = 'true'
      pre.classList.add('code-block')
      shell = el('div', { class: 'code-block-shell' })
      parent.insertBefore(shell, pre)
      shell.append(pre)

      const actions = el('div', { class: 'code-block-actions' })
      const copyBtn = el(
        'button',
        { class: 'code-block-copy', 'aria-label': 'Copy code' },
        COPY_LABEL,
      )
      copyBtn.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const currentCode = pre.querySelector<HTMLElement>('code')
        if (!currentCode) return
        void navigator.clipboard.writeText(copyButtonText(currentCode)).then(() => {
          copyBtn.textContent = COPIED_LABEL
          setTimeout(() => {
            copyBtn.textContent = COPY_LABEL
          }, FEEDBACK_MS)
        })
      })
      actions.append(copyBtn)
      shell.prepend(actions)
    }

    if (!options.runCommands || !isRunnableCodeBlock(code)) continue
    const actions = shell.querySelector('.code-block-actions')
    if (!actions || actions.querySelector('.code-block-run')) continue
    const runBtn = el('button', { class: 'code-block-run', type: 'button' })
    setRunButtonState(runBtn, 'idle')
    const runShell = shell
    runBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const currentCode = pre.querySelector<HTMLElement>('code')
      if (!currentCode) return
      const command = copyButtonText(currentCode).trim()
      if (!command) return
      const run: CodeBlockRun = { id: crypto.randomUUID(), state: 'running', outcome: null }
      const key = runKey(pre, command)
      if (key) rememberRun(key, run)
      showRun(runShell, runBtn, run)
      runBtn.dispatchEvent(
        new CustomEvent(CODE_BLOCK_RUN_REQUEST_EVENT, {
          bubbles: true,
          detail: { id: run.id, command },
        }),
      )
    })
    // A first render builds the message body before it joins its message
    // element, so the message id is only reachable once this task's DOM work
    // is done.
    if (runsByBlock.size > 0) {
      queueMicrotask(() => {
        const command = copyButtonText(code).trim()
        const key = runKey(pre, command)
        const run = key ? runsByBlock.get(key) : undefined
        if (run && !runBtn.dataset['runId']) showRun(runShell, runBtn, run)
      })
    }
    actions.prepend(runBtn)
  }
}
