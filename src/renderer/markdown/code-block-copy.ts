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

function setRunButtonState(
  button: HTMLButtonElement,
  state: 'idle' | 'running' | 'succeeded' | 'failed',
): void {
  button.dataset['runState'] = state
  button.disabled = state === 'running'
  button.classList.toggle('is-running', state === 'running')
  if (state === 'running') {
    button.setAttribute('aria-label', 'Command running')
    button.setAttribute('data-tooltip', 'Command running')
    button.replaceChildren(spinnerIcon('ui-icon ui-icon-sm'))
  } else if (state === 'succeeded') {
    button.setAttribute('aria-label', 'Run command again')
    button.setAttribute('data-tooltip', 'Result attached · Run again')
    button.replaceChildren(checkIcon('ui-icon ui-icon-sm'))
  } else if (state === 'failed') {
    button.setAttribute('aria-label', 'Run command again')
    button.setAttribute('data-tooltip', 'Command failed · Result attached · Run again')
    button.replaceChildren(warningIcon('ui-icon ui-icon-sm'))
  } else {
    button.setAttribute('aria-label', 'Run command')
    button.setAttribute('data-tooltip', 'Run in background and attach result')
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

export function setCodeBlockRunOutcome(
  root: ParentNode,
  requestId: string,
  exitCode: number | null,
): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>('.code-block-run')
  for (const button of buttons) {
    if (button.dataset['runId'] !== requestId) continue
    setRunButtonState(button, exitCode === 0 ? 'succeeded' : 'failed')
    return
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
    runBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const currentCode = pre.querySelector<HTMLElement>('code')
      if (!currentCode) return
      const command = copyButtonText(currentCode).trim()
      if (!command) return
      const id = crypto.randomUUID()
      runBtn.dataset['runId'] = id
      setRunButtonState(runBtn, 'running')
      runBtn.dispatchEvent(
        new CustomEvent(CODE_BLOCK_RUN_REQUEST_EVENT, {
          bubbles: true,
          detail: { id, command },
        }),
      )
    })
    actions.prepend(runBtn)
  }
}
