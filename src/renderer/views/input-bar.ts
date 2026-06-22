import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  setThreadStatus,
  clearContextSnapshot,
  setThreadWorkingBrief,
  bindThreadGitBranchIfUnset,
  setThreadDraftPrompt,
} from '@shared/store/thread-helpers.ts'
import { nextWorkingBrief } from '@shared/agent/working-brief.ts'
import { initMentionPicker } from './mention-picker.ts'
import { initSkillPicker } from './skill-picker.ts'
import { resolveSkillInvocation } from '@shared/skills/parse-skill-invocation.ts'
import { buildSkillUserText } from '@shared/skills/build-skill-user-content.ts'
import type { UserContent } from '@shared/types'
import type { AgentRunPayload, SkillSummary } from '@shared/types/skills.ts'
import { mountFooterModelPicker } from './footer-model-picker.ts'
import { mountFooterBranchStatus } from './footer-branch-status.ts'
import { createContextWheel } from './context-wheel.ts'
import { downloadThreadJsonl } from '../export-thread.ts'
import { syncAgentActivity } from '../agent-activity.ts'
import {
  buildTextWithAttachments,
  isTextBlockAttachment,
  textBlockLabel,
} from '@shared/agent/build-text-with-attachments.ts'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import { bindFileDropTarget } from '../attachments/handle-file-drop.ts'
import { formatThreadUsageCost } from '@shared/llm/estimate-cost.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'

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
  const branchHost = el('div', { class: 'footer-branch-host' })
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
  footer.append(modelHost, branchHost, exportBtn, usageGroup)
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
  const branchStatus = mountFooterBranchStatus(branchHost, store, api)

  exportBtn.addEventListener('click', () => {
    const thread = store.getState().threads.find((t) => t.id === getActiveThreadId())
    if (thread) downloadThreadJsonl(thread)
  })
  usageBtn.addEventListener('click', () => {
    costVisible = !costVisible
    updateFooter()
  })

  root.append(chips, inputRow, footer)

  const followUps = mountFollowUpSuggestions(store, api, (prompt) => {
    textarea.value = prompt
    void submit()
  })
  root.insertBefore(followUps.root, inputRow)
  const defaultPlaceholder = 'Message…'
  const followUpPlaceholder = 'Send follow-up'

  let attachedFiles: { path: string; content: string }[] = []
  let attachedTextBlocks: { id: string; label: string; content: string }[] = []
  let attachedImages: { dataUrl: string; mimeType: string }[] = []

  function getActiveThreadId() {
    return store.getState().activeThreadId
  }
  function isRunning() {
    const t = store.getState().threads.find((tt) => tt.id === getActiveThreadId())
    return t?.status === 'running'
  }

  let activeComposerThreadId = getActiveThreadId()

  function persistComposerDraft(): void {
    const id = activeComposerThreadId
    if (!id) return
    setThreadDraftPrompt(store, id, textarea.value)
  }

  function syncComposerThread(): void {
    const id = getActiveThreadId()
    if (id === activeComposerThreadId) return
    if (activeComposerThreadId) {
      setThreadDraftPrompt(store, activeComposerThreadId, textarea.value)
    }
    const thread = store.getState().threads.find((t) => t.id === id)
    textarea.value = thread?.draftPrompt ?? ''
    activeComposerThreadId = id
  }

  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
  textarea.addEventListener('input', () => {
    const id = getActiveThreadId()
    if (!id) return
    if (draftSaveTimer !== null) clearTimeout(draftSaveTimer)
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null
      setThreadDraftPrompt(store, id, textarea.value)
    }, 250)
  })

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
        ? `${inputTokens} in / ${outputTokens} out · ${formatThreadUsageCost(thread?.usage ?? { inputTokens: 0, outputTokens: 0 }, model)}`
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

  function isAutocompletePickerOpen() {
    return root.querySelector('.mention-picker:not([hidden])') !== null
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key !== 'Enter' || e.shiftKey) return
    if (isAutocompletePickerOpen()) return
    e.preventDefault()
    void submit()
  })

  async function submit() {
    followUps.clearSuggestions()
    textarea.placeholder = defaultPlaceholder
    const rawText = textarea.value.trim()
    if (
      !rawText &&
      attachedFiles.length === 0 &&
      attachedTextBlocks.length === 0 &&
      attachedImages.length === 0
    )
      return
    const id = getActiveThreadId()
    if (!id) return

    const branchStatus = await api.git.branchStatus()
    const currentBranch = branchStatus.currentBranch
    const thread = store.getState().threads.find((t) => t.id === id)
    if (threadGitBranchMismatch(thread?.gitBranch, currentBranch)) {
      textarea.setCustomValidity(threadGitBranchMismatchMessage(thread!.gitBranch!))
      textarea.reportValidity()
      return
    }

    const skills = skillsCache ?? (await api.skills.list())
    skillsCache = skills
    const skillNames = skills.map((skill) => skill.name)
    const invocation = resolveSkillInvocation(rawText, skillNames)
    const invokedSkills = invocation ? [invocation.skillName] : []

    if (invocation && !skills.some((skill) => skill.name === invocation.skillName)) {
      textarea.setCustomValidity(`Unknown skill: /${invocation.skillName}`)
      textarea.reportValidity()
      return
    }

    const text = invocation
      ? buildSkillUserText(
          invocation.skillName,
          invocation.remainder,
          attachedFiles.length > 0 || attachedImages.length > 0,
        )
      : rawText
    textarea.setCustomValidity('')

    let fullContent: UserContent
    if (attachedImages.length > 0) {
      fullContent = [
        ...attachedImages.map((img) => ({ type: 'image' as const, dataUrl: img.dataUrl })),
        {
          type: 'text' as const,
          text: buildTextWithAttachments(text, attachedFiles, attachedTextBlocks),
        },
      ]
    } else {
      fullContent = buildTextWithAttachments(text, attachedFiles, attachedTextBlocks)
    }

    const priorTodos = thread?.todos ?? []
    const workingBrief = nextWorkingBrief(thread?.workingBrief, fullContent)
    if (workingBrief && workingBrief !== thread?.workingBrief) {
      setThreadWorkingBrief(store, id, workingBrief)
    }
    const payload: AgentRunPayload = {
      content: fullContent,
      invokedSkills,
      priorTodos,
      ...(workingBrief !== undefined ? { workingBrief } : {}),
    }

    // Record the user's message in the conversation and mark the thread running
    // before dispatching to the agent — the controller only adds assistant
    // messages, so without this the user's own prompt never appears.
    const displayParts: string[] = []
    if (rawText) displayParts.push(rawText)
    attachedFiles.forEach((f) => displayParts.push(`📎 ${f.path.split('/').pop() ?? f.path}`))
    attachedTextBlocks.forEach((b) => displayParts.push(`📝 ${b.label}`))
    const imageUrls = attachedImages.map((img) => img.dataUrl)
    addMessage(store, id, 'user', displayParts.join('\n'), imageUrls.length ? imageUrls : undefined)
    if (currentBranch) bindThreadGitBranchIfUnset(store, id, currentBranch)
    clearContextSnapshot(store, id)
    setThreadStatus(store, id, 'running')
    syncAgentActivity(store, id, false)

    void api.agent.run(id, JSON.stringify(payload))
    textarea.value = ''
    setThreadDraftPrompt(store, id, '')
    attachedFiles = []
    attachedTextBlocks = []
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

  function addTextChip(content: string) {
    const id = crypto.randomUUID()
    const label = textBlockLabel(content)
    attachedTextBlocks.push({ id, label, content })
    const chip = document.createElement('span')
    chip.className = 'attachment-chip text-chip'
    chip.textContent = label
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedTextBlocks = attachedTextBlocks.filter((b) => b.id !== id)
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

  const attachmentHandlers = {
    attachFile: addChip,
    attachTextBlock: addTextChip,
    attachImage: addImageChip,
  }
  const unregisterAttachments = registerPromptAttachments(attachmentHandlers)

  const onPaste = (e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const img = items.find((i) => i.type.startsWith('image/'))
    if (img) {
      e.preventDefault()
      const blob = img.getAsFile()
      if (!blob) return
      void readAsDataUrl(blob).then((dataUrl) => addImageChip(dataUrl, blob.type))
      return
    }

    if (!textarea.matches(':focus')) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!isTextBlockAttachment(text)) return
    e.preventDefault()
    addTextChip(text)
  }
  document.addEventListener('paste', onPaste)

  const unbindDrop = bindFileDropTarget(
    root,
    () => attachmentHandlers,
    api,
    () => store.getState().workspaceRoot,
  )

  initMentionPicker({ textarea, inputBar: root, store, api, onAttach: addChip })

  let skillsCache: SkillSummary[] | null = null
  const refreshSkillsCache = (): void => {
    void api.skills.list().then((skills) => {
      skillsCache = skills
    })
  }
  refreshSkillsCache()
  // Skills are workspace-scoped; drop the stale list when the workspace changes
  // so inline /skill detection and validation use the new workspace's skills.
  const unsubWorkspace = store.on('workspace_changed', () => {
    skillsCache = null
    refreshSkillsCache()
  })

  const skillPicker = initSkillPicker({
    textarea,
    inputBar: root,
    listSkills: () => api.skills.list(),
  })

  const unsubs = [
    store.on('composer_draft_flush', persistComposerDraft),
    store.on('thread_status_changed', (tid) => {
      if (tid === getActiveThreadId()) updateState()
    }),
    store.on('threads_changed', () => {
      syncComposerThread()
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

  const observer = new MutationObserver(() => {
    const hasSuggestions = !followUps.root.hidden
    textarea.placeholder = hasSuggestions ? followUpPlaceholder : defaultPlaceholder
  })
  observer.observe(followUps.root, { attributes: true, attributeFilter: ['hidden'] })

  updateFooter()
  syncComposerThread()
  return () => {
    if (draftSaveTimer !== null) clearTimeout(draftSaveTimer)
    if (activeComposerThreadId) {
      setThreadDraftPrompt(store, activeComposerThreadId, textarea.value)
    }
    unsubs.forEach((u) => u())
    unsubWorkspace()
    document.removeEventListener('paste', onPaste)
    observer.disconnect()
    followUps.destroy()
    unbindDrop()
    unregisterAttachments()
    modelPicker.destroy()
    branchStatus()
    skillPicker()
  }
}
