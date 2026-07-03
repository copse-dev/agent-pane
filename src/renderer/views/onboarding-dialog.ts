import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { at } from '@shared/array-utils.ts'
import { qsRequired } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '@shared/lm-studio-defaults.ts'
import { createApiKeysSection } from './setup/api-keys-section.ts'
import { createEnvKeyDetectSection } from './setup/env-key-detect-section.ts'
import { createLmStudioSection } from './setup/lm-studio-section.ts'
import { createModelRoutingSection } from './setup/model-routing-section.ts'
import { detectLocalServers, importDetectedPreset } from './setup/local-detection.ts'
import { el, clear } from '../dom/helpers.ts'

type OnboardingStep = 'welcome' | 'cloud' | 'local' | 'routing'

let overlayEl: HTMLElement | null = null

export function openOnboardingDialog(): void {
  if (!overlayEl || !overlayEl.hidden) return
  overlayEl.hidden = false
  overlayEl.dispatchEvent(new Event('onboarding-open'))
}

export function closeOnboardingDialog(): void {
  if (!overlayEl || overlayEl.hidden) return
  overlayEl.hidden = true
}

export function isOnboardingDialogOpen(): boolean {
  return !!overlayEl && !overlayEl.hidden
}

export async function shouldShowOnboarding(api: ApiClient): Promise<boolean> {
  const completed = (await api.settings.get('onboardingCompleted')) as boolean | null
  return completed !== true
}

