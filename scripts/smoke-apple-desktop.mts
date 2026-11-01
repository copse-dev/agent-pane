/** Experimental GUI smoke: no host mounts, networking, credentials or display forwarding. */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import {
  APPLE_DESKTOP_BOOTSTRAP,
  APPLE_DESKTOP_MAX_CONTROLLER,
} from './lib/apple-desktop-bootstrap.mts'
import { parseArgs, promisify } from 'node:util'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { appleDesktopProbeArgs, appleDesktopProbeShortfall } from './lib/apple-desktop-probe.mts'
import { APPLE_DESKTOP_MAX_PNG } from './lib/apple-desktop-wire.mts'

const eventSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('ready'),
      title: z.string().min(1).max(1000),
      width: z.literal(1280),
      height: z.literal(800),
    })
    .strict(),
  z
    .object({
      event: z.literal('screenshot'),
      png: z
        .string()
        .max(Math.ceil(APPLE_DESKTOP_MAX_PNG / 3) * 4)
        .regex(/^[a-zA-Z0-9+/]+={0,2}$/),
    })
    .strict(),
  z.object({ event: z.literal('input-complete') }).strict(),
  z.object({ event: z.literal('stopped') }).strict(),
])

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      screenshot: { type: 'string', default: '.tmp/apple-desktop.png' },
    },
  })
  if (values.help) {
    console.log(
      'Experimental Apple VM desktop smoke.\nBuild with node scripts/build-apple-desktop.mts first.\nnode scripts/run-smoke-apple-desktop.mts [--screenshot <file>]\nChecks inspect before GUI start, sends a guest-only Tab key, captures a PNG, and deletes the VM.\nNo host profile, display, model credentials or networking is granted.',
    )
    return
  }
  const guest =
    (await readFile('dist-test/apple-desktop-current-guest.cjs')).toString('base64') + '\n'
  if (Buffer.byteLength(guest) > APPLE_DESKTOP_MAX_CONTROLLER)
    throw new Error('Desktop controller exceeds the transfer limit')
  const name = `copse-desktop-probe-${randomUUID()}`
  const base = appleDesktopProbeArgs(name, 'copse-desktop:local')
  const entrypoint = base.indexOf('--entrypoint')
  const create = [
    ...base.slice(0, entrypoint),
    '--interactive',
    '--entrypoint',
    '/usr/bin/setpriv',
    'copse-desktop:local',
    '--no-new-privs',
    '--',
    '/usr/local/bin/node',
    '-e',
    APPLE_DESKTOP_BOOTSTRAP,
  ]
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const exec = promisify(execFile)
  const command = async (args: string[]): Promise<string> =>
    (
      await exec('/usr/local/bin/container', args, {
        timeout: 30000,
        maxBuffer: 256 * 1024,
        signal: controller.signal,
      })
    ).stdout
  let screenshot: Buffer | undefined
  let title = ''
  let stopped = false
  try {
    await command(create)
    const shortfall = appleDesktopProbeShortfall(name, await command(['inspect', name]))
    if (shortfall) throw new Error(`Refusing desktop startup: ${shortfall}`)
    const child = spawn('/usr/local/bin/container', ['start', '--attach', '--interactive', name], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: controller.signal,
      timeout: 90000,
      killSignal: 'SIGKILL',
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16384)
    })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Guest exited ${String(code)}: ${stderr}`))
      })
    })
    // Attach a rejection handler before reading the stream, so an early launch failure is handled.
    void completion.catch(() => undefined)
    child.stdin.on('error', () => {
      child.kill('SIGKILL')
    })
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(guest, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    child.stdout.setEncoding('utf8')
    let pending = ''
    try {
      for await (const chunk of child.stdout) {
        if (typeof chunk !== 'string') throw new Error('Expected UTF-8 guest events')
        pending += chunk
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (line.length > 6 * 1024 * 1024) throw new Error('Guest event is too large')
          const event = safeJsonParse(line, decodeWithSchema(eventSchema))
          if (!event) throw new Error('Invalid guest desktop event')
          if (event.event === 'ready' && !title) {
            title = event.title
            child.stdin.write('{"action":"key","key":"Tab"}\n')
          } else if (event.event === 'input-complete' && title && !screenshot) {
            child.stdin.write('{"action":"screenshot"}\n')
          } else if (event.event === 'screenshot' && title && !screenshot) {
            screenshot = Buffer.from(event.png, 'base64')
            if (
              screenshot.length < 24 ||
              screenshot.length > APPLE_DESKTOP_MAX_PNG ||
              !screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              screenshot.readUInt32BE(16) !== 1280 ||
              screenshot.readUInt32BE(20) !== 800
            )
              throw new Error('Invalid guest PNG')
            child.stdin.end('{"action":"stop"}\n')
          } else if (event.event === 'stopped' && screenshot) stopped = true
          else throw new Error('Unexpected guest desktop event order')
        }
        if (pending.length > 6 * 1024 * 1024) throw new Error('Guest event is too large')
      }
      await completion
      if (pending.trim() || !screenshot || !stopped)
        throw new Error('Guest desktop smoke did not complete')
    } catch (error) {
      child.kill('SIGKILL')
      throw error
    }
  } finally {
    try {
      await exec('/usr/local/bin/container', ['delete', '--force', name], {
        timeout: 30000,
        maxBuffer: 256 * 1024,
      })
    } finally {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
  }
  await writeFile(values.screenshot, screenshot, { mode: 0o600 })
  console.log(JSON.stringify({ name, title, screenshot: values.screenshot, teardown: 'complete' }))
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
