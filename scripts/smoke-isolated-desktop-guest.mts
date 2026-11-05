/** Fixed guest fixture transferred over stdin; never imported into the product controller. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { smokeAppleDesktopGui } from './lib/apple-desktop-gui-smoke.mts'
import { desktopGuestProvider } from '../src/main/services/isolated-desktop/guest-provider.ts'

async function main(): Promise<void> {
  assert.equal(process.getuid?.(), 1001)
  const canary = process.argv[1]
  assert.ok(canary, 'the host must identify its canary path')
  await assert.rejects(readFile(canary), { code: 'ENOENT' })
  if (process.argv[2] === '--gui') {
    await smokeAppleDesktopGui(process.argv.includes('--containment'))
    console.log('guest-gui-and-canary: passed')
    return
  }
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of desktopGuestProvider().stream(
    [{ role: 'user', content: 'Isolated desktop relay smoke 😀' }],
    [],
    AbortSignal.timeout(15_000),
  ))
    chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'text', text: 'Approved mock response 😀' },
    { type: 'usage', model: 'desktop-smoke-pinned', inputTokens: 10, outputTokens: 5 },
    { type: 'done', stopReason: 'end_turn' },
  ])
  console.log('guest-inference-and-canary: passed')
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  },
)
