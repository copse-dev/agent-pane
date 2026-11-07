import { createDemoApi } from '../../../src/renderer/demo/demo-api.ts'
import { selectDemoScenario } from '../../../src/renderer/demo/scenarios.ts'
import { sliceForStreaming } from '../../../src/renderer/demo/trace-player.ts'
import { useAnnouncementCatalog } from '../../../src/renderer/announcement-catalog.ts'

const scenario = selectDemoScenario('?scenario=chat-reading-layout')
const trace = scenario.trace
if (!trace) throw new Error('Reading-layout trace missing')
const resultIndex = trace.steps.findIndex((step) => step.chunk.type === 'tool_result')
const resumed = trace.steps[resultIndex + 1]
if (resultIndex < 0 || !resumed) throw new Error('Expected the reply to resume after the read')
const sliceChars = 12
const charsPerSecond = 240
const stepPauseMs = 260
if ((resumed.delayMs ?? stepPauseMs) <= 0) throw new Error('Expected a pause after the read')
// playTrace sleeps before each delayed step and after every text or reasoning
// slice. Hold the pause after the read result: the card has settled on "Read
// file" and the reply has not resumed, so the turn cannot advance mid-capture.
let checkpointSleep = 1
for (const step of trace.steps.slice(0, resultIndex + 1)) {
  if ((step.delayMs ?? stepPauseMs) > 0) checkpointSleep++
  if (step.chunk.type === 'text' || step.chunk.type === 'reasoning') {
    checkpointSleep += sliceForStreaming(step.chunk.text, sliceChars).length
  }
}
let sleepCalls = 0
let release = (): void => {}
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const control = { paused: false, release }
// This entry point is bundled only by the spec into a standalone test page.
Reflect.set(window, '__copseToolCheckpoint', control)
useAnnouncementCatalog([])
window.api = createDemoApi(scenario, {
  trace: {
    sliceChars,
    charsPerSecond,
    stepPauseMs,
    sleep: async (ms) => {
      if (++sleepCalls === checkpointSleep) {
        control.paused = true
        await gate
        control.paused = false
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ms))
    },
  },
})
document.documentElement.dataset['demoScenario'] = scenario.id
void import('../../../src/renderer/main.ts').then(async (main) => {
  await main.rendererReady
})
