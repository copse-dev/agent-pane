import { el, clear } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  setThreadWorkingBrief,
  bindThreadGitBranchIfUnset,
  getThreadById,
  getActiveThread,
  setThreadDraftPrompt,
} from '@shared/store/thread-helpers.ts'
import { dispatchAgentRun, enqueueUserMessage } from '../controller/message-queue.ts'
import { nextWorkingBrief } from '@shared/agent/working-brief.ts'
import {
  buildTextWithAttachments,
  isTextBlockAttachment,
  textBlockLabel,
} from '@shared/agent/build-text-with-attachments.ts'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import { bindFileDropTarget, attachFiles } from '../attachments/handle-file-drop.ts'
import { initMentionPicker } from './mention-picker.ts'
import { initSkillPicker } from './skill-picker.ts'
import { resolveSkillInvocation } from '@shared/skills/parse-skill-invocation.ts'
import { buildSkillUserText } from '@shared/skills/build-skill-user-content.ts'
import type { ContextBreakdown, UserContent } from '@shared/types'
import type { AgentRunPayload, SkillSummary } from '@shared/types/skills.ts'
import { mountFooterModelPicker } from './footer-model-picker.ts'
import { mountFooterBranchStatus } from './footer-branch-status.ts'
import { createContextWheel } from './context-wheel.ts'
import { bindFooterCompactLayout } from './footer-compact.ts'
import { mountFooterOverflow } from './footer-overflow.ts'
import { downloadThreadJsonl, threadHasExportableContent } from '../export-thread.ts'
import { formatFooterUsageSummary, resolveFooterUsage } from '@shared/usage/footer-usage-summary.ts'
import { type ExtraPricing } from '@shared/llm/estimate-cost.ts'
import { extraProviderPricingMap } from '@shared/llm/extra-providers.ts'
import { DEFAULT_CLOUD_MODEL } from '@shared/llm/model-catalog.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'
import { showErrorToast, showToast } from './toast.ts'
import { createComposerDraftAutosave } from './composer-draft-autosave.ts'

