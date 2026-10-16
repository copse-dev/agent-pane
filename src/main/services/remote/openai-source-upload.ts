import { open } from 'node:fs/promises'
import type { OpenAiAgentsApi } from './openai-agents-api.ts'

export const SOURCE_PART_BYTES = 32 * 1024 * 1024
// Hosted create accepts 50 files; reserve one for the setup/export worker.
export const MAX_SOURCE_PARTS = 49

export async function uploadSourceBundle(
  client: OpenAiAgentsApi,
  path: string,
  signal: AbortSignal,
): Promise<string[]> {
  const file = await open(path, 'r')
  const ids: string[] = []
  try {
    const size = (await file.stat()).size
    if (size > SOURCE_PART_BYTES * MAX_SOURCE_PARTS)
      throw new Error('Project snapshot exceeds the 49-part hosted transfer budget (1568 MiB).')
    const buffer = Buffer.alloc(Math.min(size, SOURCE_PART_BYTES))
    let position = 0
    while (position < size) {
      signal.throwIfAborted()
      const length = Math.min(buffer.length, size - position)
      let read = 0
      while (read < length) {
        const { bytesRead } = await file.read(buffer, read, length - read, position + read)
        if (!bytesRead) throw new Error('Project snapshot changed during upload.')
        read += bytesRead
      }
      ids.push(await client.uploadSource(buffer.subarray(0, length), signal))
      position += length
    }
    return ids
  } catch (error) {
    await Promise.all(
      ids.map((id) => client.deleteSource(id, AbortSignal.timeout(20_000)).catch(() => {})),
    )
    throw error
  } finally {
    await file.close()
  }
}
