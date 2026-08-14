import './demo.css'
import { createDemoApi } from './demo-api.ts'
import { selectDemoScenario } from './scenarios.ts'
import { startAutoplay } from './autoplay.ts'
import { demoScenarioPrompt } from '@shared/demo-scenarios.ts'

/**
 * Read a boolean query flag. Present-but-empty (`?loop`) counts as on, so the
 * marketing embed can stay terse; `0`/`false`/`off` turn it off explicitly.
 */
function flag(params: URLSearchParams, name: string, fallback: boolean): boolean {
  const raw = params.get(name)
  if (raw === null) return fallback
  if (raw === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

const params = new URLSearchParams(window.location.search)
const scenario = selectDemoScenario(window.location.search)

// Someone who asked their system not to animate things gets the finished
// transcript instead: same content, no typing and no streaming.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
// A scenario with a recorded trace is a walkthrough, so it plays by default —
// including for anyone opening the demo link directly. `?autoplay=0` opts out.
const autoplay = flag(params, 'autoplay', scenario.trace !== undefined)
// Focusing a control inside an iframe also focuses the iframe itself, which
// makes Chromium scroll the containing marketing page back to the hero.
const embedded = flag(params, 'embedded', false)

window.api = createDemoApi(scenario, { trace: { instant: reducedMotion } })
document.documentElement.dataset['demoScenario'] = scenario.id
if (scenario.staticSite) document.documentElement.dataset['demoStaticSite'] = scenario.staticSite
if (autoplay) document.documentElement.dataset['demoAutoplay'] = 'on'
if (embedded) document.documentElement.dataset['demoEmbedded'] = 'on'

void import('../main.ts').then(() => {
  const trace = scenario.trace
  if (!autoplay || !trace) return
  void startAutoplay(document, {
    prompt: demoScenarioPrompt(scenario),
    loop: flag(params, 'loop', false),
    instant: reducedMotion,
    focusComposer: !embedded,
    revealFinalPreview: scenario.revealFinalPreview === true,
  })
})
