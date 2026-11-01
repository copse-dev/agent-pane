/** Real VM smoke through the product session and transport, with no credential access. */
import assert from 'node:assert/strict'
import {
  desktopContainmentCommand,
  startDesktopHostCanary,
} from './lib/apple-desktop-containment.mts'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import {
  APPLE_DESKTOP_BOOTSTRAP,
  APPLE_DESKTOP_MAX_CONTROLLER,
} from './lib/apple-desktop-bootstrap.mts'
import { DesktopSession } from '../src/main/services/isolated-desktop/desktop-session.ts'
import { AppleDesktopTransport } from '../src/main/services/isolated-desktop/apple-desktop-transport.ts'

async function main(): Promise<void> {
  const containment = process.argv.includes('--containment')
  const gui = containment || process.argv.includes('--gui')
  const commandState: { issued: boolean; verified: boolean; offered: string[] } = {
    issued: false,
    verified: false,
    offered: [],
  }
  let guiRequests = 0
  const owner = { projectId: 'desktop-smoke', threadId: randomUUID() }
  const name = 'copse-desktop-probe-' + randomUUID()
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  const deadline = setTimeout(abort, 120_000)
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const cleanupErrors: unknown[] = []
  let hostCanary: Awaited<ReturnType<typeof startDesktopHostCanary>> | undefined
  let inferenceCalls = 0
  const provider: LLMProvider = {
    async *stream(messages, tools): AsyncIterable<ProviderStreamChunk> {
      if (gui) {
        if (
          messages.some(
            (message) =>
              message.role === 'user' &&
              typeof message.content === 'string' &&
              message.content.includes('Isolated desktop GUI smoke 😀'),
          )
        )
          guiRequests++
      } else {
        assert.deepEqual(messages, [{ role: 'user', content: 'Isolated desktop relay smoke 😀' }])
        assert.deepEqual(tools, [])
      }
      assert.ok((await readFile(canary)).length > 0, 'the host canary must still exist')
      inferenceCalls++
      commandState.offered = tools.map((tool) => tool.name)
      if (containment) {
        const result = messages
          .flatMap((message) => (message.role === 'tool' ? message.toolResults : []))
          .find((toolResult) => toolResult.toolCallId === 'desktop-containment')
        if (result) {
          assert.ok(
            result.result.includes('desktop-containment:passed'),
            'the child tool result must establish the canary denial and scratch positive control',
          )
          commandState.verified = true
        } else if (!commandState.issued && tools.some((tool) => tool.name === 'run_shell')) {
          commandState.issued = true
          assert.ok(hostCanary, 'the host canary service must have a passing positive control')
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'desktop-containment',
              name: 'run_shell',
              args: {
                command: desktopContainmentCommand(canary, hostCanary.port),
                expects_sandbox_block: true,
                timeout_ms: 10000,
              },
            },
          }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
      }
      yield { type: 'text', text: 'Approved mock response 😀' }
      yield { type: 'usage', model: 'desktop-smoke-pinned', inputTokens: 10, outputTokens: 5 }
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
  const canary = resolve('.tmp/desktop-host-canary-' + randomUUID())
  await mkdir('.tmp', { recursive: true })
  if (!process.argv.includes('--orphan-child'))
    await writeFile(canary, randomUUID(), { mode: 0o600 })
  const session = new DesktopSession(
    owner,
    new AppleDesktopTransport(name, (maximum): Promise<LLMProvider> => {
      assert.ok(maximum > 0 && maximum <= 100_000)
      return Promise.resolve(provider)
    }),
    controller.signal,
    (error) => {
      cleanupErrors.push(error)
    },
  )
  let png: Buffer | undefined
  let title: string
  try {
    title = await session.start()
    if (process.argv.includes('--orphan-child')) {
      console.log(JSON.stringify({ event: 'orphan-ready', name }))
      await new Promise<void>(() => {})
    }
    if (containment) hostCanary = await startDesktopHostCanary()
    await assert.rejects(
      session.execute({ ...owner, threadId: 'different-thread' }, { action: 'screenshot' }),
      /another thread/,
    )
    await session.execute(owner, { action: 'key', key: 'Tab' })
    png = await session.execute(owner, { action: 'screenshot' })
    assert.ok(png, 'the product transport must return a validated screenshot')
    const guest = await readFile(join(__dirname, 'smoke-isolated-desktop-guest.cjs'))
    const input = guest.toString('base64') + '\n'
    assert.ok(Buffer.byteLength(input) <= APPLE_DESKTOP_MAX_CONTROLLER)
    const observation = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        '/usr/local/bin/container',
        [
          'exec',
          '--interactive',
          '--user',
          '1001:1001',
          '--env',
          'COPSE_DESKTOP_INFERENCE=1',
          name,
          '/usr/bin/setpriv',
          '--no-new-privs',
          '--',
          '/usr/local/bin/node',
          '-e',
          APPLE_DESKTOP_BOOTSTRAP,
          canary,
          ...(gui ? ['--gui'] : []),
          ...(containment ? ['--containment'] : []),
        ],
        {
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          signal: controller.signal,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error('Guest inference smoke failed: ' + stderr, { cause: error }))
          else resolve(stdout.trim())
        },
      )
      child.stdin?.end(input)
    })
    assert.equal(
      observation,
      gui ? 'guest-gui-and-canary: passed' : 'guest-inference-and-canary: passed',
    )
    if (gui) assert.ok(guiRequests >= 1, 'the child composer must reach the host provider')
    else assert.equal(inferenceCalls, 1)
    if (containment)
      assert.ok(
        commandState.issued && commandState.verified,
        'the child command must execute after approval: ' + JSON.stringify(commandState),
      )
    png = await session.execute(owner, { action: 'screenshot' })
    assert.ok(png)
    controller.abort()
    await session.stop()
    await assert.rejects(session.execute(owner, { action: 'screenshot' }), /revoked/)
    assert.deepEqual(cleanupErrors, [])
  } finally {
    controller.abort()
    try {
      await session.stop()
    } finally {
      await hostCanary?.close()
      await rm(canary, { force: true })
      clearTimeout(deadline)
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
  }
  await mkdir('.tmp', { recursive: true })
  await writeFile('.tmp/isolated-desktop-transport.png', png)
  console.log(
    JSON.stringify({
      name,
      title,
      screenshot: '.tmp/isolated-desktop-transport.png',
      ownership: 'enforced',
      input: 'acknowledged',
      cancellation: 'revoked',
      teardown: 'complete',
      inference: gui
        ? 'child GUI turn through pinned mock provider'
        : 'guest relay to pinned mock provider',
      hostCanary: containment ? 'unavailable to approved child command' : 'unavailable in guest',
      hostService: containment
        ? 'guest connection refused; host positive control passed'
        : 'not exercised',
    }),
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
