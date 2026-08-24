import { inflateRawSync } from 'node:zlib'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

function readZipEntries(archive: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.length)
  const eocd = buffer.length - 22
  expect(buffer.readUInt32LE(eocd)).toBe(0x0605_4b50)
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, string>()
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength
    const bodyStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28)
    const body = buffer.subarray(bodyStart, bodyStart + compressedSize)
    entries.set(path, (method === 0 ? body : inflateRawSync(body)).toString('utf8'))
  }
  return entries
}

describe('decision spine archive', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-decision-spine-live', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      autoRunSandboxCommands: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('archives a real approval and oversized shell args on the active thread spine', async function () {
    this.timeout(90_000)
    const payload = 'spine-blob-proof-'.repeat(180)
    const command = `printf '%s' '${payload}' >/dev/null`
    await setComposerValue(`[[mcp:run_shell ${JSON.stringify({ command })}]]`)
    await $('.submit-btn').click()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run shell command?')
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    const tool = $('.tool-card[data-status="done"]')
    await tool.waitForExist({ timeout: 30_000 })
    await browser.pause(1_000)

    const exported = await browser.execute(async () => {
      const api = (
        window as unknown as {
          api: {
            threads: {
              loadProject: (projectId: string) => Promise<Array<{ id: string }>>
              exportArchive: (projectId: string, threadId: string) => Promise<{ bytes: Uint8Array }>
            }
          }
        }
      ).api
      const threads = await api.threads.loadProject('e2e-decision-spine-live')
      const threadId = threads[0]?.id
      if (!threadId) throw new Error('active persisted thread missing')
      const { bytes } = await api.threads.exportArchive('e2e-decision-spine-live', threadId)
      return { threadId, bytes: Array.from(bytes) }
    })

    const entries = readZipEntries(Uint8Array.from(exported.bytes))
    const events = entries.get(`${exported.threadId}/events.jsonl`) ?? ''
    const lines = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const decision = lines.find((line) => line['type'] === 'decision')
    expect(decision).toBeDefined()
    expect(decision?.['actor']).toBe('user')
    expect(decision?.['verdict']).toBe('approved')
    expect(decision?.['kind']).toBe('shell')

    const argsEntry = [...entries.entries()].find(([path]) => path.endsWith('.args.json'))
    expect(argsEntry).toBeDefined()
    const args = JSON.parse(argsEntry?.[1] ?? '{}') as { command?: string }
    expect(args.command?.length).toBeGreaterThan(2_048)
    expect(args.command).toContain('spine-blob-proof-')
    expect([...entries.keys()].some((path) => path.endsWith('/decisions.jsonl'))).toBe(false)
  })
})
