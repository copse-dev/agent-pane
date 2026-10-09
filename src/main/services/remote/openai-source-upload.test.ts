import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenAiAgentsApi } from './openai-agents-api.ts'
import { SOURCE_PART_BYTES, uploadSourceBundle } from './openai-source-upload.ts'

it('deletes already-uploaded parts when a later part fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openai-parts-'))
  try {
    const path = join(directory, 'source.bundle')
    const file = await open(path, 'w')
    await file.truncate(SOURCE_PART_BYTES + 1)
    await file.close()
    let uploads = 0
    const deleted: string[] = []
    const client = new OpenAiAgentsApi('key', async (input, init) => {
      if (init?.method === 'DELETE') {
        deleted.push(
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
        )
        return new Response(null, { status: 404 }) // Cleanup is idempotent.
      }
      uploads++
      return uploads === 1 ? Response.json({ id: 'part-one' }) : new Response(null, { status: 503 })
    })
    await assert.rejects(uploadSourceBundle(client, path, AbortSignal.timeout(10_000)), /503/)
    assert.equal(uploads, 2)
    assert.deepEqual(deleted, ['https://api.openai.com/v1/files/part-one'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
