import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { addMessage, setThreadStatus, clearContextSnapshot } from '@shared/store/thread-helpers.ts'
import { initMentionPicker } from './mention-picker.ts'
import { initSkillPicker } from './skill-picker.ts'
import { parseSkillInvocation } from '@shared/skills/parse-skill-invocation.ts'
import type { UserContent } from '@shared/types'
import type { AgentRunPayload, SkillSummary } from '@shared/types/skills.ts'
import { mountFooterModelPicker } from './footer-model-picker.ts'
import { createContextWheel } from './context-wheel.ts'
import { downloadThreadJsonl } from '../export-thread.ts'
import { syncAgentActivity } from '../agent-activity.ts'

export function mountInputBar(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const chips = el('div', { class: 'attachment-chips' })
  const textarea = el('textarea', {
    class: 'prompt-input',
    rows: '3',
    'aria-label': 'Message',
    placeholder: 'Message…',
  })
  const submitBtn = el('button', { class: 'submit-btn' }, 'Send')
  // The Send button is positioned relative to this row (not the whole input
  // bar), so it sits inside the textarea box and never overlaps the footer.
  const inputRow = el('div', { class: 'input-row' }, textarea, submitBtn)
  const footer = el('div', { class: 'input-footer' })
  const modelHost = el('div', { class: 'footer-model-host' })
  const exportBtn = el(
    'button',
    {
      type: 'button',
      class: 'footer-export',
      'aria-label': 'Export conversation as JSONL',
    },
    'Export',
  )
  // Token usage — always shown once a thread has used tokens; click to expand
  // into the in/out breakdown and cost.
  const usageBtn = el('button', { class: 'footer-usage', 'aria-label': 'Toggle cost details' })
  const usageGroup = el('div', { class: 'footer-usage-group' })
  const contextWheel = createContextWheel()
  usageGroup.append(contextWheel.root, usageBtn)
  footer.append(modelHost, exportBtn, usageGroup)
  let costVisible = false

  const modelPicker = mountFooterModelPicker(
    modelHost,
    api,
    () => store.getState().settings?.model ?? 'claude-sonnet-4-6',
    (model) => {
      void api.settings.set('model', model)
      store.setState({ settings: { ...store.getState().settings, model } })
      updateFooter()
    },
  )

  exportBtn.addEventListener('click', () => {
    const thread = store.getState().threads.find((t) => t.id === getActiveThreadId())
    if (thread) downloadThreadJsonl(thread)
  })
  usageBtn.addEventListener('click', () => {
    costVisible = !costVisible
    updateFooter()
  })

  root.append(chips, inputRow, footer)

  let attachedFiles: { path: string; content: string }[] = []
  let attachedImages: { dataUrl: string; mimeType: string }[] = []

  function getActiveThreadId() {
    return store.getState().activeThreadId
  }
  function isRunning() {
    const t = store.getState().threads.find((tt) => tt.id === getActiveThreadId())
    return t?.status === 'running'
  }

  function updateState() {
    const running = isRunning()
    textarea.disabled = running
    submitBtn.textContent = running ? 'Stop' : 'Send'
    submitBtn.dataset.action = running ? 'abort' : 'submit'
  }

  function updateFooter() {
    const model = store.getState().settings?.model ?? 'claude-sonnet-4-6'
    const thread = store.getState().threads.find((t) => t.id === getActiveThreadId())
    const { inputTokens, outputTokens } = thread?.usage ?? { inputTokens: 0, outputTokens: 0 }
    const total = inputTokens + outputTokens
    const running = thread?.status === 'running'
    contextWheel.update(thread?.contextSnapshot, running)
    if (!total && !running) {
      usageBtn.hidden = true
    } else {
      usageBtn.hidden = false
      usageBtn.textContent = costVisible
        ? `${inputTokens} in / ${outputTokens} out · ${estimateCost(model, { inputTokens, outputTokens })}`
        : total
          ? `${(total / 1000).toFixed(1)}k tokens`
          : '0 tokens'
    }
    updateState()
  }

  submitBtn.addEventListener('click', () => {
    if (submitBtn.dataset.action === 'abort') {
      const id = getActiveThreadId()
      if (id) void api.agent.abort(id)
    } else {
      void submit()
    }
  })

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  })

  function buildTextWithAttachments(
    text: string,
    files: { path: string; content: string }[],
  ): string {
    return [text, ...files.map((f) => `\`\`\`\n// ${f.path}\n${f.content}\n\`\`\``)].join('\n\n')
  }

  async function submit() {
    const rawText = textarea.value.trim()
    if (!rawText && attachedFiles.length === 0 && attachedImages.length === 0) return
    const id = getActiveThreadId()
    if (!id) return

    const invocation = parseSkillInvocation(rawText)
    const text = invocation?.remainder ?? rawText
    const invokedSkills = invocation ? [invocation.skillName] : []

    if (invocation) {
      const skills = skillsCache ?? (await api.skills.list())
      skillsCache = skills
      if (!skills.some((skill) => skill.name === invocation.skillName)) {
        textarea.setCustomValidity(`Unknown skill: /${invocation.skillName}`)
        textarea.reportValidity()
        return
      }
    }
    textarea.setCustomValidity('')

    let fullContent: UserContent
    if (attachedImages.length > 0) {
      fullContent = [
        ...attachedImages.map((img) => ({ type: 'image' as const, dataUrl: img.dataUrl })),
        { type: 'text' as const, text: buildTextWithAttachments(text, attachedFiles) },
      ]
    } else {
      fullContent = buildTextWithAttachments(text, attachedFiles)
    }

    const payload: AgentRunPayload = { content: fullContent, invokedSkills }

    // Record the user's message in the conversation and mark the thread running
    // before dispatching to the agent — the controller only adds assistant
    // messages, so without this the user's own prompt never appears.
    const displayParts: string[] = []
    if (rawText) displayParts.push(rawText)
    attachedFiles.forEach((f) => displayParts.push(`📎 ${f.path.split('/').pop() ?? f.path}`))
    if (attachedImages.length) displayParts.push(`🖼 ${attachedImages.length} image(s)`)
    addMessage(store, id, 'user', displayParts.join('\n'))
    clearContextSnapshot(store, id)
    setThreadStatus(store, id, 'running')
    syncAgentActivity(store, id, false)

    void api.agent.run(id, JSON.stringify(payload))
    textarea.value = ''
    attachedFiles = []
    attachedImages = []
    clear(chips)
  }

  function addChip(file: { path: string; content: string }) {
    attachedFiles.push(file)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip'
    chip.textContent = file.path.split('/').pop() ?? file.path
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedFiles = attachedFiles.filter((f) => f.path !== file.path)
      chip.remove()
    })
    chip.append(remove)
    chips.append(chip)
  }

  function addImageChip(dataUrl: string, mimeType: string) {
    attachedImages.push({ dataUrl, mimeType })
    const chip = document.createElement('span')
    chip.className = 'attachment-chip image-chip'
    const thumb = document.createElement('img')
    thumb.src = dataUrl
    thumb.width = 40
    thumb.height = 40
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedImages = attachedImages.filter((i) => i.dataUrl !== dataUrl)
      chip.remove()
    })
    chip.append(thumb, remove)
    chips.append(chip)
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result as string)
      r.onerror = rej
      r.readAsDataURL(blob)
    })
  }

  document.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const img = items.find((i) => i.type.startsWith('image/'))
    if (!img) return
    e.preventDefault()
    const blob = img.getAsFile()
    if (!blob) return
    void readAsDataUrl(blob).then((dataUrl) => addImageChip(dataUrl, blob.type))
  })

  textarea.addEventListener('dragover', (e) => {
    e.preventDefault()
  })
  textarea.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (file?.type.startsWith('image/')) {
      void readAsDataUrl(file).then((dataUrl) => addImageChip(dataUrl, file.type))
    }
  })

  initMentionPicker({ textarea, inputBar: root, store, api, onAttach: addChip })

  let skillsCache: SkillSummary[] | null = null
  void api.skills.list().then((skills) => {
    skillsCache = skills
  })

  const skillPicker = initSkillPicker({
    textarea,
    inputBar: root,
    listSkills: () => api.skills.list(),
  })

  const unsubs = [
    store.on('thread_status_changed', (tid) => {
      if (tid === getActiveThreadId()) updateState()
    }),
    store.on('threads_changed', () => {
      updateState()
      updateFooter()
    }),
    store.on('usage_updated', (tid) => {
      if (tid === getActiveThreadId()) updateFooter()
    }),
    store.on('context_updated', (tid) => {
      if (tid === getActiveThreadId()) updateFooter()
    }),
    store.on('settings_changed', () => {
      modelPicker.refresh()
      updateFooter()
    }),
  ]

  updateFooter()
  return () => {
    unsubs.forEach((u) => u())
    modelPicker.destroy()
    skillPicker()
  }
}

function estimateCost(model: string, usage: { inputTokens: number; outputTokens: number }): string {
  const RATES: Record<string, [number, number]> = {
    'claude-sonnet-4-6': [3.0, 15.0],
    'claude-opus-4-8': [15.0, 75.0],
    'gpt-4o': [2.5, 10.0],
    'gpt-4o-mini': [0.15, 0.6],
  }
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) return 'free (local)'
  const rate = RATES[model]
  if (!rate) return ''
  const cost =
    (usage.inputTokens / 1_000_000) * rate[0] + (usage.outputTokens / 1_000_000) * rate[1]
  return cost < 0.01 ? '<$0.01' : `~$${cost.toFixed(2)}`
}
