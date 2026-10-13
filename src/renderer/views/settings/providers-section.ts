import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { createApiKeysSection } from '../setup/api-keys-section.ts'
import { createProvidersPanel } from '../setup/providers-section.ts'
import { createEnvKeyDetectSection } from '../setup/env-key-detect-section.ts'
import { createLmStudioSection } from '../setup/lm-studio-section.ts'
import { createGhCliSection } from '../setup/gh-cli-section.ts'
export interface ProvidersSection {
  refresh(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void>
  collect(data: FormData, dirty: ReadonlySet<string>): SettingsUpdate
  refreshAgent(signal: AbortSignal): Promise<void>
  refreshUsage(signal: AbortSignal): Promise<void>
  load(snapshot: SettingsSnapshot): void
  markDirty(target: HTMLElement): void
  saveKeys(): Promise<boolean>
  reset(): void
  getUrl(): string
}
export function createProvidersSection(overlay: HTMLElement, api: ApiClient): ProvidersSection {
  let activeSignal: AbortSignal | undefined
  const envKeyDetectSection = createEnvKeyDetectSection(api, {
    legend: 'Detected settings',
    onImported: () => {
      void cursorKeySection.refreshKeyStatus(activeSignal)
      void providersPanel.refresh(undefined, activeSignal)
    },
  })
  qsRequired(overlay, '#settings-env-detect-host').append(envKeyDetectSection.root)

  const cursorKeySection = createApiKeysSection(api, {
    legend: 'Cursor authentication',
    providers: ['cursor'],
  })
  qsRequired(overlay, '#settings-cursor-key-host').append(cursorKeySection.root)

  // The GitHub token has no validation endpoint, so skip on-input validation for
  // this section (the Anthropic key still shows a saved/not-set status).
  const claudeAgentKeySection = createApiKeysSection(api, {
    legend: 'Claude authentication',
    providers: ['anthropic', 'github'],
    validateOnInput: false,
  })
  qsRequired(overlay, '#settings-claude-agent-key-host').append(claudeAgentKeySection.root)

  // Metadata-service key (not an LLM provider): live Intelligence Index data
  // for the model value map on the Usage page. No validation endpoint.
  const aaKeySection = createApiKeysSection(api, {
    legend: 'Model intelligence data',
    providers: ['artificial-analysis'],
    validateOnInput: false,
  })
  qsRequired(overlay, '#settings-aa-key-host').append(aaKeySection.root)

  // One Providers panel covers every way Copse can reach a model: API keys, cloud
  // agents, agents installed on this machine, and model servers you run yourself.
  // The cloud-agent auth panels and their shared run options are built in the
  // template above (their checkboxes must live in this form to round-trip) and
  // relocated by the panel into whichever provider offers a cloud agent. LM Studio
  // keeps its bespoke server UI as a native local provider; the dialog holds onto
  // that handle for getUrl()/saveConnection() in the security-bundle save below.
  const lmStudioSection = createLmStudioSection(api, {
    showInstallGuide: false,
    loadOnMount: false,
  })
  const providersPanel = createProvidersPanel(api, {
    nativeLocalProviders: [
      {
        id: 'lmstudio',
        label: 'LM Studio',
        element: lmStudioSection.root,
        refresh: (): Promise<void> => lmStudioSection.refreshDetection(activeSignal),
      },
    ],
    showOpenAiServiceTier: true,
    deferOrdinaryWrites: true,
    cloudAgents: [
      {
        vendor: 'cursor',
        element: qsRequired(overlay, '#settings-cursor-panel'),
        keySlugs: ['cursor'],
      },
      {
        vendor: 'anthropic',
        element: qsRequired(overlay, '#settings-claude-panel'),
        keySlugs: ['anthropic', 'github'],
      },
    ],
    cloudAgentOptions: qsRequired(overlay, '#settings-cloud-agent-options'),
  })
  qsRequired(overlay, '#settings-providers-host').append(providersPanel.root)

  const ghCliSection = createGhCliSection(api, { deferOrdinaryWrites: true })
  qsRequired(overlay, '#settings-gh-cli-host').append(ghCliSection.root)

  const dirty = new Set<HTMLElement>()
  const keySections = [cursorKeySection, claudeAgentKeySection, aaKeySection]
  return {
    async refresh(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void> {
      activeSignal = signal
      await Promise.all([
        ...[cursorKeySection, claudeAgentKeySection].map((section) =>
          section.refreshKeyStatus(signal),
        ),
        envKeyDetectSection.refresh(signal),
        providersPanel.refresh(snapshot, signal),
      ])
    },
    refreshAgent: (signal): Promise<void> => ghCliSection.refreshStatus(signal),
    refreshUsage: (signal): Promise<void> => aaKeySection.refreshKeyStatus(signal),
    load: (snapshot): void => {
      ghCliSection.load(snapshot)
      lmStudioSection.load(snapshot)
    },
    collect: (data, dirty): SettingsUpdate => {
      const backend = data.get('githubBackend')
      return {
        ...providersPanel.readUpdate(),
        ...(dirty.has('githubBackend') &&
        (backend === 'auto' || backend === 'cli' || backend === 'api')
          ? { githubBackend: backend }
          : {}),
      }
    },
    markDirty(target: HTMLElement): void {
      for (const section of [...keySections, providersPanel, lmStudioSection])
        if (section.root.contains(target)) dirty.add(section.root)
    },
    async saveKeys(): Promise<boolean> {
      for (const section of keySections)
        if (dirty.has(section.root) && !(await section.saveKeys())) return false
      if (dirty.has(providersPanel.root) && !(await providersPanel.saveKeys())) return false
      if (dirty.has(lmStudioSection.root)) await lmStudioSection.saveApiKey()
      return true
    },
    reset(): void {
      activeSignal = undefined
      dirty.clear()
      for (const section of keySections) section.reset()
      providersPanel.reset()
      for (const input of lmStudioSection.root.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
      ))
        input.value = ''
    },
    getUrl: lmStudioSection.getUrl,
  }
}
