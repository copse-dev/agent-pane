import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import { runHeadlessAgent, type HeadlessAgentProfile } from './headless-agent-host.ts'

class TrivialTaskProvider implements LLMProvider {
  readonly seen: Array<{ messages: LLMMessage[]; tools: LLMTool[] }> = []

  async *stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    _signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    this.seen.push({ messages, tools })
    if (this.seen.length === 1) {
      yield {
        type: 'tool_call',
        toolCall: { id: 'list-root', name: 'list_dir', args: { path: '.' } },
      }
      yield { type: 'done' }
      return
    }
    yield { type: 'text', text: 'The product path listed the workspace and finished.' }
    yield { type: 'done' }
  }
}

class WriteTaskProvider implements LLMProvider {
  private callCount = 0

  async *stream(): AsyncIterable<ProviderStreamChunk> {
    this.callCount++
    if (this.callCount === 1) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'write-answer',
          name: 'write_file',
          args: { path: 'answer.txt', content: 'written through the product tool path\n' },
        },
      }
      yield { type: 'done' }
      return
    }
    yield { type: 'text', text: 'The file is written.' }
    yield { type: 'done' }
  }
}

class BackgroundWakeProvider implements LLMProvider {
  callCount = 0

  async *stream(): AsyncIterable<ProviderStreamChunk> {
    this.callCount++
    if (this.callCount === 1) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'start-bounded-task',
          name: 'run_background',
          args: {
            action: 'start',
            command: 'node -e "setTimeout(() => process.exit(0), 20)"',
            wake_on_completion: true,
            timeout_ms: 5_000,
          },
        },
      }
      yield { type: 'done' }
      return
    }
    yield {
      type: 'text',
      text:
        this.callCount === 2
          ? 'The bounded task is running.'
          : 'The machine continuation observed completion.',
    }
    yield { type: 'done' }
  }
}

class CaptureTaskProvider implements LLMProvider {
  seenMessages: LLMMessage[] = []
  seenTools: LLMTool[] = []
  private readonly rendezvous: () => Promise<void>

  constructor(rendezvous: () => Promise<void>) {
    this.rendezvous = rendezvous
  }

  async *stream(messages: LLMMessage[], tools: LLMTool[]): AsyncIterable<ProviderStreamChunk> {
    this.seenMessages = messages
    this.seenTools = tools
    await this.rendezvous()
    yield { type: 'text', text: 'Captured the scoped product construction.' }
    yield { type: 'done' }
  }
}

function twoPartyRendezvous(): () => Promise<void> {
  let arrivals = 0
  let release!: () => void
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve
  })
  return async (): Promise<void> => {
    arrivals++
    if (arrivals === 2) release()
    await bothArrived
  }
}

function smokeProfile(workspaceRoot: string): HeadlessAgentProfile {
  return {
    workspaceRoot,
    model: 'headless-test-model',
    settings: {
      browserToolsEnabled: false,
      bundledCursorSkillsEnabled: false,
      cursorHooksEnabled: false,
      skillsEnabled: false,
      subagentsEnabled: false,
    },
    enabledPackIds: [],
    toolAvailability: { rg: false, git: false, gh: false },
    loadMcpServers: false,
    workspaceTrusted: false,
    limits: { maxSteps: 4, maxLlmCalls: 4 },
  }
}

