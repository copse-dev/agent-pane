import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const prior = process.cwd()
const { z } = createRequire(resolve(prior, 'package.json'))('zod')
const decodeWithSchema = (schema) => (value) => schema.parse(value)
const safeJsonParse = (text, decoder) => decoder(JSON.parse(text))
const sdkPath = createRequire(resolve(prior, 'package.json')).resolve('@agentclientprotocol/sdk')
const { ndJsonStream } = await import(pathToFileURL(sdkPath).href)
const messageSchema = z.looseObject({
  method: z.string().optional(),
  params: z.unknown().optional(),
})
const newSessionSchema = z.looseObject({ cwd: z.string(), mcpServers: z.array(z.unknown()) })
export function hardenMessage(message) {
  if (message.method !== 'session/new') return message
  const params = newSessionSchema.parse(message.params)
  return {
    ...message,
    params: {
      ...params,
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            tools: [],
            settingSources: [],
            mcpServers: {},
            strictMcpConfig: true,
            allowDangerouslySkipPermissions: false,
            maxTurns: 1,
          },
        },
      },
    },
  }
}
export function createTextOnlyTransport(options, cwd) {
  const child = spawn(options.command, options.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  child.stderr.resume()
  // Only protocol messages are interpreted. No fixture command ever becomes argv.
  let pending = '',
    disposed = false
  const decoder = new TextDecoder()
  const readable = Readable.toWeb(child.stdout)
  const writable = new WritableStream({
    async write(bytes) {
      pending += decoder.decode(bytes, { stream: true })
      let offset
      while ((offset = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, offset)
        pending = pending.slice(offset + 1)
        if (!line.trim()) continue
        const message = safeJsonParse(line, decodeWithSchema(messageSchema))
        await new Promise((done, fail) =>
          child.stdin.write(JSON.stringify(hardenMessage(message)) + '\n', (error) =>
            error ? fail(new Error('ACP write failed')) : done(),
          ),
        )
      }
    },
    close() {
      child.stdin.end()
    },
    abort() {
      child.stdin.destroy()
    },
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* owned process already exited */
      }
    }
    child.kill('SIGKILL')
    child.stdin.destroy()
    child.stdout.destroy()
  }
  child.on('error', () => {
    child.stdin.destroy()
    child.stdout.destroy()
  })
  return { stream: ndJsonStream(writable, readable), dispose }
}
