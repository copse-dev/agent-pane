import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { REMOTE_READ_CHANNELS } from '../../src/shared/remote-interface.ts'
import { MOBILE_WRITE_DISPATCH } from '../../src/main/services/mobile/mobile-actions.ts'

const channelMap = z.record(z.string(), z.unknown())
const manifestSchema = z.object({ channels: z.record(z.string(), channelMap) })
const matrixSchema = z.object({
  remoteReads: z.array(z.string()),
  mobileActions: z.array(z.string()),
  desktopOnly: z.record(z.string(), z.array(z.string())),
})

test('every desktop wire channel has a reviewed remote classification', () => {
  const manifest = safeJsonParse(
    readFileSync('schemas/api-protocol.manifest.json', 'utf8'),
    decodeWithSchema(manifestSchema),
  )
  const matrix = safeJsonParse(
    readFileSync('docs/remote-client-capabilities.json', 'utf8'),
    decodeWithSchema(matrixSchema),
  )
  assert.ok(manifest)
  assert.ok(matrix)
  assert.deepEqual(matrix.remoteReads, [...REMOTE_READ_CHANNELS].sort())
  assert.deepEqual(matrix.mobileActions, Object.keys(MOBILE_WRITE_DISPATCH).sort())
  assert.deepEqual(Object.keys(matrix.desktopOnly).sort(), Object.keys(manifest.channels).sort())
  for (const [kind, channels] of Object.entries(manifest.channels)) {
    const classified: string[] = [
      ...(matrix.desktopOnly[kind] ?? []),
      ...(kind === 'invoke' ? matrix.remoteReads : []),
    ]
    assert.equal(new Set(classified).size, classified.length, `${kind}: duplicate classification`)
    assert.deepEqual(
      classified.sort(),
      Object.keys(channels).sort(),
      `${kind}: classify added/removed channels in docs/remote-client-capabilities.json`,
    )
  }
})
