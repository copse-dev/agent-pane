import type { ApiClient, DetectedEnvKey } from '../../../preload/api.d.ts'
import { el, clear } from '../../dom/helpers.ts'

// Friendly labels for the provider slugs the scan can surface. Falls back to the
// raw slug for anything not listed.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  cursor: 'Cursor',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  huggingface: 'Hugging Face',
  lmstudio: 'LM Studio',
}

function providerLabel(slug: string): string {
  return PROVIDER_LABELS[slug] ?? slug
}

export interface EnvKeyDetectSection {
  root: HTMLFieldSetElement
  /** Reload the persisted consent state (call when the host dialog opens). */
  refresh: () => Promise<void>
}

/**
 * Opt-in "detect API keys from my environment" control, shared by first-run
 * setup and Settings. The user must tick the consent checkbox before the scan
 * button is enabled; scanning shows a masked preview of what was found, and a
 * single click then imports any keys for providers that aren't already
 * configured. Raw secrets stay in the main process throughout.
 */
export function createEnvKeyDetectSection(
  api: ApiClient,
  opts: { legend?: string; onImported?: () => void } = {},
): EnvKeyDetectSection {
  const legend = opts.legend ?? 'Detect existing API keys'

  const consent = el('input', {
    type: 'checkbox',
    name: 'envKeyAutoDetectEnabled',
  }) as HTMLInputElement

  const consentLabel = el(
    'label',
    { class: 'checkbox-label' },
    consent,
    'Let Copse look for API keys in my shell environment',
  )

  const scanBtn = el(
    'button',
    { type: 'button', disabled: true },
    'Scan environment',
  ) as HTMLButtonElement
  const importBtn = el(
    'button',
    {
      type: 'button',
      class: 'onboarding-primary',
      hidden: true,
    },
    'Import keys',
  ) as HTMLButtonElement

  const status = el('span', { class: 'key-status' }) as HTMLElement
  const results = el('div', { class: 'env-key-results' }) as HTMLElement
  const actions = el('div', { class: 'env-key-actions' }, scanBtn, importBtn, status)

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, legend),
    el(
      'p',
      { class: 'field-hint' },
      'Reads your exported environment and shell start-up files (e.g. ~/.zshrc, ~/.bashrc) ' +
        'for keys like ANTHROPIC_API_KEY or OPENAI_API_KEY and saves any it finds. ' +
        'Nothing is read until you opt in, and existing keys are never overwritten.',
    ),
    consentLabel,
    actions,
    results,
  ) as HTMLFieldSetElement

  function setStatus(text: string, kind: 'ok' | 'err' | '' = ''): void {
    status.textContent = text
    status.className = kind ? `key-status ${kind}` : 'key-status'
  }

  function syncEnabled(): void {
    scanBtn.disabled = !consent.checked
    if (!consent.checked) {
      importBtn.hidden = true
      clear(results)
      setStatus('')
    }
  }

  function renderDetections(detected: readonly DetectedEnvKey[]): void {
    clear(results)
    const importable = detected.filter((d) => !d.alreadyConfigured)
    if (detected.length === 0) {
      setStatus('No provider keys found in your environment.', '')
      importBtn.hidden = true
      return
    }
    for (const d of detected) {
      const row = el(
        'div',
        { class: 'env-key-row' },
        el('span', { class: 'env-key-provider' }, providerLabel(d.provider)),
        el('span', { class: 'env-key-source' }, `${d.envVar} · ${d.source}`),
        el('span', { class: 'env-key-masked' }, d.masked),
        el(
          'span',
          { class: d.alreadyConfigured ? 'key-status' : 'key-status ok' },
          d.alreadyConfigured ? 'already set' : 'will import',
        ),
      )
      results.append(row)
    }
    importBtn.hidden = importable.length === 0
    importBtn.textContent =
      importable.length === 1 ? 'Import 1 key' : `Import ${importable.length} keys`
    setStatus(
      importable.length > 0
        ? `Found ${importable.length} new key${importable.length === 1 ? '' : 's'}.`
        : 'All detected keys are already configured.',
    )
  }

  consent.addEventListener('change', () => {
    void api.settings.set('envKeyAutoDetectEnabled', consent.checked)
    syncEnabled()
  })

  scanBtn.addEventListener('click', () => {
    void (async () => {
      scanBtn.disabled = true
      setStatus('Scanning…')
      try {
        const detected = await api.settings.scanEnvKeys()
        renderDetections(detected)
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Scan failed', 'err')
      } finally {
        scanBtn.disabled = !consent.checked
      }
    })()
  })

  importBtn.addEventListener('click', () => {
    void (async () => {
      importBtn.disabled = true
      setStatus('Importing…')
      try {
        const { imported } = await api.settings.importEnvKeys()
        setStatus(
          imported.length === 0
            ? 'Nothing new to import.'
            : `Imported ${imported.length} key${imported.length === 1 ? '' : 's'}.`,
          'ok',
        )
        // Re-scan so rows flip to "already set" and the import button hides.
        renderDetections(await api.settings.scanEnvKeys())
        opts.onImported?.()
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Import failed', 'err')
      } finally {
        importBtn.disabled = false
      }
    })()
  })

  async function refresh(): Promise<void> {
    const enabled = (await api.settings.get('envKeyAutoDetectEnabled')) as boolean | null
    consent.checked = enabled === true
    syncEnabled()
  }

  return { root: fieldset, refresh }
}
