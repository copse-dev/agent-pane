import { composeContextBreakdown } from '@copse/agent/context-breakdown.ts'
import { buildFooterUsageTooltip } from '@shared/usage/footer-usage-tooltip.ts'
import type { Message, SubagentSession, ToolCall } from '@shared/types'
import { createContextWheel } from '../../../src/renderer/views/context-wheel.ts'

const app = document.querySelector('#app')
if (!app) throw new Error('Missing fixture mount')

const mode = new URLSearchParams(location.search).get('mode')
function call(id: string, session: Partial<SubagentSession>): ToolCall {
  return {
    id,
    name: 'explore',
    args: {},
    status: 'done',
    result: 'done',
    subagent: {
      id: `sub-${id}`,
      kind: 'explore',
      status: 'done',
      prompt: 'Review the renderer',
      summary: null,
      messages: [],
      model: 'lmstudio:qwen',
      ...session,
    },
  }
}
const toolCalls =
  mode === 'running'
    ? [call('live', { status: 'running' })]
    : mode === 'mixed'
      ? [
          call('reported', { usage: { inputTokens: 100, outputTokens: 10 } }),
          call('unreported', { status: 'error' }),
        ]
      : [call('unreported', { status: 'done' })]
const messages: Message[] = [
  { id: 'assistant', role: 'assistant', content: '', toolCalls, createdAt: 1 },
]
const usage = buildFooterUsageTooltip(
  { inputTokens: 900, outputTokens: 90, estimated: false },
  {
    model: 'claude-sonnet-4-6',
    messages,
    measuredUsage: { inputTokens: 1000, outputTokens: 100 },
  },
)
const wheel = createContextWheel()
wheel.update(
  {
    contextWindow: 200_000,
    conversationBudget: 100_000,
    conversationTokens: 50_000,
    fillRatio: 0.5,
    updatedAt: 1,
  },
  false,
  {
    breakdown: composeContextBreakdown({ system: 1800, history: 5000 }, 200_000),
    breakdownRing: false,
    usage,
  },
)
app.setAttribute('style', 'width:640px;height:480px;padding:400px 320px 40px;box-sizing:border-box')
const footer = document.createElement('div')
footer.className = 'input-footer'
footer.append(wheel.root)
app.append(footer)
