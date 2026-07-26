import { el, clear } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  setThreadWorkingBrief,
  bindThreadGitBranchIfUnset,
  recordThreadVideos,
  applyPreparedThreadCheckout,
  getThreadById,
  getActiveThread,
  setThreadDraftPrompt,
} from '@shared/store/thread-helpers.ts'
import {
  dispatchAgentRun,
  enqueueUserMessage,
  startHumanTurnTree,
} from '../controller/message-queue.ts'
import { nextWorkingBrief } from '@copse/agent/working-brief.ts'
import {
  buildTextWithAttachments,
  isTextBlockAttachment,
  type ThreadRefAttachment,
  type VideoRefAttachment,
} from '@copse/agent/build-text-with-attachments.ts'
import { mountComposerEditor } from './composer-editor.ts'
import {
  registerPromptAttachments,
  type PromptVideoAttachment,
} from '../attachments/prompt-attachments.ts'
import { bindFileDropTarget, attachFiles } from '../attachments/handle-file-drop.ts'
import {
  initMentionPicker,
  relativeDate,
  shellIcon,
  threadIcon,
  type AttachedShellRef,
  type AttachedThreadRef,
} from './mention-picker.ts'
import { initSkillPicker } from './skill-picker.ts'
import { mountFooterIndexStatus } from './footer-index-status.ts'
import { resolveSkillInvocation } from '@shared/skills/parse-skill-invocation.ts'
import { buildSkillUserText } from '@shared/skills/build-skill-user-content.ts'
import type { ContextBreakdown, TranscriptAttachment, UserContent } from '@shared/types'
import type { AgentRunPayload, SkillSummary } from '@shared/types/skills.ts'
import { mountFooterModelPicker } from './footer-model-picker.ts'
import { mountFooterBranchStatus } from './footer-branch-status.ts'
import { createContextWheel } from './context-wheel.ts'
import { bindFooterCompactLayout } from './footer-compact.ts'
import { mountFooterOverflow } from './footer-overflow.ts'
import { downloadThreadJsonl, threadHasExportableContent } from '../export-thread.ts'
import { buildShareTraceIssueUrl } from '@shared/github/share-trace-issue.ts'
import { formatFooterUsageSummary, resolveFooterUsage } from '@shared/usage/footer-usage-summary.ts'
import { type ExtraPricing } from '@copse/llm/estimate-cost.ts'
import { extraProviderPricingMap } from '@copse/llm/extra-providers.ts'
import {
  DEFAULT_APP_CHAT_MODEL,
  FALLBACK_APP_CHAT_MODEL,
  isBestValueChatModel,
} from '@shared/lm-studio-defaults.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'
import { syncThreadGitBranchIfChanged } from '@shared/git/sync-thread-branch.ts'
import { showErrorToast, showToast } from './toast.ts'
import { formatByteSize, type VideoAttachmentRef } from '@shared/video/video-media.ts'
import { createComposerDraftAutosave } from './composer-draft-autosave.ts'
import { mountPanelModeControls } from './panel-mode-controls.ts'
import type { ThreadWorktreeChoice } from '@shared/types/worktree.ts'
import { mountGuardedYoloControl } from './guarded-yolo-control.ts'

interface MountInputBarOptions {
  /**
   * Dock the portrait panel tabs to the chat/panel seam instead of making them
   * part of the floating composer card. Tests that mount the input in isolation
   * can omit this and keep all generated UI under their fixture root.
   */
  portraitPanelHost?: HTMLElement
}

