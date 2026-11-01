/** Guest-only relay: a private Unix socket to the parent's bounded inference protocol. */
import { createServer, type Socket } from 'node:net'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { copseUserDataDir } from '@copse/store-kit/copse-paths.ts'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  DESKTOP_INFERENCE_SOCKET,
  DESKTOP_PARENT_MODEL,
} from '../../src/main/services/isolated-desktop/guest-provider.ts'

const responseSchema = z
  .object({
    action: z.literal('inference-data'),
    data: z
      .string()
      .max(90_000)
      .regex(/^[a-zA-Z0-9+/]+={0,2}$/),
  })
  .strict()

export async function startDesktopInferenceRelay(): Promise<{
  receive: (line: string) => Promise<boolean>
  close: () => void
}> {
  let connection: Socket | undefined
  let connected = false
  const server = createServer((socket) => {
    // One app process, one link, no reconnection that could reset a protocol or budget.
    if (connected) {
      socket.destroy()
      return
    }
    connected = true
    connection = socket
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
        const data = chunk.subarray(offset, offset + 64 * 1024).toString('base64')
        if (!process.stdout.write(JSON.stringify({ event: 'inference-data', data }) + '\n'))
          socket.pause()
      }
    })
    process.stdout.on('drain', () => socket.resume())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(DESKTOP_INFERENCE_SOCKET, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  server.on('error', () => connection?.destroy())
  // Fresh guest-owned settings, using the supported custom-provider and model settings.
  // No host profile, model key, account or upstream URL is transferred.
  const userData = copseUserDataDir({ COPSE_DIR: '/tmp/copse' })
  await mkdir(userData, { recursive: true, mode: 0o700 })
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      model: DESKTOP_PARENT_MODEL,
      extraProviders: [
        {
          slug: 'isolated-parent',
          label: 'Approved parent session model',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'session', contextWindow: 128_000 }],
        },
      ],
    }),
    { mode: 0o600 },
  )
  return {
    async receive(line): Promise<boolean> {
      if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Inference frame exceeds the limit')
      const frame = safeJsonParse(line, decodeWithSchema(responseSchema))
      if (!frame) return false
      const socket = connection
      if (!socket || socket.destroyed) throw new Error('Inference connection is unavailable')
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(frame.data, 'base64'), (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      return true
    },
    close(): void {
      connection?.destroy()
      server.close()
    },
  }
}