export function mountOnboardingDialog(store: AppStore, api: ApiClient): void {
  const overlay = document.createElement('div')
  overlay.id = 'onboarding-dialog'
  overlay.className = 'onboarding-overlay settings-overlay'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="onboarding-shell settings-shell">
      <header class="settings-header onboarding-header">
        <h2>Welcome to Copse</h2>
        <button type="button" class="settings-close-btn" id="onboarding-close" aria-label="Close setup"></button>
      </header>

      <p class="onboarding-tagline">
        Set up models once — use local LLMs for everyday work and cloud models when you need them.
      </p>

      <nav class="onboarding-steps" aria-label="Setup steps">
        <button type="button" class="onboarding-step-btn active" data-step="welcome">1. Intro</button>
        <button type="button" class="onboarding-step-btn" data-step="cloud">2. Cloud keys</button>
        <button type="button" class="onboarding-step-btn" data-step="local">3. Local models</button>
        <button type="button" class="onboarding-step-btn" data-step="routing">4. Routing</button>
      </nav>

      <div class="onboarding-body">
        <section class="onboarding-panel active" data-step="welcome"></section>
        <section class="onboarding-panel" data-step="cloud"></section>
        <section class="onboarding-panel" data-step="local"></section>
        <section class="onboarding-panel" data-step="routing"></section>
      </div>

      <footer class="onboarding-footer">
        <button type="button" class="onboarding-skip" id="onboarding-skip">Skip for now</button>
        <div class="onboarding-nav-buttons">
          <button type="button" id="onboarding-back" disabled>Back</button>
          <button type="button" id="onboarding-next" class="onboarding-primary">Continue</button>
        </div>
      </footer>
    </div>
  `
  document.body.append(overlay)
  overlayEl = overlay

  const stepOrder: OnboardingStep[] = ['welcome', 'cloud', 'local', 'routing']
  let currentStep: OnboardingStep = 'welcome'

  const stepBtns = overlay.querySelectorAll<HTMLButtonElement>('.onboarding-step-btn')
  const panels = overlay.querySelectorAll<HTMLElement>('.onboarding-panel')
  const backBtn = qsRequired<HTMLButtonElement>(overlay, '#onboarding-back')
  const nextBtn = qsRequired<HTMLButtonElement>(overlay, '#onboarding-next')

  const welcomePanel = qsRequired(overlay, '.onboarding-panel[data-step="welcome"]')
  welcomePanel.innerHTML = `
    <h3>A different kind of coding assistant</h3>
    <p class="settings-section-desc">
      Most AI editors rely almost entirely on frontier cloud models. Copse is built for a hybrid approach:
      fast, private local models handle exploration, titles, and safety checks, while cloud models tackle
      the hardest problems when you add API keys.
    </p>
    <ul class="onboarding-benefits">
      <li><strong>Local first</strong> — LM Studio runs Qwen, Gemma, and other open models on your machine.</li>
      <li><strong>Cloud when it counts</strong> — Optional Anthropic and OpenAI keys unlock Claude and GPT-4o.</li>
      <li><strong>Best of both</strong> — We recommend configuring both so Copse can route each task to the right model.</li>
    </ul>
    <p class="field-hint">This setup takes a few minutes. You can revisit it anytime in Settings.</p>
  `

  const cloudPanel = qsRequired(overlay, '.onboarding-panel[data-step="cloud"]')
  const apiKeys = createApiKeysSection(api, { legend: 'Cloud API keys (optional)' })
  const envKeyDetect = createEnvKeyDetectSection(api, {
    legend: 'Already have keys in your environment?',
    onImported: () => void apiKeys.refreshKeyStatus(),
  })
  cloudPanel.append(
    Object.assign(document.createElement('p'), {
      className: 'settings-section-desc',
      textContent:
        'Add one or both keys if you want frontier models in chat. Keys are validated with a free models request — no tokens are charged.',
    }),
    apiKeys.root,
    envKeyDetect.root,
  )

  // Created before the local panel so auto-detection can refresh the routing
  // model lists after importing newly-discovered local models.
  const routing = createModelRoutingSection(api)

  const localPanel = qsRequired(overlay, '.onboarding-panel[data-step="local"]')
  const lmStudio = createLmStudioSection(api, { showInstallGuide: true })

  // Auto-detection: probe every known local server (LM Studio, Ollama, llama.cpp,
  // Jan, vLLM) so first-run users see what's already running without hunting for
  // URLs. Reachable presets have their models imported so they're usable at once.
  const detectStatus = el('span', { class: 'setup-detection-status' })
  const detectList = el('div', { class: 'preferred-models-list' })
  const detectBtn = el(
    'button',
    { type: 'button', class: 'setup-test-btn' },
    'Scan for local servers',
  )

  let detecting = false
  async function runLocalDetection(): Promise<void> {
    if (detecting) return
    detecting = true
    detectBtn.disabled = true
    detectStatus.textContent = 'Scanning…'
    detectStatus.className = 'setup-detection-status'
    try {
      const results = await detectLocalServers(api)
      clear(detectList)
      for (const r of results) {
        const meta = el(
          'div',
          { class: 'preferred-model-meta' },
          el('strong', {}, r.label),
          el('span', { class: 'field-hint' }, r.baseUrl),
        )
        const status = el(
          'span',
          { class: r.reachable ? 'preferred-model-status ok' : 'preferred-model-status' },
          r.reachable ? `✓ running — ${String(r.models.length)} model(s)` : '○ not found',
        )
        detectList.append(el('div', { class: 'preferred-model-row' }, meta, status))
      }
      const reachable = results.filter((r) => r.reachable)
      // Persist discovered models for reachable presets so they're immediately
      // selectable; LM Studio is handled by its own section below. Import
      // SEQUENTIALLY: each importDetectedPreset does a read-modify-write of the
      // single `extraProviders` setting, so running them concurrently would have
      // them clobber each other and drop all but one discovered preset.
      for (const r of reachable) {
        await importDetectedPreset(api, r)
      }
      detectStatus.textContent = reachable.length
        ? `Found ${String(reachable.length)} local server(s)`
        : 'No local servers detected'
      detectStatus.className = `setup-detection-status ${reachable.length ? 'ok' : 'warn'}`
      await lmStudio.refreshDetection()
      void routing.refresh()
    } catch {
      detectStatus.textContent = 'Detection failed'
      detectStatus.className = 'setup-detection-status err'
    } finally {
      detecting = false
      detectBtn.disabled = false
    }
  }

  detectBtn.addEventListener('click', () => {
    void runLocalDetection()
  })
  const detectFieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Detected local servers'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'We scan the usual local ports for OpenAI-compatible servers. Start LM Studio, Ollama, llama.cpp, Jan, or vLLM, then scan — anything found is set up automatically.',
    ),
    el('div', { class: 'lmstudio-test-row' }, detectBtn, detectStatus),
    detectList,
  )

  localPanel.append(
    Object.assign(document.createElement('p'), {
      className: 'settings-section-desc',
      textContent:
        'Local models power most of Copse’s background work. Copse auto-detects local servers — LM Studio, Ollama, llama.cpp, Jan, and vLLM — when they’re running.',
    }),
    detectFieldset,
    lmStudio.root,
  )

  const routingPanel = qsRequired(overlay, '.onboarding-panel[data-step="routing"]')
  routingPanel.append(
    Object.assign(document.createElement('p'), {
      className: 'settings-section-desc',
      textContent:
        'Choose local models for chat, exploration, and safety. Small tasks (titles, follow-ups) can use any model — configure them later in Settings → General.',
    }),
    routing.root,
    Object.assign(document.createElement('p'), {
      className: 'field-hint',
      textContent:
        'Tip: load downloaded models in LM Studio (Developer → Load model) so they appear in these lists.',
    }),
  )

  function showStep(step: OnboardingStep): void {
    currentStep = step
    stepBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset['step'] === step))
    panels.forEach((panel) => panel.classList.toggle('active', panel.dataset['step'] === step))
    backBtn.disabled = step === 'welcome'
    nextBtn.textContent = step === 'routing' ? 'Finish setup' : 'Continue'
  }

  stepBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = btn.dataset['step'] as OnboardingStep | undefined
      if (step) showStep(step)
    })
  })

  backBtn.addEventListener('click', () => {
    const idx = stepOrder.indexOf(currentStep)
    if (idx > 0) showStep(at(stepOrder, idx - 1))
  })

  async function finishSetup(): Promise<void> {
    await apiKeys.saveKeys()
    const routingValues = routing.readValues()
    await lmStudio.saveConnection({
      safetyModel: routingValues.safetyModel || LM_STUDIO_MODEL_IDS.safety,
    })
    await api.settings.set(
      'localDefaultModel',
      routingValues.localDefaultModel || LM_STUDIO_MODEL_IDS.chat,
    )
    await api.settings.set(
      'smallTasksModel',
      lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks),
    )
    await api.settings.set('subagentModel', routingValues.subagentModel)
    await api.settings.set('localSubagentsEnabled', true)
    await api.settings.set('localTodoItemsEnabled', true)
    await api.settings.set('model', lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.chat))
    await api.settings.set('onboardingCompleted', true)
    store.setState({
      settings: { ...store.getState().settings, model: DEFAULT_APP_CHAT_MODEL },
    })
    store.emit('settings_changed')
    lmStudio.destroy()
    closeOnboardingDialog()
  }

  async function skipSetup(): Promise<void> {
    await api.settings.set('onboardingCompleted', true)
    lmStudio.destroy()
    closeOnboardingDialog()
  }

  nextBtn.addEventListener('click', () => {
    const idx = stepOrder.indexOf(currentStep)
    if (currentStep === 'cloud') void apiKeys.saveKeys()
    if (currentStep === 'local') void lmStudio.saveConnection()
    if (currentStep === 'routing') {
      void finishSetup()
      return
    }
    if (idx < stepOrder.length - 1) showStep(at(stepOrder, idx + 1))
  })

  overlay.querySelector('#onboarding-skip')?.addEventListener('click', () => {
    void skipSetup()
  })
  const onboardingCloseBtn = qsRequired(overlay, '#onboarding-close')
  onboardingCloseBtn.append(closeIcon('ui-icon'))
  onboardingCloseBtn.addEventListener('click', () => {
    void skipSetup()
  })

  overlay.addEventListener('onboarding-open', () => {
    showStep('welcome')
    void apiKeys.refreshKeyStatus()
    void envKeyDetect.refresh()
    void lmStudio.refreshDetection()
    void runLocalDetection()
    void routing.refresh()
  })
}
