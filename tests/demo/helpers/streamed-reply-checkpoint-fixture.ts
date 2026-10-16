import type { DemoTrace } from '@shared/demo-traces.ts'
import { createDemoApi } from '../../../src/renderer/demo/demo-api.ts'
import { selectDemoScenario } from '../../../src/renderer/demo/scenarios.ts'
import { sliceForStreaming } from '../../../src/renderer/demo/trace-player.ts'
import { useAnnouncementCatalog } from '../../../src/renderer/announcement-catalog.ts'

const original = selectDemoScenario('?scenario=chat-reading-layout')
const source = original.trace
if (!source) throw new Error('Reading-layout trace missing')
const proseIndex = source.steps.findIndex(
  (step) => step.chunk.type === 'text' && step.chunk.text.startsWith('A response should'),
)
const prose = source.steps[proseIndex]
if (!prose || prose.chunk.type !== 'text') throw new Error('Reading-layout prose missing')
const split = prose.chunk.text.indexOf('### Review the details')
if (split < 700 || !prose.chunk.text.slice(0, split).endsWith('\n\n')) {
  throw new Error('Expected complete prose/list checkpoint before Review the details')
}
const prefix = prose.chunk.text.slice(0, split)
// Split one provider text chunk at a complete Markdown block boundary. The
// concatenated content and every reasoning/tool/done chunk remain unchanged.
const trace: DemoTrace = {
  ...source,
  steps: [
    ...source.steps.slice(0, proseIndex),
    { ...prose, chunk: { type: 'text', text: prefix } },
    { delayMs: 0, chunk: { type: 'text', text: prose.chunk.text.slice(split) } },
    ...source.steps.slice(proseIndex + 1),
  ],
}
const sliceChars = 12
const charsPerSecond = 240
const stepPauseMs = 260
// playTrace awaits the step pause, then a pacing sleep after every text or
// reasoning slice. Derive the exact post-prefix sleep, including all preceding
// reasoning/tool steps; no wall-clock threshold or guessed elapsed time.
let checkpointSleep = 0
for (const step of trace.steps.slice(0, proseIndex + 1)) {
  if ((step.delayMs ?? stepPauseMs) > 0) checkpointSleep++
  if (step.chunk.type === 'text' || step.chunk.type === 'reasoning') {
    checkpointSleep += sliceForStreaming(step.chunk.text, sliceChars).length
  }
}
let release = (): void => {}
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const control = { paused: false, sleepCalls: 0, prefix, release }
// This entry point is bundled only by the spec into a standalone test page.
Reflect.set(window, '__copseStreamCheckpoint', control)
useAnnouncementCatalog([])
window.api = createDemoApi(
  { ...original, trace },
  {
    trace: {
      sliceChars,
      charsPerSecond,
      stepPauseMs,
      sleep: async (ms) => {
        control.sleepCalls++
        if (control.sleepCalls === checkpointSleep) {
          control.paused = true
          await gate
          control.paused = false
        }
        await new Promise<void>((resolve) => setTimeout(resolve, ms))
      },
    },
  },
)
document.documentElement.dataset['demoScenario'] = original.id
void import('../../../src/renderer/main.ts').then(async (main) => {
  await main.rendererReady
})
