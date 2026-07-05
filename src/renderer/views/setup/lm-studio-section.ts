import type { ApiClient } from '../../../preload/api.d.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
import { at } from '@shared/array-utils.ts'
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  WEB_ALLOWED_ORIGINS_SETTING,
  WEB_ALLOW_USER_APPROVAL_SETTING,
} from '@shared/web-origins.ts'
import {
  LM_STUDIO_CONTEXT_GUIDE_URL,
  RECOMMENDED_MIN_CONTEXT_WINDOW,
  VRAM_CALCULATOR_URL,
  isContextWindowLow,
  lowContextAdvice,
} from '@shared/context-window-advice.ts'
import { el } from '../../dom/helpers.ts'
import { inlineStatus, setInlineStatus } from '../../dom/inline-status.ts'

export interface LmStudioSection {
  root: HTMLElement
  getUrl: () => string
  getApiKey: () => string
  refreshDetection: () => Promise<void>
  saveConnection: (opts?: { safetyModel?: string }) => Promise<void>
  destroy: () => void
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`
  return `${String(bytes)} B`
}

function formatDownloadEta(gb: number): string {
  if (gb >= 20) return '30–60 minutes on a fast connection'
  if (gb >= 4) return '10–20 minutes on a fast connection'
  return '5–10 minutes on a fast connection'
}

export function createLmStudioSection(
  api: ApiClient,
  opts: { showInstallGuide?: boolean } = {},
): LmStudioSection {
  const showInstallGuide = opts.showInstallGuide ?? true

  const urlInput = el('input', {
    type: 'text',
    name: 'localServerUrl',
    placeholder: 'http://localhost:1234/v1',
    autocomplete: 'off',
  })
  const keyInput = el('input', {
    type: 'password',
    name: 'lmStudioKey',
    placeholder: 'leave blank if disabled',
    autocomplete: 'off',
  })
  const keyStatus = el('span', { class: 'key-status', 'data-key': 'lmstudio' })
  const testStatus = el('span', { class: 'lmstudio-test-status', id: 'lmstudio-test-status' })
  const detectionStatus = el('div', { class: 'setup-detection-status' })
  const contextAdvisory = el('div', { class: 'setup-context-advisory', hidden: 'true' })
  const preferredList = el('div', { class: 'preferred-models-list' })

  const testBtn = el('button', { type: 'button', class: 'setup-test-btn' }, 'Test connection')
  testBtn.addEventListener('click', () => {
    void runTest()
  })

  const connectionFieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Server connection'),
    el('label', {}, 'Server URL', urlInput),
    el('label', {}, 'API key (only if your server requires one)', keyInput, keyStatus),
    el('div', { class: 'lmstudio-test-row' }, testBtn, testStatus),
    contextAdvisory,
  )

  const installGuide = showInstallGuide
    ? el(
        'div',
        { class: 'setup-install-guide' },
        el('h4', {}, 'Don’t have LM Studio yet?'),
        el(
          'ol',
          { class: 'setup-steps' },
          el(
            'li',
            {},
            'Download ',
            el(
              'a',
              { href: 'https://lmstudio.ai', target: '_blank', rel: 'noopener' },
              'LM Studio',
            ),
            ' for your platform.',
          ),
          el(
            'li',
            {},
            'Open LM Studio and download the recommended models below (or let Copse fetch them).',
          ),
          el(
            'li',
            {},
            'Start the local server: Developer tab → toggle “Start server” (default port 1234).',
          ),
          el('li', {}, 'Return here and click Test connection.'),
        ),
      )
    : null

  const preferredFieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Recommended local models'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Copse works best with local models for everyday tasks and cloud models for hard problems. We recommend installing all three.',
    ),
    detectionStatus,
    preferredList,
  )

  const root = el('div', { class: 'setup-lm-studio' }, connectionFieldset, preferredFieldset)
  if (installGuide) root.prepend(installGuide)

  const downloadPollers = new Map<string, ReturnType<typeof setInterval>>()

  function stopAllPollers(): void {
    for (const timer of downloadPollers.values()) clearInterval(timer)
    downloadPollers.clear()
  }

  async function runTest(): Promise<void> {
    setInlineStatus(testStatus, 'pending', 'Testing…')
    testStatus.className = 'lmstudio-test-status'
    const result = await api.lmStudio.test(urlInput.value.trim(), keyInput.value.trim())
    if (result.ok) {
      const list =
        result.models && result.models.length
          ? result.models.slice(0, 3).join(', ')
          : 'no models loaded'
      setInlineStatus(
        testStatus,
        'ok',
        `Connected — ${String(result.models?.length ?? 0)} model(s): ${list}`,
      )
      testStatus.classList.add('ok')
      await refreshDetection()
    } else {
      setInlineStatus(testStatus, 'error', result.error ?? 'Connection failed')
      testStatus.classList.add('err')
    }
  }

  function renderPreferredModels(
    detection: Awaited<ReturnType<ApiClient['lmStudio']['detect']>>,
  ): void {
    preferredList.replaceChildren()
    for (const model of PREFERRED_MODELS) {
      const present = detection.models.includes(model.id)
      const row = el('div', { class: 'preferred-model-row' })
      const status = el('span', {
        class: present ? 'preferred-model-status ok' : 'preferred-model-status',
      })
      status.append(inlineStatus(present ? 'ok' : 'pending', present ? 'Available' : 'Not loaded'))
      const meta = el(
        'div',
        { class: 'preferred-model-meta' },
        el('strong', {}, model.id),
        el('span', { class: 'field-hint' }, model.description),
      )

      row.append(meta, status)

      if (!present && detection.serverRunning) {
        const downloadBtn = el(
          'button',
          { type: 'button', class: 'setup-download-btn' },
          'Download',
        )
        const progress = el('span', { class: 'download-progress' })
        downloadBtn.addEventListener('click', () => {
          downloadBtn.disabled = true
          setInlineStatus(progress, 'pending', 'Starting download…')
          void api.lmStudio
            .download(model.id, urlInput.value.trim(), keyInput.value.trim())
            .then((job) => {
              if (!job.ok) {
                setInlineStatus(progress, 'error', job.error ?? 'Download failed')
                downloadBtn.disabled = false
                return
              }
              if (job.status === 'already_downloaded') {
                setInlineStatus(progress, 'ok', 'Already downloaded — load it in LM Studio')
                return
              }
              if (!job.jobId) {
                setInlineStatus(progress, 'ok', job.status ?? 'started')
                return
              }
              const eta = formatDownloadEta(model.downloadGb)
              const sizeHint = job.totalSizeBytes
                ? formatBytes(job.totalSizeBytes)
                : `~${String(model.downloadGb)} GB`
              setInlineStatus(progress, 'pending', `Downloading ${sizeHint} — may take ${eta}…`)
              pollDownload(job.jobId, progress, () => {
                downloadBtn.disabled = false
                void refreshDetection()
              })
            })
        })
        row.append(downloadBtn, progress)
      } else if (!present && !detection.serverRunning) {
        row.append(
          el(
            'span',
            { class: 'field-hint' },
            `~${String(model.downloadGb)} GB · ${formatDownloadEta(model.downloadGb)} once the server is running`,
          ),
        )
      }

      preferredList.append(row)
    }
  }

  function pollDownload(jobId: string, progressEl: HTMLElement, onDone: () => void): void {
    const existing = downloadPollers.get(jobId)
    if (existing) clearInterval(existing)

    const timer = setInterval(() => {
      void api.lmStudio
        .downloadStatus(jobId, urlInput.value.trim(), keyInput.value.trim())
        .then((status) => {
          if (!status.ok) {
            setInlineStatus(progressEl, 'error', status.error ?? 'Status check failed')
            clearInterval(timer)
            downloadPollers.delete(jobId)
            onDone()
            return
          }
          if (status.status === 'completed' || status.status === 'already_downloaded') {
            setInlineStatus(progressEl, 'ok', 'Download complete — load the model in LM Studio')
            clearInterval(timer)
            downloadPollers.delete(jobId)
            onDone()
            return
          }
          if (status.status === 'failed') {
            setInlineStatus(progressEl, 'error', 'Download failed')
            clearInterval(timer)
            downloadPollers.delete(jobId)
            onDone()
            return
          }
          if (status.totalSizeBytes && status.downloadedBytes) {
            const pct = Math.round((status.downloadedBytes / status.totalSizeBytes) * 100)
            setInlineStatus(
              progressEl,
              'pending',
              `Downloading… ${String(pct)}% (${formatBytes(status.downloadedBytes)} / ${formatBytes(status.totalSizeBytes)})`,
            )
          }
        })
    }, 2000)
    downloadPollers.set(jobId, timer)
  }

  function renderContextAdvisory(modelContexts: Record<string, number>): void {
    // Surface advice for the lowest-context loaded model, if any are too small to
    // serve as a main chat default (LM Studio often loads models at a tiny default).
    let worstId: string | null = null
    let worstCtx = Infinity
    for (const [id, ctx] of Object.entries(modelContexts)) {
      if (isContextWindowLow(ctx) && ctx < worstCtx) {
        worstCtx = ctx
        worstId = id
      }
    }
    if (worstId === null) {
      contextAdvisory.replaceChildren()
      contextAdvisory.hidden = true
      return
    }
    const advice = lowContextAdvice(worstCtx, { modelId: worstId })
    contextAdvisory.replaceChildren(
      el('strong', {}, 'Low context window'),
      el('p', {}, advice ?? ''),
      el(
        'p',
        {},
        'Context length resets when you restart? See the ',
        el(
          'a',
          { href: LM_STUDIO_CONTEXT_GUIDE_URL, target: '_blank', rel: 'noopener' },
          'guide to making it restart-proof',
        ),
        '.',
      ),
      el(
        'p',
        {},
        'Need to size context against your hardware? Try the ',
        el(
          'a',
          { href: VRAM_CALCULATOR_URL, target: '_blank', rel: 'noopener' },
          'VRAM calculator',
        ),
        `. Aim for at least ${String(RECOMMENDED_MIN_CONTEXT_WINDOW / 1024)}K tokens.`,
      ),
    )
    contextAdvisory.hidden = false
  }

  async function refreshDetection(): Promise<void> {
    const detection = await api.lmStudio.detect(urlInput.value.trim(), keyInput.value.trim())
    renderContextAdvisory(detection.modelContexts)
    if (detection.serverRunning) {
      setInlineStatus(detectionStatus, 'ok', `LM Studio server reachable at ${detection.serverUrl}`)
      detectionStatus.className = 'setup-detection-status ok'
    } else if (detection.installDetected) {
      setInlineStatus(
        detectionStatus,
        'warn',
        'LM Studio is installed but the server is not running. Open LM Studio and start the local server.',
      )
      detectionStatus.className = 'setup-detection-status warn'
    } else {
      setInlineStatus(
        detectionStatus,
        'error',
        'LM Studio not detected. Install it and start the local server on port 1234.',
      )
      detectionStatus.className = 'setup-detection-status err'
    }
    renderPreferredModels(detection)
  }

  async function saveConnection(opts?: { safetyModel?: string }): Promise<void> {
    const lmKey = keyInput.value.trim()
    if (lmKey) await api.settings.setKey('lmstudio', lmKey)
    const lmUrl = urlInput.value.trim()
    const currentSafety = (await api.settings.get('safetyModel')) as string | undefined
    const currentThreshold = (await api.settings.get('safetyConfidenceThreshold')) as
      | number
      | undefined
    const currentSafetyEnabled = (await api.settings.get('safetyClassifierEnabled')) as
      | boolean
      | undefined
    const currentAutoRun = (await api.settings.get('autoRunSandboxCommands')) as boolean | undefined
    const currentMcpAuto = (await api.settings.get('mcpAutoAllowReadOnly')) as boolean | undefined
    const currentReadonly = (await api.settings.get('defaultReadonlyMode')) as boolean | undefined
    const currentWebOrigins = (await api.settings.get(WEB_ALLOWED_ORIGINS_SETTING)) as
      | string[]
      | undefined
      | null
    const currentWebApproval = (await api.settings.get(WEB_ALLOW_USER_APPROVAL_SETTING)) as
      | boolean
      | undefined
    await api.settings.setSecurity({
      localServerUrl: lmUrl,
      safetyClassifierEnabled: currentSafetyEnabled ?? true,
      safetyConfidenceThreshold: currentThreshold ?? 0.85,
      safetyModel: opts?.safetyModel ?? currentSafety ?? at(PREFERRED_MODELS, 2).id,
      autoRunSandboxCommands: currentAutoRun ?? true,
      mcpAutoAllowReadOnly: currentMcpAuto ?? false,
      defaultReadonlyMode: currentReadonly ?? false,
      webAllowedOrigins: currentWebOrigins?.length
        ? currentWebOrigins
        : [...DEFAULT_WEB_ALLOWED_ORIGINS],
      webAllowUserApproval: currentWebApproval ?? true,
    })
    keyInput.value = ''
    const lmSet = await api.settings.getKey('lmstudio')
    setInlineStatus(keyStatus, lmSet ? 'filled' : 'pending', lmSet ? 'saved' : 'not set')
    keyStatus.className = 'key-status'
  }

  void (async (): Promise<void> => {
    const lmUrl = (await api.settings.get('localServerUrl')) as string | undefined
    urlInput.value = lmUrl ?? 'http://localhost:1234/v1'
    const lmSet = await api.settings.getKey('lmstudio')
    setInlineStatus(keyStatus, lmSet ? 'filled' : 'pending', lmSet ? 'saved' : 'not set')
    await refreshDetection()
  })()

  return {
    root,
    getUrl: () => urlInput.value.trim(),
    getApiKey: () => keyInput.value.trim(),
    refreshDetection,
    saveConnection,
    destroy: stopAllPollers,
  }
}
