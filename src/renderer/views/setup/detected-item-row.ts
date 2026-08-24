// One row of "something detected on this machine", shared by the Settings
// env-key scan list and the onboarding checklist so masked-key display, labels,
// and statuses stay consistent between the two surfaces. Emits the established
// `.env-key-*` classes so the existing settings CSS applies unchanged; the
// optional leading checkbox is the onboarding addition.

import { el } from '../../dom/helpers.ts'

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

export function providerLabel(slug: string): string {
  return PROVIDER_LABELS[slug] ?? slug
}

export type DetectedItemKind = 'env-key' | 'local-server' | 'acp-agent'

export interface DetectedItemRow {
  root: HTMLElement
  /** Present only when the row was built with a `checkbox` option. */
  checkbox: HTMLInputElement | null
}

export function createDetectedItemRow(opts: {
  kind: DetectedItemKind
  /** Stable id for selection/tests (provider slug, server slug, agent id). */
  id: string
  label: string
  /** Where/how it was found (env var + file, base URL, resolved path). */
  detail: string
  /** Masked secret preview, when the item is a key. */
  masked?: string
  status?: { text: string; ok?: boolean }
  /** Omit for a purely informational row (nothing to select). */
  checkbox?: { checked: boolean; disabled?: boolean }
}): DetectedItemRow {
  let checkbox: HTMLInputElement | null = null
  if (opts.checkbox) {
    checkbox = el('input', {
      type: 'checkbox',
      class: 'detected-item-check',
      'aria-label': `Use ${opts.label}`,
    })
    checkbox.checked = opts.checkbox.checked
    checkbox.disabled = opts.checkbox.disabled ?? false
  }
  const root = el(
    'div',
    { class: 'env-key-row detected-item-row' },
    ...(checkbox ? [checkbox] : []),
    el('span', { class: 'env-key-provider' }, opts.label),
    el('span', { class: 'env-key-source' }, opts.detail),
    ...(opts.masked ? [el('span', { class: 'env-key-masked' }, opts.masked)] : []),
    ...(opts.status
      ? [el('span', { class: opts.status.ok ? 'key-status ok' : 'key-status' }, opts.status.text)]
      : []),
  )
  root.dataset['kind'] = opts.kind
  root.dataset['id'] = opts.id
  return { root, checkbox }
}
