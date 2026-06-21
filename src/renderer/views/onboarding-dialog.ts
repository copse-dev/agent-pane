import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '@shared/lm-studio-defaults.ts'
import { createApiKeysSection } from './setup/api-keys-section.ts'
import { createLmStudioSection } from './setup/lm-studio-section.ts'
import { createModelRoutingSection } from './setup/model-routing-section.ts'

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
        <button type="button" class="settings-close-btn" id="onboarding-close" aria-label="Close setup">✕</button>
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
  const backBtn = overlay.querySelector('#onboarding-back') as HTMLButtonElement
  const nextBtn = overlay.querySelector('#onboarding-next') as HTMLButtonElement

  const welcomePanel = overlay.querySelector(
    '.onboarding-panel[data-step="welcome"]',
  ) as HTMLElement
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

  const cloudPanel = overlay.querySelector('.onboarding-panel[data-step="cloud"]') as HTMLElement
  const apiKeys = createApiKeysSection(api, { legend: 'Cloud API keys (optional)' })
  cloudPanel.append(
    Object.assign(document.createElement('p'), {
      className: 'settings-section-desc',
      textContent:
        'Add one or both keys if you want frontier models in chat. Keys are validated with a free models request — no tokens are charged.',
    }),
    apiKeys.root,
  )

  const localPanel = overlay.querySelector('.onboarding-panel[data-step="local"]') as HTMLElement
  const lmStudio = createLmStudioSection(api, { showInstallGuide: true })
  localPanel.append(
    Object.assign(document.createElement('p'), {
      className: 'settings-section-desc',
      textContent:
        'Local models power most of Copse’s background work. We auto-detect LM Studio when its server is running.',
    }),
    lmStudio.root,
  )

  const routingPanel = overlay.querySelector(
    '.onboarding-panel[data-step="routing"]',
  ) as HTMLElement
  const routing = createModelRoutingSection(api)
  routingPanel.append(
    Object.assign(document.createElement('p'), {
      className: 'settings-section-desc',
      textContent:
        'These are the models we recommend. Adjust routing now or later in Settings → Local models.',
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
    stepBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.step === step))
    panels.forEach((panel) => panel.classList.toggle('active', panel.dataset.step === step))
    backBtn.disabled = step === 'welcome'
    nextBtn.textContent = step === 'routing' ? 'Finish setup' : 'Continue'
  }

  stepBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = btn.dataset.step as OnboardingStep | undefined
      if (step) showStep(step)
    })
  })

  backBtn.addEventListener('click', () => {
    const idx = stepOrder.indexOf(currentStep)
    if (idx > 0) showStep(stepOrder[idx - 1]!)
  })

  async function finishSetup(): Promise<void> {
    await apiKeys.saveKeys()
    await lmStudio.saveConnection()
    const routingValues = routing.readValues()
    await api.settings.set('lmStudioModel', routingValues.lmStudioModel || LM_STUDIO_MODEL_IDS.chat)
    await api.settings.set(
      'lmStudioSmallTasksModel',
      routingValues.lmStudioSmallTasksModel || LM_STUDIO_MODEL_IDS.smallTasks,
    )
    await api.settings.set('lmStudioSubagentModel', routingValues.lmStudioSubagentModel)
    await api.settings.set(
      'lmStudioSafetyModel',
      routingValues.lmStudioSafetyModel || LM_STUDIO_MODEL_IDS.safety,
    )
    await api.settings.set('lmStudioForSmallTasks', true)
    await api.settings.set('lmStudioForSubagents', true)
    await api.settings.set('lmStudioForTodoItems', true)
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
    if (idx < stepOrder.length - 1) showStep(stepOrder[idx + 1]!)
  })

  overlay.querySelector('#onboarding-skip')!.addEventListener('click', () => {
    void skipSetup()
  })
  overlay.querySelector('#onboarding-close')!.addEventListener('click', () => {
    void skipSetup()
  })

  overlay.addEventListener('onboarding-open', () => {
    showStep('welcome')
    void apiKeys.refreshKeyStatus()
    void lmStudio.refreshDetection()
    void routing.refresh()
  })
}
