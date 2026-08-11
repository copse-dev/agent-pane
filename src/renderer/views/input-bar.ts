import { el, clear } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import { closeIcon } from '../dom/icons.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import { showContextMenu } from '../dom/context-menu.ts'
import { attachTextExpand } from '../attachments/text-expand.ts'
import { IMAGE_DETAILS, type ImageDetail } from '@copse/llm/wire-types.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  setThreadWorkingBrief,
  bindThreadGitBranchIfUnset,
  recordThreadVideos,
  recordThreadArchives,
  applyPreparedThreadCheckout,
  createThread,
  getThreadById,
  getActiveThread,
  setThreadDraftPrompt,
  setThreadTitle,
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
  type ArchiveRefAttachment,
  type ThreadRefAttachment,
  type VideoRefAttachment,
} from '@copse/agent/build-text-with-attachments.ts'
import { mountComposerEditor } from './composer-editor.ts'
import {
  registerPromptAttachments,
  type PromptArchiveAttachment,
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
import { mountFooterReasoningDial } from './footer-reasoning-dial.ts'
import { mountFooterBranchStatus } from './footer-branch-status.ts'
import { createContextWheel } from './context-wheel.ts'
import { bindFooterCompactLayout } from './footer-compact.ts'
import { mountFooterOverflow } from './footer-overflow.ts'
import {
  downloadThreadArchive,
  downloadThreadJsonl,
  threadExportBaseName,
  threadHasExportableContent,
} from '../export-thread.ts'
import { buildShareTraceIssueUrl } from '@shared/github/share-trace-issue.ts'
import { buildDebugTracePrompt, debugTraceThreadTitle } from '@shared/threads/debug-trace-prompt.ts'
import {
  formatFooterUsageDetail,
  formatFooterUsageSummary,
  resolveFooterUsage,
} from '@shared/usage/footer-usage-summary.ts'
import {
  buildFooterUsageTooltip,
  type FooterUsageTooltipModel,
} from '@shared/usage/footer-usage-tooltip.ts'
import { createFooterUsagePopover } from './footer-usage-popover.ts'
import { type ModelPricingMap } from '@copse/llm/model-pricing.ts'
import {
  DEFAULT_APP_CHAT_MODEL,
  FALLBACK_APP_CHAT_MODEL,
  isBestValueChatModel,
} from '@shared/lm-studio-defaults.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'
import { syncThreadGitBranchIfChanged } from '@shared/git/sync-thread-branch.ts'
import { showErrorToast, showToast } from './toast.ts'
import { type VideoAttachmentRef } from '@shared/video/video-media.ts'
import { type ArchiveAttachmentRef } from '@shared/archive/archive-media.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { createComposerDraftAutosave } from './composer-draft-autosave.ts'
import { mountPanelModeControls } from './panel-mode-controls.ts'
import type { ThreadWorktreeChoice } from '@shared/types/worktree.ts'
import { mountGuardedYoloControl } from './guarded-yolo-control.ts'
import { getActiveThreadOwner } from '../controller/active-thread-owner.ts'
import { expectString } from '@shared/unknown-value.ts'
import { isAcpModel } from '@shared/acp.ts'
import { fetchModelOptions, modelDisplayLabel, type ModelOption } from './model-options.ts'
import { contextFitAdvice } from '@shared/context-window-advice.ts'
import { isLocalModel } from '@copse/llm/estimate-cost.ts'

interface MountInputBarOptions {
  /**
   * Dock the portrait panel tabs to the chat/panel seam instead of making them
   * part of the floating composer card. Tests that mount the input in isolation
   * can omit this and keep all generated UI under their fixture root.
   */
  portraitPanelHost?: HTMLElement
}

/** One image in the composer, with the fidelity chosen for it (default `auto`). */
interface AttachedImage {
  dataUrl: string
  mimeType: string
  detail?: ImageDetail
}

/**
 * Menu copy for each fidelity. Says what it costs as well as what it does —
 * `low` is the one with a consequence worth warning about, because it
 * downsamples far enough that text in a screenshot stops being readable.
 */
const IMAGE_DETAIL_LABELS: Record<ImageDetail, string> = {
  auto: 'Auto detail (provider decides)',
  low: 'Low detail — cheapest, text may be unreadable',
  high: 'High detail — full fidelity, most tokens',
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
    {
      class: 'stop-btn',
      type: 'button',
      hidden: '',
      'aria-label': 'Stop agent',
      'data-tooltip': 'Stop the running agent',
      'data-tooltip-placement': 'top',
    },
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
    {
      class: 'attach-btn',
      type: 'button',
      'aria-label': 'Attach files',
      'data-tooltip': 'Attach files',
      'data-tooltip-placement': 'top',
    },
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
  const imageCompatibilityText = el('span', { class: 'composer-image-warning-text' })
  const useImageModelBtn = el(
    'button',
    { type: 'button', class: 'composer-image-model-btn', hidden: '' },
    'Use image model',
  )
  const describeImagesBtn = el(
    'button',
    { type: 'button', class: 'composer-image-describe-btn', hidden: '' },
    'Describe image',
  )
  const sendWithoutImagesBtn = el(
    'button',
    { type: 'button', class: 'composer-image-without-btn' },
    'Send without image',
  )
  const imageCompatibilityWarning = el(
    'div',
    {
      class: 'composer-image-warning',
      role: 'status',
      'aria-live': 'polite',
      hidden: '',
    },
    el('span', { class: 'composer-image-warning-icon', 'aria-hidden': 'true' }, '!'),
    imageCompatibilityText,
    useImageModelBtn,
    describeImagesBtn,
    sendWithoutImagesBtn,
  )
  // Sits beside the model picker it talks about: the thread no longer fits (or
  // barely fits) the model selected for it. Recomputed from the same pre-send
  // estimate that drives the context wheel, so picking a model updates it at once.
  const contextFitText = el('span', { class: 'composer-context-warning-text' })
  const contextFitModelBtn = el(
    'button',
    { type: 'button', class: 'composer-context-model-btn' },
    'Choose another model',
  )
  const contextFitWarning = el(
    'div',
    {
      class: 'composer-context-warning',
      role: 'status',
      'aria-live': 'polite',
      hidden: '',
    },
    el('span', { class: 'composer-context-warning-icon', 'aria-hidden': 'true' }, '!'),
    contextFitText,
    contextFitModelBtn,
  )
  let footerOverflow: ReturnType<typeof mountFooterOverflow> | null = null
  const guardedYolo = mountGuardedYoloControl(api, getActiveThreadId, () => {
    footerOverflow?.update()
  })
  const footer = el('div', { class: 'input-footer' })
  const modelHost = el('div', { class: 'footer-model-host' })
  const reasoningHost = el('div', { class: 'footer-reasoning-host' })
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
  // Token usage — always shown once a thread has used tokens; hover (or focus)
  // for the in/out breakdown and cost, like the context wheel next to it.
  const usageBtn = el('span', {
    class: 'footer-usage',
    tabindex: '0',
    role: 'note',
    'aria-label': 'Token usage',
  })
  const usagePopover = createFooterUsagePopover()
  const usageGroup = el('div', { class: 'footer-usage-group' })
  const queueIndicator = el('span', { class: 'footer-queue', hidden: '', 'aria-live': 'polite' })
  const contextWheel = createContextWheel()
  // Appends its chip first, so it sits left of the wheel/queue/usage widgets.
  const indexStatusChip = mountFooterIndexStatus(usageGroup, api)
  usageGroup.append(contextWheel.root, queueIndicator, usageBtn, usagePopover.root)
  footer.append(modelHost, reasoningHost, checkoutHost, branchHost)
  footerOverflow = mountFooterOverflow(footer, [
    {
      label: guardedYolo.menuLabel,
      hidden: (): boolean => !getActiveThreadId(),
      onClick: guardedYolo.toggle,
    },
    {
      label: 'Copy thread ID',
      hidden: (): boolean => !store.getState().developerMode || !getActiveThreadId(),
      onClick: copyThreadId,
    },
    {
      label: 'Export conversation (JSONL)',
      hidden: (): boolean =>
        !store.getState().developerMode || !threadHasExportableContent(getActiveThread(store)),
      onClick: (): void => {
        const thread = getActiveThread(store)
        if (threadHasExportableContent(thread)) downloadThreadJsonl(thread)
      },
    },
    {
      label: 'Export thread folder (ZIP)',
      hidden: (): boolean =>
        !store.getState().developerMode ||
        store.getState().activeProjectId === null ||
        !threadHasExportableContent(getActiveThread(store)),
      onClick: exportThreadArchive,
    },
    // Debug trace and Share trace are the two "something went wrong here" exits,
    // so unlike the diagnostics above them they are not behind Developer mode —
    // the user who needs them is by definition not the one who went looking for
    // a developer setting first.
    {
      label: 'Debug trace',
      hidden: (): boolean =>
        store.getState().activeProjectId === null ||
        !threadHasExportableContent(getActiveThread(store)),
      onClick: debugTrace,
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
  /** Concrete model for footer chrome — never the Settings-only best-value sentinel. */
  function footerChatModel(): string {
    const thread = getActiveThread(store)
    const raw = thread?.model ?? store.getState().settings?.model ?? DEFAULT_APP_CHAT_MODEL
    return isBestValueChatModel(raw) ? FALLBACK_APP_CHAT_MODEL : raw
  }

  /**
   * The label for the footer picker trigger. When the active model is a dynamic
   * selector (`auto:…`), prefer the concrete route the last turn actually ran
   * on so the picker shows a real model instead of the opaque selector; fall
   * back to the selector's display label otherwise.
   */
  function footerModelDisplayLabel(current: string): string | undefined {
    if (!isDynamicModel(current)) return undefined
    const thread = getActiveThread(store)
    if (!thread) return undefined
    const resolved =
      thread.resolvedModel ??
      [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model
    // Run the resolved route through the same label formatter the picker uses
    // (OpenRouter/cloud friendly), so `openrouter:minimax/minimax-m3` renders
    // as "MiniMax M3" rather than the raw id.
    return resolved ? modelDisplayLabel(resolved) : undefined
  }

  function footerRecentModels(): string[] {
    const { threads, settings } = store.getState()
    return [...threads]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => {
        const raw = thread.model ?? settings?.model ?? DEFAULT_APP_CHAT_MODEL
        return isBestValueChatModel(raw) ? FALLBACK_APP_CHAT_MODEL : raw
      })
  }

  function selectChatModel(model: string): void {
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
    // The new model may offer a different ladder — or none at all.
    reasoningDial.sync()
    updateFooter()
    // The context window depends on the model, so re-estimate the footer wheel
    // against the newly selected model rather than waiting for the next keystroke.
    void runContextEstimate()
    void refreshAutomaticCheckoutPreview()
    void refreshImageCompatibilityWarning()
  }

  // Per-chat effort, beside the model it applies to. Writes to the thread, so
  // it lasts as long as the conversation and never re-tunes the model itself.
  const reasoningDial = mountFooterReasoningDial(
    reasoningHost,
    footerChatModel,
    () => getActiveThread(store)?.reasoning,
    (reasoning) => {
      const thread = getActiveThread(store)
      if (!thread) return
      const threads = store.getState().threads.map((t) =>
        t.id !== thread.id
          ? t
          : {
              ...t,
              ...(reasoning === undefined ? {} : { reasoning }),
              updatedAt: Date.now(),
            },
      )
      // Clearing the dial has to delete the field rather than write undefined,
      // or the thread keeps a key that reads as "set" on the next sync.
      if (reasoning === undefined) {
        const target = threads.find((t) => t.id === thread.id)
        if (target) Reflect.deleteProperty(target, 'reasoning')
      }
      store.setState({ threads })
      reasoningDial.sync()
      composer.focus()
    },
  )

  const modelPicker = mountFooterModelPicker(modelHost, api, footerChatModel, selectChatModel, {
    formatCurrentLabel: footerModelDisplayLabel,
    isSshWorkspace: (): boolean => {
      const { activeProjectId, projects } = store.getState()
      if (!activeProjectId) return false
      return Boolean(projects.find((p) => p.id === activeProjectId)?.sshHost)
    },
    onClose: (): void => {
      composer.focus()
    },
    getRecentModels: footerRecentModels,
  })
  // Re-sync the picker whenever the active thread changes (new thread,
  // thread switch, or thread deletion that shifts the active pointer), and when
  // the project changes so ACP options hide/show with SSH workspaces.
  store.on('threads_changed', () => {
    modelPicker.refresh()
    reasoningDial.sync()
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

  function exportThreadArchive(): void {
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (projectId === null || !threadHasExportableContent(thread)) return
    void downloadThreadArchive(api, projectId, thread).catch((error: unknown) => {
      showErrorToast('Export thread folder failed', error)
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

  /**
   * Hand this thread's trace to a fresh thread and ask what went wrong in it.
   *
   * Everything the model needs is the zip — the same archive "Export thread
   * folder (ZIP)" downloads — attached to a new conversation rather than saved to
   * disk, so the diagnosis happens where the user already is. The draft prompt is
   * deliberately left unsent: only the person who watched the run knows which
   * part of it looked wrong, and the draft ends on a line for them to say so.
   */
  async function startDebugTrace(): Promise<void> {
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (projectId === null || !threadHasExportableContent(thread)) return
    // Zip before switching away: a failed export should leave the user on the
    // thread they were reading, not on an empty one with nothing attached.
    const bytes = await api.threads.exportArchive(projectId, thread.id)
    const name = `${threadExportBaseName(thread)}.zip`
    // Persist whatever is in the composer to its own thread before switching.
    store.emit('composer_draft_flush')
    const debugThreadId = createThread(store, buildDebugTracePrompt(thread, name))
    // A title now, rather than one auto-suggested from the first message later:
    // the sidebar should say which thread this is about before it is ever sent.
    setThreadTitle(store, debugThreadId, debugTraceThreadTitle(thread))
    // `threads_changed` has already switched the composer to the new thread, so
    // the archive is stored under *its* blobs and lives as long as it does.
    // `.slice` narrows the transferred view to exactly its own bytes, which is
    // what the attach path re-wraps.
    await addArchiveChip({
      name,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })
    composer.focus()
  }

  function debugTrace(): void {
    void startDebugTrace().catch((error: unknown) => {
      showErrorToast('Debug trace failed', error)
    })
  }
  usageBtn.addEventListener('mouseenter', usagePopover.show)
  usageBtn.addEventListener('mouseleave', usagePopover.hide)
  usageBtn.addEventListener('focus', usagePopover.show)
  usageBtn.addEventListener('blur', usagePopover.hide)

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
  root.append(
    chips,
    guardedYolo.element,
    branchWarning,
    checkoutError,
    imageCompatibilityWarning,
    contextFitWarning,
    inputRow,
    footer,
  )
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
  let attachedImages: AttachedImage[] = []
  // Attached videos (screen recordings). Stored on disk and referenced by path —
  // the media never enters the prompt, so unlike images these cost no context.
  // The agent reads them through the `video_frames` tool.
  let attachedVideos: VideoAttachmentRef[] = []
  let attachedArchives: ArchiveAttachmentRef[] = []
  // `@`-referenced past threads (#644): the agent gets a path reference + steering
  // preamble, nothing inlined. Composer-only state, like file/image chips.
  let attachedThreads: AttachedThreadRef[] = []
  // `@shell` snapshots: scrollback inlined like a paste/file block.
  let attachedShells: AttachedShellRef[] = []
  let imageCompatibilitySeq = 0
  let recommendedImageModel: ModelOption | null = null
  let recommendedDescriptionModel: ModelOption | null = null
  let imageDescriptionInProgress = false
  const checkoutChoices = new Map<string, ThreadWorktreeChoice>()
  let checkoutPreparationInProgress = false
  let automaticCheckoutMode: 'shared' | 'worktree' = 'shared'
  let automaticCheckoutPreviewSeq = 0

  function shortModelLabel(option: ModelOption): string {
    return option.label.split(' — ')[0] ?? option.label
  }

  function appendImageDescription(text: string, modelLabel: string, description: string): string {
    const prefix = text.trim() ? `${text.trim()}\n\n` : ''
    return `${prefix}[Image description generated by ${modelLabel}]\n${description}\n[End image description]`
  }

  function currentWorkspaceIsSsh(): boolean {
    const { activeProjectId, projects } = store.getState()
    if (!activeProjectId) return false
    return Boolean(projects.find((project) => project.id === activeProjectId)?.sshHost)
  }

  async function incompatibleImageModel(): Promise<{
    selected: ModelOption
    recommended: ModelOption | null
    descriptionModel: ModelOption | null
  } | null> {
    if (attachedImages.length === 0) return null
    const model = footerChatModel()
    let options: ModelOption[]
    try {
      options = await fetchModelOptions(api, model, {
        sshWorkspace: currentWorkspaceIsSsh(),
      })
    } catch {
      // Custom/local endpoints often cannot advertise modalities. A failed
      // lookup is unknown, never evidence that the prompt should be blocked.
      return null
    }
    const selected = options.find((option) => option.value === model)
    if (selected?.supportsImages !== false) return null

    const supported = options.filter(
      (option) => option.supportsImages === true && !option.disabled && Boolean(option.value),
    )
    const recentRecommendation = footerRecentModels()
      .filter((value) => value !== model)
      .map((value) => supported.find((option) => option.value === value))
      .find((option) => option !== undefined)
    return {
      selected,
      recommended:
        recentRecommendation ?? supported.find((option) => option.value !== model) ?? null,
      // Prefer a local vision model for the image→text handoff. It keeps the
      // image on-device even when the final text-only model is remote.
      descriptionModel:
        supported.find((option) => option.value.startsWith('lmstudio:')) ??
        recentRecommendation ??
        supported.find((option) => option.value !== model) ??
        null,
    }
  }

  function hideImageCompatibilityWarning(): void {
    imageCompatibilitySeq++
    recommendedImageModel = null
    recommendedDescriptionModel = null
    imageCompatibilityWarning.hidden = true
  }

  async function refreshImageCompatibilityWarning(): Promise<void> {
    const seq = ++imageCompatibilitySeq
    if (attachedImages.length === 0) {
      imageCompatibilityWarning.hidden = true
      recommendedImageModel = null
      recommendedDescriptionModel = null
      return
    }
    const result = await incompatibleImageModel()
    if (seq !== imageCompatibilitySeq) return
    if (!result) {
      imageCompatibilityWarning.hidden = true
      recommendedImageModel = null
      recommendedDescriptionModel = null
      return
    }
    const count = attachedImages.length
    imageCompatibilityText.textContent = `${shortModelLabel(result.selected)} can’t read image input. Choose an image-capable model, or continue without ${count === 1 ? 'the image' : `the ${String(count)} images`}.`
    recommendedImageModel = result.recommended
    useImageModelBtn.hidden = result.recommended === null
    if (result.recommended) {
      useImageModelBtn.textContent = `Use ${shortModelLabel(result.recommended)}`
    }
    recommendedDescriptionModel = result.descriptionModel
    describeImagesBtn.hidden = result.descriptionModel === null
    if (result.descriptionModel) {
      const local = result.descriptionModel.value.startsWith('lmstudio:')
      describeImagesBtn.textContent = `${local ? 'Describe locally with' : 'Describe with'} ${shortModelLabel(result.descriptionModel)}`
    }
    sendWithoutImagesBtn.textContent = count === 1 ? 'Send without image' : 'Send without images'
    imageCompatibilityWarning.hidden = false
  }

  useImageModelBtn.addEventListener('click', () => {
    if (!recommendedImageModel) return
    selectChatModel(recommendedImageModel.value)
    composer.focus()
  })

  contextFitModelBtn.addEventListener('click', (event) => {
    // The picker closes on any document click outside its own subtree, and this
    // button is outside it — without stopping propagation the menu would shut in
    // the same dispatch that opened it.
    event.stopPropagation()
    modelPicker.openMenu()
  })

  function removeAttachedImages(): void {
    attachedImages = []
    chips.querySelectorAll('.image-chip').forEach((chip) => {
      chip.remove()
    })
  }

  function setImageDescriptionBusy(busy: boolean, label?: string): void {
    imageDescriptionInProgress = busy
    imageCompatibilityWarning.setAttribute('aria-busy', String(busy))
    describeImagesBtn.disabled = busy
    useImageModelBtn.disabled = busy
    sendWithoutImagesBtn.disabled = busy
    submitBtn.disabled = busy
    if (busy && label) describeImagesBtn.textContent = `Describing with ${label}…`
    composer.el.setAttribute('contenteditable', busy ? 'false' : 'plaintext-only')
  }

  describeImagesBtn.addEventListener('click', () => {
    if (!recommendedDescriptionModel || imageDescriptionInProgress) return
    const projectId = store.getState().activeProjectId
    const threadId = getActiveThreadId()
    if (!projectId || !threadId) return
    const descriptor = recommendedDescriptionModel
    const modelLabel = shortModelLabel(descriptor)
    const images = attachedImages.map((image) => image.dataUrl)
    const userPrompt = composer.expandedValue().trim()
    setImageDescriptionBusy(true, modelLabel)
    void api.agent
      .describeImages(projectId, threadId, descriptor.value, userPrompt, images)
      .then(async ({ text }) => {
        // A thread switch changes the ownership of the composer. Never carry a
        // generated description into a different thread or auto-submit there.
        if (getActiveThreadId() !== threadId) return
        removeAttachedImages()
        composer.value = appendImageDescription(composer.value, modelLabel, text)
        composer.el.dispatchEvent(new Event('input', { bubbles: true }))
        hideImageCompatibilityWarning()
        scheduleContextEstimate()
        await submit()
      })
      .catch((error: unknown) => {
        showErrorToast(`Could not describe the image with ${modelLabel}`, error)
      })
      .finally(() => {
        setImageDescriptionBusy(false)
        if (getActiveThreadId() === threadId && attachedImages.length > 0) {
          void refreshImageCompatibilityWarning()
        }
      })
  })

  sendWithoutImagesBtn.addEventListener('click', () => {
    removeAttachedImages()
    hideImageCompatibilityWarning()
    scheduleContextEstimate()
    void submit()
  })

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

  const currentArchiveRefs = (): ArchiveRefAttachment[] =>
    attachedArchives.map((a) => ({
      path: a.path,
      name: a.name,
      size: formatByteSize(a.sizeBytes),
    }))
  let mismatchBranch: string | null = null
  let checkoutInProgress = false
  let lastBreakdown: ContextBreakdown | null = null
  // Model the last estimate was computed for. The context-fit warning quotes a
  // window and a model name together, so it must not pair a fresh selection with
  // the previous model's window while the new estimate is still in flight.
  let breakdownModel: string | null = null
  // Rates for every model outside the static cloud catalog — OpenRouter routes
  // and extra providers alike — keyed by model selection. Resolved in the main
  // process (see model-pricing-store.ts) so the footer and the usage ledger
  // price an identical thread identically.
  let modelPricing: ModelPricingMap = {}
  function refreshModelPricing(): void {
    // Best-effort: a missing/failed pricing map just leaves the footer cost
    // resting on the static cloud catalog, so never let it throw.
    try {
      void api.settings
        .modelPricing()
        .then((pricing) => {
          modelPricing = pricing
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

  /**
   * Drop every composer attachment and its chip.
   *
   * Called on send, and on a thread switch: an attachment is bound to the
   * thread that was active when it was attached — a dropped archive or video
   * is already stored under that thread's `blobs/media/` — so carrying the chip
   * to another thread would record a path into a directory the receiving thread
   * does not own, and which disappears if the original thread is deleted.
   */
  function clearAttachments(): void {
    attachedFiles = []
    attachedImages = []
    attachedVideos = []
    attachedArchives = []
    attachedThreads = []
    attachedShells = []
    clear(chips)
    hideImageCompatibilityWarning()
  }

  function syncComposerThread(): void {
    const id = getActiveThreadId()
    if (id === activeComposerThreadId) return
    if (activeComposerThreadId) {
      setThreadDraftPrompt(store, activeComposerThreadId, composer.expandedValue())
    }
    const thread = getThreadById(store, id)
    composer.value = thread?.draftPrompt ?? ''
    // Attachments are thread-bound (see clearAttachments); the draft text that
    // just moved with the switch is not.
    if (activeComposerThreadId !== null) clearAttachments()
    activeComposerThreadId = id
    hideCheckoutError()
    // New thread → drop the prior thread's estimate and recompute for this one.
    lastBreakdown = null
    breakdownModel = null
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

  /** Footer label, the one-line detail (compact fallback) and the hover tooltip. */
  function usageViews(): {
    label: string
    detail: string
    tooltip: FooterUsageTooltipModel
  } | null {
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
    // #1483 moved footer pricing onto the persisted catalog snapshot; all three
    // views price from that same map.
    const priced = { model, measuredUsage: thread.usage, pricing: modelPricing }
    const tooltip = buildFooterUsageTooltip(display, { ...priced, messages: thread.messages })
    return {
      label: formatFooterUsageSummary(display),
      detail: formatFooterUsageDetail(display, priced),
      tooltip,
    }
  }

  /**
   * Warn when the thread has outgrown (or nearly outgrown) the model chosen for
   * it. Silent until an estimate for the *current* model lands, so a model the
   * user just picked is never described with the previous model's window.
   */
  function updateContextFitWarning(): void {
    const model = footerChatModel()
    const advice =
      breakdownModel === model
        ? contextFitAdvice(lastBreakdown, {
            modelLabel: modelDisplayLabel(model),
            lmStudioModel: isLocalModel(model),
          })
        : null
    if (!advice) {
      contextFitWarning.hidden = true
      return
    }
    contextFitText.textContent = advice.message
    contextFitWarning.classList.toggle('is-over', advice.level === 'over')
    contextFitWarning.hidden = false
  }

  function updateFooter(): void {
    const thread = getActiveThread(store)
    const running = thread?.status === 'running'
    const acpContext = isAcpModel(footerChatModel())
    const usage = usageViews()
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
      attachedArchives.length > 0 ||
      attachedThreads.length > 0 ||
      attachedShells.length > 0
    // Show the pre-send breakdown while composing (or on fresh threads with no live
    // snapshot); keep the measured live snapshot once a run has produced one.
    const showBreakdown =
      !acpContext &&
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
    const hoverBreakdown = !running && !acpContext ? lastBreakdown : null
    contextWheel.update(snapshot, running, {
      usageLine: tuckUsageIntoWheel ? (usage?.detail ?? null) : null,
      breakdown: hoverBreakdown,
      breakdownRing: showBreakdown,
      snapshotSource:
        acpContext && snapshot?.source === 'agent-reported' ? 'Reported by ACP agent' : null,
    })
    contextWheel.root.classList.toggle('is-interactive', tuckUsageIntoWheel)
    if (!usage) {
      usageBtn.hidden = true
      usagePopover.render(null)
    } else {
      usageBtn.hidden = tuckUsageIntoWheel
      usageBtn.textContent = usage.label
      usageBtn.setAttribute('aria-label', usage.detail)
      // Compact mode hides the counter and tucks usage into the wheel title —
      // nothing left to hover, so drop the popover with it.
      usagePopover.render(tuckUsageIntoWheel ? null : usage.tooltip)
    }
    footerOverflow?.update()
    updateContextFitWarning()
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
      archiveRefs: currentArchiveRefs(),
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
    // The external agent owns its system prompt, tools, skills, and cache. A
    // Copse-native estimate would describe the wrong prompt; wait for ACP's
    // authoritative `usage_update` instead.
    if (isAcpModel(footerChatModel())) {
      if (lastBreakdown !== null) {
        lastBreakdown = null
        breakdownModel = null
        updateFooter()
      }
      return
    }
    const id = getActiveThreadId()
    if (!id) {
      if (lastBreakdown !== null) {
        lastBreakdown = null
        breakdownModel = null
        updateFooter()
      }
      return
    }
    const projectId = store.getState().activeProjectId
    if (!projectId) return
    const seq = ++estimateSeq
    const estimatedModel = footerChatModel()
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
    breakdownModel = estimatedModel
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
    if (
      checkoutMenu.hidden ||
      checkoutHost.contains(event.target instanceof Node ? event.target : null)
    )
      return
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
    const { activeProjectId, activeThreadId } = store.getState()
    if (!activeProjectId || !activeThreadId) return
    const branch = mismatchBranch
    checkoutInProgress = true
    showBranchMismatch(branch)

    void api.git
      .checkoutBranch(activeProjectId, activeThreadId, branch)
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
    const projectId = store.getState().activeProjectId
    if (!projectId) return
    void api.git
      .branchStatus(projectId, id)
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
      attachedArchives.length === 0 &&
      attachedThreads.length === 0 &&
      attachedShells.length === 0
    )
      return
    const id = getActiveThreadId()
    if (!id) return

    const projectId = store.getState().activeProjectId
    if (!projectId) return
    if (attachedImages.length > 0) {
      const incompatibility = await incompatibleImageModel()
      if (incompatibility) {
        await refreshImageCompatibilityWarning()
        return
      }
    }
    const [branchStatus, promptState] = await Promise.all([
      api.git.branchStatus(projectId, id),
      api.git.promptState(projectId, id),
    ])
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
          attachedFiles.length > 0 ||
            attachedImages.length > 0 ||
            attachedVideos.length > 0 ||
            attachedArchives.length > 0,
        )
      : rawText

    let fullContent: UserContent
    if (attachedImages.length > 0) {
      fullContent = [
        ...attachedImages.map((img) => ({
          type: 'image' as const,
          dataUrl: img.dataUrl,
          // Omitted at 'auto' so an untouched attachment sends the same content
          // it always has, and stored history stays free of a redundant field.
          ...(img.detail && img.detail !== 'auto' ? { detail: img.detail } : {}),
        })),
        {
          type: 'text' as const,
          text: buildTextWithAttachments(text, attachedFiles, currentShellBlocks(), {
            threadRefs: currentThreadRefs(),
            videoRefs: currentVideoRefs(),
            archiveRefs: currentArchiveRefs(),
          }),
        },
      ]
    } else {
      fullContent = buildTextWithAttachments(text, attachedFiles, currentShellBlocks(), {
        threadRefs: currentThreadRefs(),
        videoRefs: currentVideoRefs(),
        archiveRefs: currentArchiveRefs(),
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
      ...composer
        .getBlocks()
        .map((b) => ({ kind: 'paste' as const, label: b.label, content: b.content })),
      ...attachedFiles.map((f) => ({
        kind: 'file' as const,
        label: f.path.split('/').pop() ?? f.path,
        content: f.content,
      })),
      ...attachedThreads.map((t) => ({
        kind: 'thread' as const,
        label: t.title || 'Untitled thread',
      })),
      ...attachedShells.map((s) => ({
        kind: 'shell' as const,
        label: s.label,
        content: s.content,
      })),
      ...attachedVideos.map((v) => ({
        kind: 'video' as const,
        label: v.name,
        // Carried so the sent chip can still play the recording after a reload,
        // when the composer's own state is long gone.
        path: v.path,
      })),
      ...attachedArchives.map((a) => ({
        kind: 'archive' as const,
        label: a.name,
        path: a.path,
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
      {
        ...(promptState.startingCommit !== null
          ? { startingCommit: promptState.startingCommit }
          : {}),
        dirty: promptState.dirty,
      },
    )
    if (currentBranch) bindThreadGitBranchIfUnset(store, id, currentBranch)
    // Durable record of the attachment: the reference block in this message can
    // be trimmed out of a long conversation, but the tool is gated and described
    // from the thread, so the agent keeps the path for as long as the thread does.
    recordThreadVideos(store, id, attachedVideos)
    recordThreadArchives(store, id, attachedArchives)

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
    clearAttachments()
    scheduleContextEstimate(0)
  }

  function addChip(file: { path: string; content: string }): void {
    attachedFiles.push(file)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip'
    const name = document.createElement('span')
    name.className = 'attachment-chip-label'
    const label = file.path.split('/').pop() ?? file.path
    name.textContent = label
    // The label, not the pill: the pill already holds the close button, and a
    // button inside a role="button" is neither valid nor clickable-apart.
    attachTextExpand(name, file.content, label)
    chip.append(name)
    const remove = document.createElement('button')
    remove.append(closeIcon('ui-icon ui-icon-sm'))
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
    remove.append(closeIcon('ui-icon ui-icon-sm'))
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
    attachTextExpand(title, ref.content, ref.label)
    chip.append(shellIcon('shell-chip-icon'), title)
    const remove = document.createElement('button')
    remove.append(closeIcon('ui-icon ui-icon-sm'))
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
    remove.append(closeIcon('ui-icon ui-icon-sm'))
    remove.addEventListener('click', () => {
      attachedVideos = attachedVideos.filter((v) => v.path !== ref.path)
      chip.remove()
      scheduleContextEstimate()
    })
    chip.append(remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  async function addArchiveChip(archive: PromptArchiveAttachment): Promise<void> {
    const projectId = store.getState().activeProjectId
    const threadId = getActiveThreadId()
    if (!projectId || !threadId) return
    let ref: ArchiveAttachmentRef
    try {
      ref = await api.archive.attach(projectId, threadId, {
        name: archive.name,
        ...(archive.bytes ? { bytes: new Uint8Array(archive.bytes) } : {}),
        ...(archive.path ? { path: archive.path } : {}),
      })
    } catch (err) {
      showErrorToast('Could not attach archive', err)
      return
    }
    if (attachedArchives.some((a) => a.path === ref.path)) return
    attachedArchives.push(ref)

    const chip = document.createElement('span')
    chip.className = 'attachment-chip archive-chip'
    const label = document.createElement('span')
    label.className = 'attachment-chip-label'
    label.textContent = ref.name
    // Compressed size, which is what the user recognises from disk. It is not
    // the context cost — the archive costs none until the agent unpacks it and
    // reads something — but it is the honest size of what was attached.
    const meta = document.createElement('span')
    meta.className = 'attachment-chip-meta'
    meta.textContent = formatByteSize(ref.sizeBytes)
    chip.title = `${ref.name} — unpacked and read as files by the agent, not sent as an archive`
    chip.append(attachmentIcon('archive', 'archive-chip-icon'), label, meta)
    const remove = document.createElement('button')
    remove.append(closeIcon('ui-icon ui-icon-sm'))
    remove.addEventListener('click', () => {
      attachedArchives = attachedArchives.filter((a) => a.path !== ref.path)
      chip.remove()
      scheduleContextEstimate()
    })
    chip.append(remove)
    chips.append(chip)
    scheduleContextEstimate()
  }

  function addImageChip(dataUrl: string, mimeType: string): void {
    const entry: AttachedImage = { dataUrl, mimeType }
    attachedImages.push(entry)
    const chip = document.createElement('span')
    chip.className = 'attachment-chip image-chip'
    const thumb = document.createElement('img')
    thumb.src = dataUrl
    thumb.width = 40
    thumb.height = 40
    const remove = document.createElement('button')
    remove.append(closeIcon('ui-icon ui-icon-sm'))
    remove.addEventListener('click', () => {
      attachedImages = attachedImages.filter((i) => i !== entry)
      chip.remove()
      void refreshImageCompatibilityWarning()
      scheduleContextEstimate()
    })
    // Fidelity is per image, so it is chosen on the image rather than in
    // Settings: a stack trace in one chip and a frame in the next want
    // opposite answers, and only the person attaching them knows which.
    const applyDetail = (detail: ImageDetail): void => {
      entry.detail = detail
      chip.dataset['detail'] = detail
      chip.title = IMAGE_DETAIL_LABELS[detail]
      scheduleContextEstimate()
    }
    applyDetail('auto')
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(
        e.clientX,
        e.clientY,
        IMAGE_DETAILS.map((detail) => ({
          // The shared menu has no checked state, so the current choice is
          // marked in the label rather than by changing that component.
          label: `${(entry.detail ?? 'auto') === detail ? '✓ ' : '  '}${IMAGE_DETAIL_LABELS[detail]}`,
          onSelect: (): void => {
            applyDetail(detail)
          },
        })),
      )
    })
    chip.append(thumb, remove)
    chips.append(chip)
    void refreshImageCompatibilityWarning()
    scheduleContextEstimate()
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = (): void => {
        res(expectString(r.result))
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
    attachArchive: addArchiveChip,
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
    void attachFiles(
      files,
      attachmentHandlers,
      api,
      store.getState().workspaceRoot,
      getActiveThreadOwner(store),
    )
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
    () => ({
      workspaceRoot: store.getState().workspaceRoot,
      owner: getActiveThreadOwner(store),
    }),
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
    // A scheduled automation consumes the draft it was created with, clearing
    // it once the prompt is dispatched (controller/automations.ts).
    // `syncComposerThread` only reads `draftPrompt` on a thread *switch*, so
    // without this the already-sent prompt stays sitting in the composer of the
    // thread the user is watching — one Enter away from sending it twice.
    // Echoes of the composer's own autosave compare equal and are ignored.
    store.on('thread_draft_changed', (tid) => {
      if (tid !== activeComposerThreadId) return
      const draft = getThreadById(store, tid)?.draftPrompt ?? ''
      if (draft === composer.expandedValue()) return
      composer.value = draft
      scheduleContextEstimate(0)
    }),
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
      refreshModelPricing()
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
  refreshModelPricing()
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
