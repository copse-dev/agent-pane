import type { ApiClient } from '../../../preload/api.d.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
import { LM_STUDIO_DOWNLOAD_URL } from '@shared/lm-studio-defaults.ts'
import { el } from '../../dom/helpers.ts'

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
  return `${bytes} B`
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
  }) as HTMLInputElement
  const keyInput = el('input', {
    type: 'password',
    name: 'lmStudioKey',
    placeholder: 'leave blank if disabled',
    autocomplete: 'off',
  }) as HTMLInputElement
  const keyStatus = el('span', { class: 'key-status', 'data-key': 'lmstudio' })
  const testStatus = el('span', { class: 'lmstudio-test-status', id: 'lmstudio-test-status' })
  const detectionStatus = el('div', { class: 'setup-detection-status' })
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
              { href: LM_STUDIO_DOWNLOAD_URL, target: '_blank', rel: 'noopener' },
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
    testStatus.textContent = 'Testing…'
    testStatus.className = 'lmstudio-test-status'
    const result = await api.lmStudio.test(urlInput.value.trim(), keyInput.value.trim())
    if (result.ok) {
      const list =
        result.models && result.models.length
          ? result.models.slice(0, 3).join(', ')
          : 'no models loaded'
      testStatus.textContent = `✓ Connected — ${result.models?.length ?? 0} model(s): ${list}`
      testStatus.classList.add('ok')
      await refreshDetection()
    } else {
      testStatus.textContent = `✗ ${result.error ?? 'Connection failed'}`
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
      const status = el(
        'span',
        { class: present ? 'preferred-model-status ok' : 'preferred-model-status' },
        present ? '✓ Available' : '○ Not loaded',
      )
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
          progress.textContent = 'Starting download…'
          void api.lmStudio
            .download(model.id, urlInput.value.trim(), keyInput.value.trim())
            .then((job) => {
              if (!job.ok) {
                progress.textContent = `✗ ${job.error ?? 'Download failed'}`
                downloadBtn.disabled = false
                return
              }
              if (job.status === 'already_downloaded') {
                progress.textContent = '✓ Already downloaded — load it in LM Studio'
                return
              }
              if (!job.jobId) {
                progress.textContent = `✓ ${job.status ?? 'started'}`
                return
              }
              const eta = formatDownloadEta(model.downloadGb)
              const sizeHint = job.totalSizeBytes
                ? formatBytes(job.totalSizeBytes)
                : `~${model.downloadGb} GB`
              progress.textContent = `Downloading ${sizeHint} — may take ${eta}…`
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
            `~${model.downloadGb} GB · ${formatDownloadEta(model.downloadGb)} once the server is running`,
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
            progressEl.textContent = `✗ ${status.error ?? 'Status check failed'}`
            clearInterval(timer)
            downloadPollers.delete(jobId)
            onDone()
            return
          }
          if (status.status === 'completed' || status.status === 'already_downloaded') {
            progressEl.textContent = '✓ Download complete — load the model in LM Studio'
            clearInterval(timer)
            downloadPollers.delete(jobId)
            onDone()
            return
          }
          if (status.status === 'failed') {
            progressEl.textContent = '✗ Download failed'
            clearInterval(timer)
            downloadPollers.delete(jobId)
            onDone()
            return
          }
          if (status.totalSizeBytes && status.downloadedBytes) {
            const pct = Math.round((status.downloadedBytes / status.totalSizeBytes) * 100)
            progressEl.textContent = `Downloading… ${pct}% (${formatBytes(status.downloadedBytes)} / ${formatBytes(status.totalSizeBytes)})`
          }
        })
    }, 2000)
    downloadPollers.set(jobId, timer)
  }

  async function refreshDetection(): Promise<void> {
    const detection = await api.lmStudio.detect(urlInput.value.trim(), keyInput.value.trim())
    if (detection.serverRunning) {
      detectionStatus.textContent = `✓ LM Studio server reachable at ${detection.serverUrl}`
      detectionStatus.className = 'setup-detection-status ok'
    } else if (detection.installDetected) {
      detectionStatus.textContent =
        'LM Studio is installed but the server is not running. Open LM Studio and start the local server.'
      detectionStatus.className = 'setup-detection-status warn'
    } else {
      detectionStatus.textContent =
        'LM Studio not detected. Install it and start the local server on port 1234.'
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
    await api.settings.setSecurity({
      localServerUrl: lmUrl,
      safetyClassifierEnabled: currentSafetyEnabled ?? true,
      safetyConfidenceThreshold: currentThreshold ?? 0.85,
      safetyModel: opts?.safetyModel ?? currentSafety ?? PREFERRED_MODELS[2]!.id,
      autoRunSandboxCommands: currentAutoRun ?? true,
      mcpAutoAllowReadOnly: currentMcpAuto ?? false,
    })
    keyInput.value = ''
    const lmSet = await api.settings.getKey('lmstudio')
    keyStatus.textContent = lmSet ? '● saved' : '○ not set'
    keyStatus.className = 'key-status'
  }

  void (async () => {
    const lmUrl = (await api.settings.get('localServerUrl')) as string | undefined
    urlInput.value = lmUrl ?? 'http://localhost:1234/v1'
    const lmSet = await api.settings.getKey('lmstudio')
    keyStatus.textContent = lmSet ? '● saved' : '○ not set'
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
