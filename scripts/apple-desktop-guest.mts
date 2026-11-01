/** Guest-only desktop controller. Its stdout is a bounded JSON-lines protocol. */
import { spawn, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  APPLE_DESKTOP_MAX_PNG,
  APPLE_DESKTOP_MAX_REQUEST,
  decodeAppleDesktopRequest,
} from './lib/apple-desktop-wire.mts'

import { waitForAppleDesktopReady } from './lib/apple-desktop-ready.mts'
import { startDesktopInferenceRelay } from './lib/apple-desktop-inference.mts'

const exec = promisify(execFile)
const reply = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value) + '\n')
}

async function main(): Promise<void> {
  if (process.platform !== 'linux')
    throw new Error('This desktop controller runs only inside the Linux guest')
  await mkdir('/tmp/home', { recursive: true, mode: 0o700 })
  await mkdir('/tmp/runtime', { recursive: true, mode: 0o700 })
  const inference =
    process.env['COPSE_DESKTOP_INFERENCE'] === '1' ? await startDesktopInferenceRelay() : undefined
  const env = {
    ...(inference ? { COPSE_DESKTOP_INFERENCE: '1' } : {}),
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp/home',
    COPSE_DIR: '/tmp/copse',
    DISPLAY: ':99',
    XDG_RUNTIME_DIR: '/tmp/runtime',
    LANG: 'C.UTF-8',
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const display = spawn(
    '/usr/bin/Xvfb',
    [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
    { env, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  let displayError: Error | undefined
  display.once('error', (error) => {
    displayError = error
  })
  const displayDeadline = Date.now() + 10000
  let displayReady = false
  while (Date.now() < displayDeadline && !displayError && display.exitCode === null) {
    try {
      await exec('/usr/bin/xdotool', ['getmouselocation'], { env, timeout: 1000 })
      displayReady = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (!displayReady) {
    display.kill('SIGTERM')
    throw displayError ?? new Error('Guest display did not become ready')
  }
  const app = spawn(
    '/opt/copse/node_modules/electron/dist/electron',
    [
      '/opt/copse/dist/main/index.js',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
    ],
    { cwd: '/opt/copse', env, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  let stopping = false
  const stop = (): void => {
    stopping = true
    inference?.close()
    app.kill('SIGTERM')
    display.kill('SIGTERM')
  }
  // A dead host cannot leave a controlled guest running indefinitely.
  const lifetime = setTimeout(() => {
    stop()
    process.exit(0)
  }, 15 * 60_000)
  lifetime.unref()
  app.once('exit', () => {
    if (!stopping) {
      process.exitCode = 1
      console.error('Copse exited before the desktop session stopped')
    }
    process.stdin.destroy()
    display.kill('SIGTERM')
  })
  app.once('error', (error) => {
    console.error(error)
    process.exitCode = 1
    process.stdin.destroy()
    stop()
  })
  display.once('error', (error) => {
    console.error(error)
    process.exitCode = 1
    stop()
  })
  process.once('SIGTERM', () => {
    stop()
    process.exit(0)
  })
  const xdo = async (args: string[]): Promise<string> =>
    (
      await exec('/usr/bin/xdotool', args, { env, timeout: 5000, maxBuffer: 64 * 1024 })
    ).stdout.trim()
  try {
    let window = ''
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && app.exitCode === null) {
      try {
        window =
          (await xdo(['search', '--onlyvisible', '--pid', String(app.pid)])).split('\n')[0] ?? ''
      } catch {
        /* Window is not mapped yet. */
      }
      if (window) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!/^\d+$/.test(window))
      throw new Error('Copse did not map a window before the startup deadline')
    await xdo(['windowmove', window, '0', '0'])
    await xdo(['windowsize', window, '1280', '800'])
    await xdo(['windowfocus', window])
    await waitForAppleDesktopReady(Date.now() + 30000)
    reply({ event: 'ready', title: await xdo(['getwindowname', window]), width: 1280, height: 800 })
    let pending = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      if (typeof chunk !== 'string') throw new Error('Expected UTF-8 input')
      pending += chunk
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (inference && (await inference.receive(line))) continue
        const request = decodeAppleDesktopRequest(line)
        if (request.action === 'stop') {
          reply({ event: 'stopped' })
          return
        }
        if (request.action === 'screenshot') {
          await waitForAppleDesktopReady(Date.now() + 10000)
          const { stdout } = await exec('/usr/bin/import', ['-window', 'root', 'png:-'], {
            env,
            encoding: 'buffer',
            timeout: 5000,
            maxBuffer: APPLE_DESKTOP_MAX_PNG,
          })
          reply({ event: 'screenshot', png: stdout.toString('base64') })
        } else {
          if (request.action === 'click')
            await xdo([
              'mousemove',
              String(request.x),
              String(request.y),
              'click',
              String(request.button),
            ])
          else if (request.action === 'type')
            await xdo(['type', '--clearmodifiers', '--delay', '0', '--', request.text])
          else await xdo(['key', '--clearmodifiers', request.key])
          reply({ event: 'input-complete' })
        }
      }
      if (Buffer.byteLength(pending) > (inference ? 128 * 1024 : APPLE_DESKTOP_MAX_REQUEST))
        throw new Error('Desktop request is too large')
    }
    if (pending.trim()) throw new Error('Incomplete desktop request')
  } finally {
    clearTimeout(lifetime)
    stop()
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