export function mountInputBar(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const chips = el('div', { class: 'attachment-chips' })
  const textarea = el('textarea', {
    class: 'prompt-input',
    rows: '3',
    'aria-label': 'Message',
    placeholder: 'Message…',
  })
  const submitBtn = el('button', { class: 'submit-btn', type: 'button' }, 'Send')
  const stopBtn = el(
    'button',
    { class: 'stop-btn', type: 'button', hidden: '', 'aria-label': 'Stop agent' },
    'Stop',
  )
  // Hidden native file picker driven by the paperclip button — gives an
  // explicit "browse" affordance alongside drag-and-drop and @-mentions.
  const fileInput = el('input', {
    class: 'attach-file-input',
    type: 'file',
    multiple: '',
    hidden: '',
    'aria-hidden': 'true',
    tabindex: '-1',
  })
  const attachBtn = el(
    'button',
    { class: 'attach-btn', type: 'button', 'aria-label': 'Attach files', title: 'Attach files' },
    outlineIcon(
      'attach',
      [
        'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
      ],
      'attach-btn-icon',
    ),
  )
  // The Send button is positioned relative to this row (not the whole input
  // bar), so it sits inside the textarea box and never overlaps the footer.
  const inputRow = el(
    'div',
    { class: 'input-row' },
    textarea,
    attachBtn,
    fileInput,
    stopBtn,
    submitBtn,
  )
  const branchWarningText = el('span', { class: 'composer-branch-warning-text' })
  const checkoutBranchBtn = el(
    'button',
    { type: 'button', class: 'composer-branch-checkout-btn' },
    'Check out',
  )
  const branchWarning = el(
    'div',
    { class: 'composer-branch-warning', role: 'status', 'aria-live': 'polite', hidden: '' },
    el('span', { class: 'composer-branch-warning-icon', 'aria-hidden': 'true' }, '!'),
    branchWarningText,
    checkoutBranchBtn,
  )
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
  const queueIndicator = el('span', { class: 'footer-queue', hidden: '', 'aria-live': 'polite' })
  const contextWheel = createContextWheel()
  usageGroup.append(contextWheel.root, queueIndicator, usageBtn)
  footer.append(modelHost, branchHost, exportBtn)
  const footerOverflow = mountFooterOverflow(footer, [
    {
      label: 'Export',
      hidden: (): boolean => !threadHasExportableContent(getActiveThread(store)),
      onClick: (): void => {
        const thread = getActiveThread(store)
        if (threadHasExportableContent(thread)) downloadThreadJsonl(thread)
      },
    },
  ])
  footer.append(usageGroup)
  const footerCompact = bindFooterCompactLayout(footer, () => {
    updateFooter()
  })
  let costVisible = false

  const modelPicker = mountFooterModelPicker(
    modelHost,
    api,
    () => store.getState().settings?.model ?? DEFAULT_CLOUD_MODEL,
    (model) => {
      void api.settings.set('model', model)
      store.setState({ settings: { ...store.getState().settings, model } })
      updateFooter()
    },
  )
  const branchControl = mountFooterBranchStatus(branchHost, store, api)

  exportBtn.addEventListener('click', () => {
    const thread = getActiveThread(store)
    if (threadHasExportableContent(thread)) downloadThreadJsonl(thread)
  })
  usageBtn.addEventListener('click', () => {
    costVisible = !costVisible
    updateFooter()
  })
  contextWheel.root.addEventListener('click', () => {
    if (!footerCompact.isCompact() || contextWheel.root.hidden || !usageSummaryText()) return
    costVisible = !costVisible
    updateFooter()
  })

  root.append(chips, branchWarning, inputRow, footer)

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
  let mismatchBranch: string | null = null
  let checkoutInProgress = false
  let lastBreakdown: ContextBreakdown | null = null
  // Pricing for extra-provider models (e.g. HF), keyed by `<slug>:<id>` selection.
  // The static cloud catalog has no entry for these, so the footer cost reads here.
  let extraPricing: ExtraPricing = {}
  function refreshExtraPricing(): void {
    // Best-effort: a missing/failed provider list just leaves the footer cost
    // resting on the static cloud catalog, so never let it throw.
    try {
      void api.settings
        .extraProviders()
        .then((providers) => {
          extraPricing = extraProviderPricingMap(providers)
          updateFooter()
        })
        .catch(() => {})
    } catch {
      /* ignore */
    }
  }

  function getActiveThreadId(): string | null {
    return store.getState().activeThreadId
  }
  function isRunning(): boolean {
    const t = getActiveThread(store)
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
    const thread = getThreadById(store, id)
    textarea.value = thread?.draftPrompt ?? ''
    activeComposerThreadId = id
    // New thread → drop the prior thread's estimate and recompute for this one.
    lastBreakdown = null
    scheduleContextEstimate(0)
  }

  const draftAutosave = createComposerDraftAutosave({
    getActiveThreadId,
    getValue: () => textarea.value,
    save: (id, value) => {
      setThreadDraftPrompt(store, id, value)
    },
  })
  textarea.addEventListener('input', () => {
    scheduleContextEstimate()
    draftAutosave.schedule()
  })

  function updateState(): void {
    const running = isRunning()
    stopBtn.hidden = !running
    submitBtn.classList.toggle('with-stop', running)
    textarea.classList.toggle('with-stop', running)
  }

  function showBranchMismatch(branch: string): void {
    mismatchBranch = branch
    textarea.setCustomValidity('')
    branchWarning.hidden = false
    branchWarningText.textContent = threadGitBranchMismatchMessage(branch)
    branchWarningText.title = threadGitBranchMismatchMessage(branch)
    checkoutBranchBtn.disabled = checkoutInProgress
    checkoutBranchBtn.textContent = checkoutInProgress ? 'Checking out...' : 'Check out'
  }

  function hideBranchMismatch(): void {
    mismatchBranch = null
    checkoutInProgress = false
    branchWarning.hidden = true
    branchWarningText.title = ''
    checkoutBranchBtn.disabled = false
    checkoutBranchBtn.textContent = 'Check out'
  }

  function updateQueueIndicator(): void {
    const thread = store.getState().threads.find((t) => t.id === getActiveThreadId())
    const count = thread?.pendingMessages?.length ?? 0
    if (count === 0) {
      queueIndicator.hidden = true
      queueIndicator.textContent = ''
      return
    }
    queueIndicator.hidden = false
    queueIndicator.textContent = count === 1 ? '1 queued' : `${String(count)} queued`
  }

  function usageSummaryText(): string | null {
    const model = store.getState().settings?.model ?? DEFAULT_CLOUD_MODEL
    const thread = getActiveThread(store)
    if (!thread) return null
    const display = resolveFooterUsage({
      measured: thread.usage,
      running: thread.status === 'running',
      messages: thread.messages,
      contextSnapshot: thread.contextSnapshot,
      breakdown: lastBreakdown,
    })
    if (!display) return null
    return formatFooterUsageSummary(display, {
      costVisible,
      model,
      measuredUsage: thread.usage,
      extra: extraPricing,
    })
  }

  function updateFooter(): void {
    const thread = getActiveThread(store)
    const running = thread?.status === 'running'
    const usageText = usageSummaryText()
    const compact = footerCompact.isCompact()
    const snapshot = thread?.contextSnapshot
    const snapshotVisible =
      !!snapshot && snapshot.conversationBudget > 0 && (running || snapshot.fillRatio > 0.01)
    const snapshotUsable =
      !!snapshot && snapshot.conversationBudget > 0 && snapshot.fillRatio > 0.01
    const draftNonEmpty =
      textarea.value.trim().length > 0 ||
      attachedFiles.length > 0 ||
      attachedTextBlocks.length > 0 ||
      attachedImages.length > 0
    // Show the pre-send breakdown while composing (or on fresh threads with no live
    // snapshot); keep the measured live snapshot once a run has produced one.
    const showBreakdown =
      !running &&
      !!lastBreakdown &&
      lastBreakdown.totalTokens > 0 &&
      (!snapshotUsable || draftNonEmpty)
    const tuckUsageIntoWheel = compact && !showBreakdown && snapshotVisible
    // Always forward the estimated breakdown so already-run primary chats keep
    // the context-window breakdown on hover; `breakdownRing` controls whether it
    // also replaces the live snapshot fill (pre-send / fresh threads). While the
    // agent is running we suppress it — the live snapshot is the authoritative
    // source then, and subagent/remote windows never produce a breakdown here.
    const hoverBreakdown = !running ? lastBreakdown : null
    contextWheel.update(snapshot, running, {
      usageLine: tuckUsageIntoWheel ? usageText : null,
      breakdown: hoverBreakdown,
      breakdownRing: showBreakdown,
    })
    contextWheel.root.classList.toggle('is-interactive', tuckUsageIntoWheel)
    if (!usageText) {
      usageBtn.hidden = true
    } else {
      usageBtn.hidden = tuckUsageIntoWheel
      usageBtn.textContent = usageText
    }
    exportBtn.hidden = !threadHasExportableContent(thread)
    footerOverflow.update()
    updateState()
    updateQueueIndicator()
  }

  let estimateTimer: ReturnType<typeof setTimeout> | null = null
  let estimateSeq = 0
  let estimateEnabled = true

  function stopContextEstimates(): void {
    estimateEnabled = false
    estimateSeq++
    if (estimateTimer !== null) {
      clearTimeout(estimateTimer)
      estimateTimer = null
    }
  }

  function composeEstimatePayload(): string {
    const rawText = textarea.value.trim()
    const skillNames = (skillsCache ?? []).map((skill) => skill.name)
    const invocation = resolveSkillInvocation(rawText, skillNames)
    const invokedSkills =
      invocation && (skillsCache ?? []).some((skill) => skill.name === invocation.skillName)
        ? [invocation.skillName]
        : []
    const draftText = buildTextWithAttachments(rawText, attachedFiles, attachedTextBlocks)
    return JSON.stringify({ draftText, invokedSkills, imageCount: attachedImages.length })
  }

  async function runContextEstimate(): Promise<void> {
    if (!estimateEnabled) return
    const id = getActiveThreadId()
    if (!id) {
      if (lastBreakdown !== null) {
        lastBreakdown = null
        updateFooter()
      }
      return
    }
    const seq = ++estimateSeq
    const payload = composeEstimatePayload()
    let breakdown: ContextBreakdown
    try {
      breakdown = await api.agent.estimateContext(id, payload)
    } catch {
      return
    }
    // Drop results that arrived after a newer request or a thread switch.
    if (seq !== estimateSeq || getActiveThreadId() !== id) return
    lastBreakdown = breakdown
    updateFooter()
  }

  function scheduleContextEstimate(delay = 300): void {
    if (!estimateEnabled) return
    if (estimateTimer !== null) clearTimeout(estimateTimer)
    estimateTimer = setTimeout(() => {
      estimateTimer = null
      void runContextEstimate()
    }, delay)
  }

  submitBtn.addEventListener('click', () => {
    void submit()
  })

  stopBtn.addEventListener('click', () => {
    const id = getActiveThreadId()
    if (id) void api.agent.abort(id)
  })

  checkoutBranchBtn.addEventListener('click', () => {
    if (!mismatchBranch || checkoutInProgress) return
    const branch = mismatchBranch
    checkoutInProgress = true
    showBranchMismatch(branch)

    void api.git
      .checkoutBranch(branch)
      .then(() => {
        hideBranchMismatch()
        showToast(`Checked out ${branch}`)
        store.emit('git_branch_changed')
      })
      .catch((error: unknown) => {
        checkoutInProgress = false
        showBranchMismatch(branch)
        showErrorToast(`Failed to check out ${branch}`, error)
      })
  })

  function isAutocompletePickerOpen(): boolean {
    return root.querySelector('.mention-picker:not([hidden])') !== null
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key !== 'Enter' || e.shiftKey) return
    if (isAutocompletePickerOpen()) return
    e.preventDefault()
    void submit()
  })

  // Guards against re-entrant submits. The agent dispatch path has async gaps
  // (`api.git.branchStatus()`, `api.skills.list()`) between reading the
  // textarea and clearing it, so without this a laggy renderer that queues up
  // several keydown/click events could fire multiple `void submit()` calls that
  // each read the same un-cleared text and send the message more than once.
  let submitInProgress = false

  async function submit(): Promise<void> {
    if (submitInProgress) return
    submitInProgress = true
    try {
      await performSubmit()
    } finally {
      submitInProgress = false
    }
  }

  async function performSubmit(): Promise<void> {
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
    const thread = getThreadById(store, id)
    const threadBranch = thread?.gitBranch
    if (threadBranch && threadGitBranchMismatch(threadBranch, currentBranch)) {
      showBranchMismatch(threadBranch)
      return
    }
    hideBranchMismatch()

    const skills = skillsCache ?? (await api.skills.list())
    skillsCache = skills
    const skillNames = skills.map((skill) => skill.name)
    const invocation = resolveSkillInvocation(rawText, skillNames)
    const invokedSkills = invocation ? [invocation.skillName] : []

    const invokedSkill = invocation
      ? skills.find((skill) => skill.name === invocation.skillName)
      : undefined

    if (invocation && !invokedSkill) {
      textarea.setCustomValidity(`Unknown skill: /${invocation.skillName}`)
      textarea.reportValidity()
      return
    }

    // Warn up front when the invoked skill points the agent at external hosts.
    // The setting defaults on, so only an explicit `false` suppresses it.
    if (invokedSkill && invokedSkill.externalLinks.length > 0) {
      const warnEnabled = (await api.settings.get('skillExternalLinkWarnings')) !== false
      if (warnEnabled) {
        showToast(
          `/${invokedSkill.name} references external links: ${invokedSkill.externalLinks.join(', ')}. ` +
            `The agent will ask before fetching, installing, or running code from them.`,
          { variant: 'error', durationMs: 10000 },
        )
      }
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
    const messageId = addMessage(
      store,
      id,
      'user',
      displayParts.join('\n'),
      imageUrls.length ? imageUrls : undefined,
    )
    if (currentBranch) bindThreadGitBranchIfUnset(store, id, currentBranch)

    if (isRunning()) {
      enqueueUserMessage(store, id, {
        messageId,
        payload,
        createdAt: Date.now(),
      })
    } else {
      dispatchAgentRun(store, api, id, payload)
    }
    textarea.value = ''
    setThreadDraftPrompt(store, id, '')
    attachedFiles = []
    attachedTextBlocks = []
    attachedImages = []
    clear(chips)
    scheduleContextEstimate(0)
  }

  function addChip(file: { path: string; content: string }): void {
    attachedFiles.push(file)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip'
    chip.textContent = file.path.split('/').pop() ?? file.path
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedFiles = attachedFiles.filter((f) => f.path !== file.path)
      chip.remove()
      scheduleContextEstimate()
    })
    chip.append(remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  function addTextChip(content: string, explicitLabel?: string): void {
    const id = crypto.randomUUID()
    const label = explicitLabel ?? textBlockLabel(content)
    attachedTextBlocks.push({ id, label, content })
    const chip = document.createElement('span')
    chip.className = 'attachment-chip text-chip'
    chip.textContent = label
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedTextBlocks = attachedTextBlocks.filter((b) => b.id !== id)
      chip.remove()
      scheduleContextEstimate()
    })
    chip.append(remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  function addImageChip(dataUrl: string, mimeType: string): void {
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
      scheduleContextEstimate()
    })
    chip.append(thumb, remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = (): void => {
        res(r.result as string)
      }
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

  attachBtn.addEventListener('click', () => {
    fileInput.click()
  })
  const onFileInputChange = (): void => {
    const files = Array.from(fileInput.files ?? [])
    if (files.length === 0) return
    void attachFiles(files, attachmentHandlers, api, store.getState().workspaceRoot)
    // Reset so re-selecting the same file fires `change` again.
    fileInput.value = ''
  }
  fileInput.addEventListener('change', onFileInputChange)

  const onPaste = (e: ClipboardEvent): void => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const img = items.find((i) => i.type.startsWith('image/'))
    if (img) {
      e.preventDefault()
      const blob = img.getAsFile()
      if (!blob) return
      void readAsDataUrl(blob).then((dataUrl) => {
        addImageChip(dataUrl, blob.type)
      })
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
    void api.skills.list().then(
      (skills) => {
        skillsCache = skills
      },
      () => {
        skillsCache = []
      },
    )
  }
  refreshSkillsCache()
  // Skills are workspace-scoped; drop the stale list when the workspace changes
  // so inline /skill detection and validation use the new workspace's skills.
  const onSkillsChanged = (): void => {
    skillsCache = null
    refreshSkillsCache()
    scheduleContextEstimate(0)
  }
  const unsubWorkspace = store.on('workspace_changed', onSkillsChanged)
  window.addEventListener('copse:skills-changed', onSkillsChanged)

  const skillPicker = initSkillPicker({
    textarea,
    inputBar: root,
    listSkills: () => api.skills.list(),
  })

  const unsubs = [
    api.agent.onRefreshContextEstimate(() => {
      scheduleContextEstimate(0)
    }),
    store.on('new_thread_opened', () => {
      // Refresh provider-reported context windows for the new chat, then re-estimate
      // once the caches are cleared so the footer reflects the current model limit.
      void api.agent.refreshModelContext().finally(() => {
        scheduleContextEstimate(0)
      })
    }),
    store.on('composer_draft_flush', persistComposerDraft),
    store.on('thread_status_changed', (tid) => {
      if (tid === getActiveThreadId()) {
        updateFooter()
        // A finished run changes the persisted history; refresh the estimate.
        scheduleContextEstimate(0)
      }
    }),
    store.on('message_queued', (tid) => {
      if (tid === getActiveThreadId()) updateQueueIndicator()
    }),
    store.on('message_added', (tid) => {
      if (tid === getActiveThreadId()) updateFooter()
    }),
    store.on('threads_changed', () => {
      syncComposerThread()
      hideBranchMismatch()
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
      // An added/edited provider (e.g. a freshly fetched HF list) changes pricing.
      refreshExtraPricing()
      updateFooter()
      // Model / subagent changes alter the context window and tool set.
      scheduleContextEstimate(0)
    }),
    store.on('workspace_changed', () => {
      branchControl.refresh()
    }),
    store.on('git_branch_changed', () => {
      branchControl.refresh()
    }),
  ]

  const observer = new MutationObserver(() => {
    const hasSuggestions = !followUps.root.hidden
    textarea.placeholder = hasSuggestions ? followUpPlaceholder : defaultPlaceholder
  })
  observer.observe(followUps.root, { attributes: true, attributeFilter: ['hidden'] })

  updateFooter()
  refreshExtraPricing()
  syncComposerThread()
  scheduleContextEstimate(0)
  window.addEventListener('beforeunload', stopContextEstimates)
  return () => {
    window.removeEventListener('beforeunload', stopContextEstimates)
    stopContextEstimates()
    draftAutosave.cancel()
    if (activeComposerThreadId) {
      setThreadDraftPrompt(store, activeComposerThreadId, textarea.value)
    }
    unsubs.forEach((u) => {
      u()
    })
    unsubWorkspace()
    window.removeEventListener('copse:skills-changed', onSkillsChanged)
    document.removeEventListener('paste', onPaste)
    observer.disconnect()
    followUps.destroy()
    unbindDrop()
    unregisterAttachments()
    modelPicker.destroy()
    footerOverflow.destroy()
    footerCompact.destroy()
    branchControl.destroy()
    skillPicker()
  }
}