export function mountInputBar(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  opts: MountInputBarOptions = {},
): { handleStopShortcut: (key: 'Escape' | 'Enter') => boolean; unmount: () => void } {
  const chips = el('div', { class: 'attachment-chips' })
  const composer = mountComposerEditor()
  composer.setPlaceholder('Message…')
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
    composer.el,
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
  // The guard is advisory: alongside checking the bound branch back out, the
  // user can rebind the thread to whatever is checked out now and keep going.
  const continueBranchBtn = el(
    'button',
    { type: 'button', class: 'composer-branch-continue-btn' },
    'Continue here',
  )
  const branchWarning = el(
    'div',
    { class: 'composer-branch-warning', role: 'status', 'aria-live': 'polite', hidden: '' },
    el('span', { class: 'composer-branch-warning-icon', 'aria-hidden': 'true' }, '!'),
    branchWarningText,
    checkoutBranchBtn,
    continueBranchBtn,
  )
  let footerOverflow: ReturnType<typeof mountFooterOverflow> | null = null
  const guardedYolo = mountGuardedYoloControl(api, getActiveThreadId, () => {
    footerOverflow?.update()
  })
  const footer = el('div', { class: 'input-footer' })
  const modelHost = el('div', { class: 'footer-model-host' })
  const checkoutHost = el('div', { class: 'footer-checkout-host' })
  const checkoutBtn = el('button', {
    type: 'button',
    class: 'footer-checkout-btn',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  })
  const checkoutMenu = el('div', { class: 'footer-checkout-menu', role: 'menu', hidden: '' })
  const sharedCheckoutBtn = el(
    'button',
    { type: 'button', role: 'menuitem', 'data-checkout-choice': 'shared' },
    'Shared checkout',
  )
  const isolatedCheckoutBtn = el(
    'button',
    { type: 'button', role: 'menuitem', 'data-checkout-choice': 'worktree' },
    'Isolated worktree',
  )
  checkoutMenu.append(sharedCheckoutBtn, isolatedCheckoutBtn)
  checkoutHost.append(checkoutBtn, checkoutMenu)
  const branchHost = el('div', { class: 'footer-branch-host' })
  // Token usage — always shown once a thread has used tokens; click to expand
  // into the in/out breakdown and cost.
  const usageBtn = el('button', { class: 'footer-usage', 'aria-label': 'Toggle cost details' })
  const usageGroup = el('div', { class: 'footer-usage-group' })
  const queueIndicator = el('span', { class: 'footer-queue', hidden: '', 'aria-live': 'polite' })
  const contextWheel = createContextWheel()
  // Appends its chip first, so it sits left of the wheel/queue/usage widgets.
  const indexStatusChip = mountFooterIndexStatus(usageGroup, api)
  usageGroup.append(contextWheel.root, queueIndicator, usageBtn)
  footer.append(modelHost, checkoutHost, branchHost)
  footerOverflow = mountFooterOverflow(footer, [
    {
      label: guardedYolo.menuLabel,
      hidden: (): boolean => !getActiveThreadId(),
      onClick: guardedYolo.toggle,
    },
    {
      label: 'Copy thread ID',
      hidden: (): boolean => !getActiveThreadId(),
      onClick: copyThreadId,
    },
    {
      label: 'Export conversation (JSONL)',
      hidden: (): boolean => !threadHasExportableContent(getActiveThread(store)),
      onClick: (): void => {
        const thread = getActiveThread(store)
        if (threadHasExportableContent(thread)) downloadThreadJsonl(thread)
      },
    },
    {
      label: 'Share trace',
      hidden: (): boolean => !threadHasExportableContent(getActiveThread(store)),
      onClick: shareTrace,
    },
  ])
  footer.append(usageGroup)
  const footerCompact = bindFooterCompactLayout(footer, () => {
    updateFooter()
  })
  // Portrait / bottom-pinned chrome: a labeled panel-mode row docked to the
  // thread/panel seam so users can flip modes without climbing to the titlebar.
  // Hidden via CSS unless `.is-portrait-chrome`.
  const portraitPanelControls = mountPanelModeControls(store, api, {
    // Own class only — do not share `.titlebar-panel-controls` or titlebar e2e
    // / click selectors (`.titlebar-panel-controls [aria-label=…]`) collide.
    className: 'portrait-panel-bar',
    alwaysShowLabels: 'all',
    enableOverflow: true,
  })
  let costVisible = false

  /** Concrete model for footer chrome — never the Settings-only best-value sentinel. */
  function footerChatModel(): string {
    const thread = getActiveThread(store)
    const raw = thread?.model ?? store.getState().settings?.model ?? DEFAULT_APP_CHAT_MODEL
    return isBestValueChatModel(raw) ? FALLBACK_APP_CHAT_MODEL : raw
  }

  const modelPicker = mountFooterModelPicker(
    modelHost,
    api,
    footerChatModel,
    (model) => {
      const thread = getActiveThread(store)
      if (!thread) return
      // Best-value is Settings-only; the footer list never offers it. If a stale
      // value somehow arrives, ignore it — blank-thread resolution owns that mode.
      if (isBestValueChatModel(model)) return
      const threads = store
        .getState()
        .threads.map((t) => (t.id !== thread.id ? t : { ...t, model, updatedAt: Date.now() }))
      store.setState({ threads })
      modelPicker.refresh()
      updateFooter()
      // The context window depends on the model, so re-estimate the footer wheel
      // against the newly selected model rather than waiting for the next keystroke.
      void runContextEstimate()
      void refreshAutomaticCheckoutPreview()
    },
    {
      isSshWorkspace: (): boolean => {
        const { activeProjectId, projects } = store.getState()
        if (!activeProjectId) return false
        return Boolean(projects.find((p) => p.id === activeProjectId)?.sshHost)
      },
      onClose: (): void => {
        composer.focus()
      },
    },
  )
  // Re-sync the picker whenever the active thread changes (new thread,
  // thread switch, or thread deletion that shifts the active pointer), and when
  // the project changes so ACP options hide/show with SSH workspaces.
  store.on('threads_changed', () => {
    modelPicker.refresh()
    void refreshAutomaticCheckoutPreview()
  })
  store.on('projects_changed', () => {
    modelPicker.refresh()
    void refreshAutomaticCheckoutPreview()
  })
  const branchControl = mountFooterBranchStatus(branchHost, store, api)

  function copyThreadId(): void {
    const id = getActiveThreadId()
    if (!id) return
    void navigator.clipboard
      .writeText(id)
      .then(() => showToast('Copied thread ID', { durationMs: 1500 }))
      .catch((error: unknown) => {
        showErrorToast('Failed to copy thread ID', error)
      })
  }

  function shareTrace(): void {
    const thread = getActiveThread(store)
    if (!threadHasExportableContent(thread)) return
    downloadThreadJsonl(thread)
    void api.shell.openExternal(buildShareTraceIssueUrl(thread)).catch((error: unknown) => {
      showErrorToast('Share trace failed', error)
    })
  }
  usageBtn.addEventListener('click', () => {
    costVisible = !costVisible
    updateFooter()
  })
  contextWheel.root.addEventListener('click', () => {
    if (!footerCompact.isCompact() || contextWheel.root.hidden || !usageSummaryText()) return
    costVisible = !costVisible
    updateFooter()
  })

  const checkoutErrorText = el('span', { class: 'composer-checkout-error-text' })
  const checkoutRetryBtn = el(
    'button',
    { type: 'button', class: 'composer-checkout-retry-btn' },
    'Retry',
  )
  const checkoutError = el(
    'div',
    { class: 'composer-checkout-error', role: 'alert', hidden: '' },
    checkoutErrorText,
    checkoutRetryBtn,
  )
  root.append(chips, guardedYolo.element, branchWarning, checkoutError, inputRow, footer)
  const portraitPanelHost = opts.portraitPanelHost ?? root
  portraitPanelHost.append(portraitPanelControls.element)

  const followUps = mountFollowUpSuggestions(store, api, (prompt) => {
    composer.value = prompt
    void submit()
  })
  root.insertBefore(followUps.root, inputRow)
  const defaultPlaceholder = 'Message…'
  const followUpPlaceholder = 'Send follow-up'

  let attachedFiles: { path: string; content: string }[] = []
  let attachedImages: { dataUrl: string; mimeType: string }[] = []
  // Attached videos (screen recordings). Stored on disk and referenced by path —
  // the media never enters the prompt, so unlike images these cost no context.
  // The agent reads them through the `video_frames` tool.
  let attachedVideos: VideoAttachmentRef[] = []
  // `@`-referenced past threads (#644): the agent gets a path reference + steering
  // preamble, nothing inlined. Composer-only state, like file/image chips.
  let attachedThreads: AttachedThreadRef[] = []
  // `@shell` snapshots: scrollback inlined like a paste/file block.
  let attachedShells: AttachedShellRef[] = []
  const checkoutChoices = new Map<string, ThreadWorktreeChoice>()
  let checkoutPreparationInProgress = false
  let automaticCheckoutMode: 'shared' | 'worktree' = 'shared'
  let automaticCheckoutPreviewSeq = 0

  function checkoutChoice(threadId: string): ThreadWorktreeChoice {
    return checkoutChoices.get(threadId) ?? 'automatic'
  }

  function checkoutLabel(choice: ThreadWorktreeChoice): string {
    if (choice === 'worktree') return 'Isolated worktree'
    if (choice === 'shared') return 'Shared checkout'
    return automaticCheckoutMode === 'worktree' ? 'Isolated worktree' : 'Shared checkout'
  }

  async function refreshAutomaticCheckoutPreview(): Promise<void> {
    const seq = ++automaticCheckoutPreviewSeq
    const { activeProjectId } = store.getState()
    const model = footerChatModel()
    let next: 'shared' | 'worktree' = 'shared'
    if (activeProjectId) {
      try {
        const preview = await api.agent.previewCheckout(activeProjectId, 'automatic', model)
        next = preview.checkoutMode === 'worktree' ? 'worktree' : 'shared'
      } catch {
        // Main performs the authoritative check. Preview degrades to shared
        // when Git cannot be inspected rather than promising isolation.
      }
    }
    if (seq !== automaticCheckoutPreviewSeq) return
    automaticCheckoutMode = next
    updateCheckoutControl()
  }

  function updateCheckoutControl(): void {
    const thread = getActiveThread(store)
    if (!thread) {
      checkoutHost.hidden = true
      checkoutMenu.hidden = true
      checkoutBtn.setAttribute('aria-expanded', 'false')
      return
    }
    const hidden = thread.messages.length > 0 || Boolean(thread.worktreeChoice)
    checkoutHost.hidden = hidden
    if (hidden) {
      checkoutMenu.hidden = true
      checkoutBtn.setAttribute('aria-expanded', 'false')
      return
    }
    checkoutBtn.disabled = checkoutPreparationInProgress
    checkoutBtn.textContent = checkoutPreparationInProgress
      ? 'Preparing checkout…'
      : checkoutLabel(checkoutChoice(thread.id))
  }

  function hideCheckoutError(): void {
    checkoutError.hidden = true
    checkoutErrorText.textContent = ''
  }

  function checkoutErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Could not prepare the checkout'
    return message.replace(/^Error invoking remote method 'agent:prepareCheckout': Error:\s*/, '')
  }

  function selectCheckout(choice: ThreadWorktreeChoice): void {
    const id = getActiveThreadId()
    if (!id) return
    checkoutChoices.set(id, choice)
    checkoutMenu.hidden = true
    checkoutBtn.setAttribute('aria-expanded', 'false')
    hideCheckoutError()
    updateCheckoutControl()
    composer.focus()
  }

  const currentThreadRefs = (): ThreadRefAttachment[] =>
    attachedThreads.map((t) => ({
      title: t.title || 'Untitled thread',
      date: relativeDate(t.updatedAt),
      spinePath: t.spinePath,
    }))

  const currentShellBlocks = (): { label: string; content: string }[] =>
    attachedShells.map((s) => ({
      label: `Shell: ${s.label}`,
      content: s.content,
    }))

  const currentVideoRefs = (): VideoRefAttachment[] =>
    attachedVideos.map((v) => ({
      path: v.path,
      name: v.name,
      size: formatByteSize(v.sizeBytes),
    }))
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

  // Drafts persist the *expanded* text: a chip's content survives a thread
  // switch or restart as plain text (the chip itself is composer-only state).
  function persistComposerDraft(): void {
    const id = activeComposerThreadId
    if (!id) return
    setThreadDraftPrompt(store, id, composer.expandedValue())
  }

  function syncComposerThread(): void {
    const id = getActiveThreadId()
    if (id === activeComposerThreadId) return
    if (activeComposerThreadId) {
      setThreadDraftPrompt(store, activeComposerThreadId, composer.expandedValue())
    }
    const thread = getThreadById(store, id)
    composer.value = thread?.draftPrompt ?? ''
    activeComposerThreadId = id
    hideCheckoutError()
    // New thread → drop the prior thread's estimate and recompute for this one.
    lastBreakdown = null
    scheduleContextEstimate(0)
  }

  const draftAutosave = createComposerDraftAutosave({
    getActiveThreadId,
    getValue: () => composer.expandedValue(),
    save: (id, value) => {
      setThreadDraftPrompt(store, id, value)
    },
  })
  composer.el.addEventListener('input', () => {
    scheduleContextEstimate()
    draftAutosave.schedule()
  })

  let stopPendingThreadId: string | null = null

  function clearStopPending(): void {
    stopPendingThreadId = null
    stopBtn.classList.remove('stop-pending')
  }

  function updateState(): void {
    const running = isRunning()
    stopBtn.hidden = !running
    submitBtn.classList.toggle('with-stop', running)
    composer.el.classList.toggle('with-stop', running)
    if (!running || stopPendingThreadId !== getActiveThreadId()) clearStopPending()
  }

  const handleStopShortcut = (key: 'Escape' | 'Enter'): boolean => {
    const id = getActiveThreadId()
    const thread = getActiveThread(store)
    if (!id || thread?.status !== 'running') {
      clearStopPending()
      return false
    }

    if (stopPendingThreadId === id) {
      clearStopPending()
      void api.agent.abort(id)
      return true
    }

    if (key === 'Escape') {
      stopPendingThreadId = id
      stopBtn.classList.add('stop-pending')
      return true
    }

    return false
  }

  function showBranchMismatch(branch: string): void {
    mismatchBranch = branch
    branchWarning.hidden = false
    branchWarningText.textContent = threadGitBranchMismatchMessage(branch)
    branchWarningText.title = threadGitBranchMismatchMessage(branch)
    checkoutBranchBtn.disabled = checkoutInProgress
    checkoutBranchBtn.textContent = checkoutInProgress ? 'Checking out...' : 'Check out'
    continueBranchBtn.disabled = checkoutInProgress
  }

  function hideBranchMismatch(): void {
    mismatchBranch = null
    checkoutInProgress = false
    branchWarning.hidden = true
    branchWarningText.title = ''
    checkoutBranchBtn.disabled = false
    checkoutBranchBtn.textContent = 'Check out'
    continueBranchBtn.disabled = false
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
    const thread = getActiveThread(store)
    if (!thread) return null
    // Price against the concrete footer model so cost matches what the run uses.
    const model = footerChatModel()
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
      composer.value.trim().length > 0 ||
      attachedFiles.length > 0 ||
      attachedImages.length > 0 ||
      attachedVideos.length > 0 ||
      attachedThreads.length > 0 ||
      attachedShells.length > 0
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
    footerOverflow?.update()
    updateCheckoutControl()
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
    // Expanded so inline paste chips weigh their full content, not one char.
    const rawText = composer.expandedValue().trim()
    const skillNames = (skillsCache ?? []).map((skill) => skill.name)
    const invocation = resolveSkillInvocation(rawText, skillNames)
    const invokedSkills =
      invocation && (skillsCache ?? []).some((skill) => skill.name === invocation.skillName)
        ? [invocation.skillName]
        : []
    const draftText = buildTextWithAttachments(rawText, attachedFiles, currentShellBlocks(), {
      threadRefs: currentThreadRefs(),
      videoRefs: currentVideoRefs(),
    })
    const model = getActiveThread(store)?.model
    return JSON.stringify({
      draftText,
      invokedSkills,
      imageCount: attachedImages.length,
      ...(model !== undefined ? { model } : {}),
    })
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
    const projectId = store.getState().activeProjectId
    if (!projectId) return
    const seq = ++estimateSeq
    const payload = composeEstimatePayload()
    let breakdown: ContextBreakdown
    try {
      breakdown = await api.agent.estimateContext(projectId, id, payload)
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

  checkoutBtn.addEventListener('click', () => {
    if (checkoutPreparationInProgress) return
    checkoutMenu.hidden = !checkoutMenu.hidden
    checkoutBtn.setAttribute('aria-expanded', String(!checkoutMenu.hidden))
  })
  sharedCheckoutBtn.addEventListener('click', () => {
    selectCheckout('shared')
  })
  isolatedCheckoutBtn.addEventListener('click', () => {
    selectCheckout('worktree')
  })
  checkoutRetryBtn.addEventListener('click', () => {
    void submit()
  })
  const closeCheckoutMenu = (event: MouseEvent): void => {
    if (checkoutMenu.hidden || checkoutHost.contains(event.target as Node)) return
    checkoutMenu.hidden = true
    checkoutBtn.setAttribute('aria-expanded', 'false')
  }
  document.addEventListener('click', closeCheckoutMenu)

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

  // Rebind the thread to the checked-out branch and send the message that was
  // held back by the mismatch guard. Re-reads HEAD rather than trusting the
  // branch we warned about — the user may have switched again since.
  continueBranchBtn.addEventListener('click', () => {
    if (!mismatchBranch || checkoutInProgress) return
    const id = getActiveThreadId()
    if (!id) return
    void api.git
      .branchStatus()
      .then(({ currentBranch }) => {
        if (syncThreadGitBranchIfChanged(store, id, currentBranch)) {
          store.emit('git_branch_changed')
        }
        hideBranchMismatch()
        void submit()
      })
      .catch((error: unknown) => {
        showErrorToast('Failed to read the current branch', error)
      })
  })

  function isAutocompletePickerOpen(): boolean {
    return root.querySelector('.mention-picker:not([hidden])') !== null
  }

  // Complete a pending stop before the composer sees Enter. The first Escape
  // continues to the document shortcut handler, which gives dialogs priority.
  root.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing || stopPendingThreadId === null) return
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      if (handleStopShortcut(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    true,
  )

  composer.el.addEventListener('keydown', (e) => {
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
    composer.setPlaceholder(defaultPlaceholder)
    // Visible text keeps chips as single placeholder chars (for the transcript
    // display); the expanded text inlines each chip's fenced block in place and
    // is what actually gets sent.
    const visibleText = composer.value.trim()
    const rawText = composer.expandedValue().trim()
    if (
      !rawText &&
      attachedFiles.length === 0 &&
      attachedImages.length === 0 &&
      attachedVideos.length === 0 &&
      attachedThreads.length === 0 &&
      attachedShells.length === 0
    )
      return
    const id = getActiveThreadId()
    if (!id) return

    const branchStatus = await api.git.branchStatus()
    const currentBranch = branchStatus.currentBranch
    const thread = getThreadById(store, id)
    const threadBranch = thread?.gitBranch
    const isolatedWorktree = thread !== undefined && thread.worktree !== undefined
    // Worktree threads keep the project checkout on its original branch; the
    // bound `gitBranch` names the isolated checkout, not a required HEAD move.
    if (
      threadBranch &&
      threadGitBranchMismatch(threadBranch, currentBranch, { isolatedWorktree })
    ) {
      showBranchMismatch(threadBranch)
      return
    }
    hideBranchMismatch()

    // Always re-fetch on submit. The slash picker calls `api.skills.list()` on
    // its own and can show a skill (e.g. built-in `/checkup`) while
    // `skillsCache` is still stale — including `[]` from an earlier empty/failed
    // load, which is truthy and would skip the `??` refetch. Authorizing an
    // invocation against a lagging cache surfaces a false "Unknown skill" toast.
    const skills = await api.skills.list()
    skillsCache = skills
    const skillNames = skills.map((skill) => skill.name)
    const invocation = resolveSkillInvocation(rawText, skillNames)
    const invokedSkills = invocation ? [invocation.skillName] : []

    const invokedSkill = invocation
      ? skills.find((skill) => skill.name === invocation.skillName)
      : undefined

    if (invocation && !invokedSkill) {
      showToast(`Unknown skill: /${invocation.skillName}`, { variant: 'error' })
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
          attachedFiles.length > 0 || attachedImages.length > 0 || attachedVideos.length > 0,
        )
      : rawText

    let fullContent: UserContent
    if (attachedImages.length > 0) {
      fullContent = [
        ...attachedImages.map((img) => ({ type: 'image' as const, dataUrl: img.dataUrl })),
        {
          type: 'text' as const,
          text: buildTextWithAttachments(text, attachedFiles, currentShellBlocks(), {
            threadRefs: currentThreadRefs(),
            videoRefs: currentVideoRefs(),
          }),
        },
      ]
    } else {
      fullContent = buildTextWithAttachments(text, attachedFiles, currentShellBlocks(), {
        threadRefs: currentThreadRefs(),
        videoRefs: currentVideoRefs(),
      })
    }

    // Blank threads commit their checkout decision in main before the renderer
    // records or clears the first message. Allocation/persistence failures are
    // therefore retryable without losing or accidentally dispatching the prompt.
    if (thread && thread.messages.length === 0 && !thread.worktreeChoice) {
      const projectId = store.getState().activeProjectId
      if (!projectId) return
      hideCheckoutError()
      checkoutPreparationInProgress = true
      updateCheckoutControl()
      try {
        const prepared = await api.agent.prepareCheckout(
          projectId,
          id,
          rawText,
          checkoutChoice(id),
          thread.model ?? store.getState().settings?.model,
        )
        applyPreparedThreadCheckout(store, id, prepared)
        // The user may switch threads while Git is preparing the checkout. The
        // decision remains durable, but their prompt must stay with its composer.
        if (getActiveThreadId() !== id) return
      } catch (error) {
        checkoutErrorText.textContent = checkoutErrorMessage(error)
        checkoutError.hidden = false
        return
      } finally {
        checkoutPreparationInProgress = false
        updateCheckoutControl()
      }
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
    // The transcript keeps the typed text verbatim — each inline paste stays as
    // its U+FFFC placeholder (composer-editor.ts) — while the chip labels and
    // file/thread refs travel as structured attachments. This keeps the stored/
    // exported content free of glyphs or markers, and lets the renderer draw each
    // as an SVG-icon chip: pastes inline at their placeholder, files/threads in a
    // trailing row. Order matters — pastes first, in composer order, so the Nth
    // placeholder maps to the Nth paste attachment.
    const attachments: TranscriptAttachment[] = [
      ...composer.getBlocks().map((b) => ({ kind: 'paste' as const, label: b.label })),
      ...attachedFiles.map((f) => ({
        kind: 'file' as const,
        label: f.path.split('/').pop() ?? f.path,
      })),
      ...attachedThreads.map((t) => ({
        kind: 'thread' as const,
        label: t.title || 'Untitled thread',
      })),
      ...attachedShells.map((s) => ({
        kind: 'shell' as const,
        label: s.label,
      })),
      ...attachedVideos.map((v) => ({
        kind: 'video' as const,
        label: v.name,
      })),
    ]
    const imageUrls = attachedImages.map((img) => img.dataUrl)
    const messageId = addMessage(
      store,
      id,
      'user',
      visibleText,
      imageUrls.length ? imageUrls : undefined,
      attachments.length ? attachments : undefined,
    )
    if (currentBranch) bindThreadGitBranchIfUnset(store, id, currentBranch)
    // Durable record of the attachment: the reference block in this message can
    // be trimmed out of a long conversation, but the tool is gated and described
    // from the thread, so the agent keeps the path for as long as the thread does.
    recordThreadVideos(store, id, attachedVideos)

    if (isRunning()) {
      enqueueUserMessage(store, id, {
        messageId,
        payload,
        createdAt: Date.now(),
      })
    } else {
      // A typed prompt at idle starts a fresh turn tree (decision 16): late async
      // hooks from an earlier turn now carry a stale epoch and are held, not
      // auto-submitted, into this new turn.
      startHumanTurnTree(store, id)
      dispatchAgentRun(store, api, id, payload)
    }
    composer.clear()
    setThreadDraftPrompt(store, id, '')
    attachedFiles = []
    attachedImages = []
    attachedVideos = []
    attachedThreads = []
    attachedShells = []
    clear(chips)
    scheduleContextEstimate(0)
  }

  function addChip(file: { path: string; content: string }): void {
    attachedFiles.push(file)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip'
    const name = document.createElement('span')
    name.className = 'attachment-chip-label'
    name.textContent = file.path.split('/').pop() ?? file.path
    chip.append(name)
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

  function addThreadChip(ref: AttachedThreadRef): void {
    if (attachedThreads.some((t) => t.threadId === ref.threadId)) return
    attachedThreads.push(ref)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip thread-chip'
    const title = document.createElement('span')
    title.className = 'attachment-chip-label'
    title.textContent = ref.title || 'Untitled thread'
    chip.append(threadIcon('thread-chip-icon'), title)
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedThreads = attachedThreads.filter((t) => t.threadId !== ref.threadId)
      chip.remove()
      scheduleContextEstimate()
    })
    chip.append(remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  function addShellChip(ref: AttachedShellRef): void {
    if (attachedShells.some((s) => s.tabId === ref.tabId)) return
    attachedShells.push(ref)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip shell-chip'
    const title = document.createElement('span')
    title.className = 'attachment-chip-label'
    title.textContent = ref.label
    chip.append(shellIcon('shell-chip-icon'), title)
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedShells = attachedShells.filter((s) => s.tabId !== ref.tabId)
      chip.remove()
      scheduleContextEstimate()
    })
    chip.append(remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  /**
   * Store an attached video and show its chip. The store round-trip is what
   * makes this async: the file is written next to the thread first, so the chip
   * only ever represents a video the agent can actually open. A failure (wrong
   * format, too large) surfaces as a toast and attaches nothing.
   */
  async function addVideoChip(video: PromptVideoAttachment): Promise<void> {
    const projectId = store.getState().activeProjectId
    const threadId = getActiveThreadId()
    if (!projectId || !threadId) return
    let ref: VideoAttachmentRef
    try {
      ref = await api.video.attach(projectId, threadId, {
        name: video.name,
        mimeType: video.mimeType,
        ...(video.bytes ? { bytes: new Uint8Array(video.bytes) } : {}),
        ...(video.path ? { path: video.path } : {}),
      })
    } catch (err) {
      showErrorToast('Could not attach video', err)
      return
    }
    if (attachedVideos.some((v) => v.path === ref.path)) return
    attachedVideos.push(ref)

    const chip = document.createElement('span')
    chip.className = 'attachment-chip video-chip'
    const label = document.createElement('span')
    label.className = 'attachment-chip-label'
    label.textContent = ref.name
    // The size is the honest cost signal here: the video costs no context, but
    // it does tell the user (and the agent) how much recording there is to read.
    const meta = document.createElement('span')
    meta.className = 'attachment-chip-meta'
    meta.textContent = formatByteSize(ref.sizeBytes)
    chip.title = `${ref.name} — read as stills by the agent, not sent as video`
    chip.append(attachmentIcon('video', 'video-chip-icon'), label, meta)
    const remove = document.createElement('button')
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachedVideos = attachedVideos.filter((v) => v.path !== ref.path)
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
    // Text selections (Monaco/terminal) land as inline chips at the caret, so
    // the reference sits inside the sentence the user is writing.
    attachTextBlock: (content: string, label?: string): void => {
      composer.insertPasteChip(content, label)
    },
    attachImage: addImageChip,
    attachVideo: addVideoChip,
    focusComposer: (): void => {
      requestAnimationFrame(() => {
        composer.focus()
      })
    },
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

    if (!composer.isFocused()) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!isTextBlockAttachment(text)) return
    e.preventDefault()
    composer.insertPasteChip(text)
  }
  document.addEventListener('paste', onPaste)

  const unbindDrop = bindFileDropTarget(
    root,
    () => attachmentHandlers,
    api,
    () => store.getState().workspaceRoot,
  )

  initMentionPicker({
    input: composer,
    inputBar: root,
    store,
    api,
    onAttach: addChip,
    onAttachThread: addThreadChip,
    onAttachShell: addShellChip,
  })

  let skillsCache: SkillSummary[] | null = null
  const refreshSkillsCache = (): void => {
    void api.skills.list().then(
      (skills) => {
        skillsCache = skills
      },
      () => {
        // Leave null so the next read/refetch is not short-circuited by a
        // sticky empty array (`[]` is truthy for `skillsCache ?? …`).
        skillsCache = null
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
    input: composer,
    inputBar: root,
    // Keep the submit-time cache aligned with whatever the picker just showed.
    listSkills: async () => {
      const skills = await api.skills.list()
      skillsCache = skills
      return skills
    },
  })

  const unsubs = [
    // Main fires this after `initSkillsRegistry` (including the background
    // rescan on `workspace:set`). Refresh the cache so `/checkup` and friends
    // are visible to context estimates before the next picker open/submit.
    api.agent.onRefreshContextEstimate(() => {
      refreshSkillsCache()
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
    store.on('composer_checkout_preferred', (choice) => {
      const thread = getActiveThread(store)
      if (!thread || thread.messages.length > 0 || thread.worktreeChoice) return
      selectCheckout(choice)
    }),
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
      guardedYolo.refresh()
      hideBranchMismatch()
      updateState()
      updateFooter()
      updateQueueIndicator()
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
      void refreshAutomaticCheckoutPreview()
    }),
    store.on('git_branch_changed', () => {
      branchControl.refresh()
      void refreshAutomaticCheckoutPreview()
    }),
  ]

  const observer = new MutationObserver(() => {
    const hasSuggestions = !followUps.root.hidden
    composer.setPlaceholder(hasSuggestions ? followUpPlaceholder : defaultPlaceholder)
  })
  observer.observe(followUps.root, { attributes: true, attributeFilter: ['hidden'] })

  updateFooter()
  void refreshAutomaticCheckoutPreview()
  refreshExtraPricing()
  syncComposerThread()
  scheduleContextEstimate(0)
  window.addEventListener('beforeunload', stopContextEstimates)
  return {
    handleStopShortcut,
    unmount(): void {
      window.removeEventListener('beforeunload', stopContextEstimates)
      stopContextEstimates()
      draftAutosave.cancel()
      if (activeComposerThreadId) {
        setThreadDraftPrompt(store, activeComposerThreadId, composer.expandedValue())
      }
      unsubs.forEach((u) => {
        u()
      })
      unsubWorkspace()
      window.removeEventListener('copse:skills-changed', onSkillsChanged)
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('click', closeCheckoutMenu)
      observer.disconnect()
      followUps.destroy()
      unbindDrop()
      unregisterAttachments()
      modelPicker.destroy()
      footerOverflow.destroy()
      guardedYolo.destroy()
      footerCompact.destroy()
      portraitPanelControls.destroy()
      branchControl.destroy()
      indexStatusChip.destroy()
      skillPicker()
    },
  }
}
