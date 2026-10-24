import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { createApiKeysSection } from '../setup/api-keys-section.ts'
import { createModelsAgentsList } from '../setup/models-agents-list.ts'
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
export function createProvidersSection(
  overlay: HTMLElement,
  api: ApiClient,
  opts: {
    /** Close Settings and run an install or sign-in command in a fresh terminal. */
    runInTerminal?: (command: string) => void
  } = {},
): ProvidersSection {
  let activeSignal: AbortSignal | undefined
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

  // One Models & agents list covers every way Copse can reach a model: a
  // ChatGPT plan, agents installed on this machine, API keys (with the cloud
  // agents some of them unlock) and model servers you run yourself. The
  // cloud-agent auth panels and their shared run options are built in the
  // template (their checkboxes must live in this form to round-trip) and
  // relocated by the list into the Anthropic or Cursor key's Options. LM Studio
  // keeps its bespoke server UI as a native model server; the dialog holds onto
  // that handle for getUrl()/saveConnection() in the security-bundle save below.
  const lmStudioSection = createLmStudioSection(api, {
    showInstallGuide: false,
    loadOnMount: false,
  })
  const modelsList = createModelsAgentsList(api, {
    nativeLocalProviders: [
      {
        id: 'lmstudio',
        label: 'LM Studio',
        element: lmStudioSection.root,
        refresh: (): Promise<void> => lmStudioSection.refreshDetection(activeSignal),
      },
    ],
    cloudAgents: [
      { provider: 'cursor', element: qsRequired(overlay, '#settings-cursor-panel') },
      { provider: 'anthropic', element: qsRequired(overlay, '#settings-claude-panel') },
    ],
    cloudAgentOptions: qsRequired(overlay, '#settings-cloud-agent-options'),
    ...(opts.runInTerminal ? { runInTerminal: opts.runInTerminal } : {}),
    onKeysChanged: () => {
      for (const section of [cursorKeySection, claudeAgentKeySection])
        void section.refreshKeyStatus(activeSignal)
    },
  })
  qsRequired(overlay, '#settings-agents-host').append(modelsList.root)

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
        modelsList.refresh(snapshot, signal),
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
        ...modelsList.readUpdate(),
        ...(dirty.has('githubBackend') &&
        (backend === 'auto' || backend === 'cli' || backend === 'api')
          ? { githubBackend: backend }
          : {}),
      }
    },
    markDirty(target: HTMLElement): void {
      for (const section of [...keySections, modelsList, lmStudioSection])
        if (section.root.contains(target)) dirty.add(section.root)
    },
    async saveKeys(): Promise<boolean> {
      for (const section of keySections)
        if (dirty.has(section.root) && !(await section.saveKeys())) return false
      if (dirty.has(modelsList.root) && !(await modelsList.saveKeys())) return false
      if (dirty.has(lmStudioSection.root)) await lmStudioSection.saveApiKey()
      return true
    },
    reset(): void {
      activeSignal = undefined
      dirty.clear()
      for (const section of keySections) section.reset()
      modelsList.reset()
      for (const input of lmStudioSection.root.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
      ))
        input.value = ''
    },
    getUrl: lmStudioSection.getUrl,
  }
}