describe('runHeadlessAgent', () => {
  it('runs a trivial task through the product provider/prompt/registry/loop path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'copse-headless-host-'))
    await writeFile(join(workspace, 'README.md'), '# fixture\n', 'utf8')
    const provider = new TrivialTaskProvider()

    try {
      const result = await runHeadlessAgent(
        smokeProfile(workspace),
        { prompt: 'Inspect the workspace and answer.', threadId: 'headless-smoke' },
        { provider, contextWindow: 32_000 },
      )

      assert.equal(provider.seen.length, 2)
      const first = provider.seen[0]
      assert.ok(first)
      const system = first.messages.find((message) => message.role === 'system')
      assert.equal(typeof system?.content, 'string')
      assert.match(
        String(system?.content),
        new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      )
      assert.ok(first.tools.some((tool) => tool.name === 'list_dir'))
      assert.ok(first.tools.some((tool) => tool.name === 'write_file'))
      assert.ok(!first.tools.some((tool) => tool.name.startsWith('browser_')))
      assert.ok(result.chunks.some((chunk) => chunk.type === 'tool_call'))
      assert.ok(result.chunks.some((chunk) => chunk.type === 'tool_result'))
      assert.ok(result.chunks.some((chunk) => chunk.type === 'text'))
      assert.equal(result.chunks.at(-1)?.type, 'done')
      assert.ok(result.toolNames.includes('list_dir'))
      assert.deepEqual(result.skillNames, [])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('routes product writes through the profile-scoped staged-diff decision', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'copse-headless-write-'))

    try {
      const result = await runHeadlessAgent(
        {
          ...smokeProfile(workspace),
          interaction: { stagedDiff: async () => true },
        },
        { prompt: 'Write answer.txt.', threadId: 'headless-write' },
        { provider: new WriteTaskProvider(), contextWindow: 32_000 },
      )

      assert.equal(
        await readFile(join(workspace, 'answer.txt'), 'utf8'),
        'written through the product tool path\n',
      )
      assert.ok(
        result.chunks.some(
          (chunk) => chunk.type === 'tool_result' && chunk.toolCallId === 'write-answer',
        ),
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('waits for a production background completion machine continuation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'copse-headless-background-wake-'))
    const provider = new BackgroundWakeProvider()

    try {
      const result = await runHeadlessAgent(
        {
          ...smokeProfile(workspace),
          enabledPackIds: ['copse.background-tasks'],
          workspaceTrusted: true,
          interaction: {
            approve: (): Promise<{ approved: boolean; remember: boolean }> =>
              Promise.resolve({ approved: true, remember: false }),
          },
        },
        {
          prompt: 'Start the bounded task.',
          threadId: 'headless-background-wake',
          waitForMachineContinuations: { count: 1, timeoutMs: 5_000 },
        },
        { provider, contextWindow: 32_000 },
      )

      assert.equal(provider.callCount, 3)
      assert.equal(
        result.messages.findLast((message) => message.role === 'assistant')?.content,
        'The machine continuation observed completion.',
      )
      assert.ok(
        result.messages.some(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('Background task'),
        ),
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('isolates concurrent workspace and settings profiles', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'copse-headless-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'copse-headless-b-'))
    const rendezvous = twoPartyRendezvous()
    const providerA = new CaptureTaskProvider(rendezvous)
    const providerB = new CaptureTaskProvider(rendezvous)

    try {
      const profileB: HeadlessAgentProfile = {
        ...smokeProfile(workspaceB),
        settings: { ...smokeProfile(workspaceB).settings, browserToolsEnabled: true },
      }
      await Promise.all([
        runHeadlessAgent(
          smokeProfile(workspaceA),
          { prompt: 'Capture A.', threadId: 'headless-a' },
          { provider: providerA, contextWindow: 32_000 },
        ),
        runHeadlessAgent(
          profileB,
          { prompt: 'Capture B.', threadId: 'headless-b' },
          { provider: providerB, contextWindow: 32_000 },
        ),
      ])

      assert.ok(!providerA.seenTools.some((tool) => tool.name.startsWith('browser_')))
      assert.ok(providerB.seenTools.some((tool) => tool.name === 'browser_navigate'))
      const promptA = providerA.seenMessages.find((message) => message.role === 'system')
      const promptB = providerB.seenMessages.find((message) => message.role === 'system')
      assert.match(String(promptA?.content), new RegExp(workspaceA))
      assert.doesNotMatch(String(promptA?.content), new RegExp(workspaceB))
      assert.match(String(promptB?.content), new RegExp(workspaceB))
      assert.doesNotMatch(String(promptB?.content), new RegExp(workspaceA))
    } finally {
      await Promise.all([
        rm(workspaceA, { recursive: true, force: true }),
        rm(workspaceB, { recursive: true, force: true }),
      ])
    }
  })
})
