'use strict'

/**
 * Record the app's own view of its quit, for issue #4407. DO-NOT-MERGE
 * diagnostic: it observes Electron's boundary and changes nothing the app does.
 *
 * Writes `app-<pid>.log` in `dir`, one line per event:
 *
 *   <ISO time> app <event> <detail>
 *
 * - every `[shutdown]` console line (and, once the window starts closing, every
 *   other console line, capped), with a timestamp the console lacks;
 * - window `close`/`closed`, `before-quit` (before and after the app's own
 *   handlers), `will-quit`, `quit`, `child-process-gone`, `process` `exit`;
 * - each call to `app.quit()` and `app.exit()`, with the calling frames;
 * - main-loop stalls over 200ms once the close has started;
 * - snapshots of this process's descendants (pid, state, age, argv), its
 *   windows and Node's active resources, at fixed offsets after the close
 *   starts, just before the 30s quit-cleanup deadline, and at `app.exit()`.
 *
 * The harness side (tests/e2e/helpers/quit-timeline.ts) merges this file with
 * its own outside view of the same relaunch.
 */

const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')
const { clearInterval } = require('node:timers')
const { app, BrowserWindow, webContents } = require('electron')

/** Same value as QUIT_CLEANUP_DEADLINE_MS in src/main/index.ts. */
const QUIT_CLEANUP_DEADLINE_MS = 30_000
/** Offsets after the close (or quit) starts at which to snapshot processes. */
const SNAPSHOT_OFFSETS_MS = [2_000, 10_000, 20_000, 40_000, 60_000]
const CONSOLE_LINES_AFTER_CLOSE = 400
const ARGV_CHARS = 400

const force = (target, name, value) => {
  Object.defineProperty(target, name, { value, writable: true, configurable: true })
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s*\n\s*/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** `pid (comm) state ppid …` — comm may contain spaces and parentheses. */
function readStat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = text.lastIndexOf(')')
    const comm = text.slice(text.indexOf('(') + 1, close)
    const fields = text
      .slice(close + 2)
      .trim()
      .split(' ')
    return { pid, comm, state: fields[0], ppid: Number(fields[1]), startTicks: Number(fields[19]) }
  } catch {
    return null
  }
}

function readArgv(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return oneLine(raw.split('\0').filter(Boolean).join(' '), ARGV_CHARS)
  } catch {
    return '?'
  }
}

function uptimeSeconds() {
  try {
    return Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0])
  } catch {
    return Number.NaN
  }
}

/** Every live descendant of `root`, from /proc. Linux only; [] elsewhere. */
function descendants(root) {
  if (process.platform !== 'linux') return []
  const byParent = new Map()
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readStat(Number(entry))
    if (!stat) continue
    const siblings = byParent.get(stat.ppid) ?? []
    siblings.push(stat)
    byParent.set(stat.ppid, siblings)
  }
  const found = []
  const queue = [root]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of byParent.get(parent) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

function install(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `app-${String(process.pid)}.log`)
  const write = (event, detail) => {
    const line = `${new Date().toISOString()} app ${event}${detail ? ` ${detail}` : ''}\n`
    try {
      fs.appendFileSync(file, line)
    } catch {
      // A diagnostic must never break the quit it is watching.
    }
  }

  let closeStartedAt = null
  let beforeQuitAt = null
  let beforeQuitCount = 0
  let consoleLinesAfterClose = 0

  const callers = () =>
    (new Error().stack ?? '')
      .split('\n')
      .slice(3, 7)
      .map((frame) => frame.trim().replace(/^at /, ''))
      .join(' <- ')

  const snapshot = (label) => {
    const now = Date.now()
    const since = (at) => (at === null ? 'n/a' : `${String(now - at)}ms`)
    const windows = BrowserWindow.getAllWindows().map(
      (win) =>
        `${String(win.id)}:${win.isDestroyed() ? 'destroyed' : win.isVisible() ? 'visible' : 'hidden'}`,
    )
    const contents = webContents
      .getAllWebContents()
      .map((wc) => `${String(wc.id)}:${wc.getType()}${wc.isDestroyed() ? ':destroyed' : ''}`)
    let resources = []
    try {
      resources = process.getActiveResourcesInfo()
    } catch {
      // Older Node: no resource list.
    }
    const counts = new Map()
    for (const name of resources) counts.set(name, (counts.get(name) ?? 0) + 1)
    const children = descendants(process.pid)
    write(
      'snapshot',
      `${label} since-close=${since(closeStartedAt)} since-before-quit=${since(beforeQuitAt)} ` +
        `windows=[${windows.join(',')}] webContents=[${contents.join(',')}] ` +
        `resources=[${[...counts].map(([name, n]) => `${name}x${String(n)}`).join(',')}] ` +
        `children=${String(children.length)}`,
    )
    const uptime = uptimeSeconds()
    for (const child of children) {
      const age = Number.isNaN(uptime) ? '?' : `${(uptime - child.startTicks / 100).toFixed(1)}s`
      write(
        'child',
        `${label} pid=${String(child.pid)} ppid=${String(child.ppid)} state=${child.state} ` +
          `age=${age} comm=${child.comm} argv=${readArgv(child.pid)}`,
      )
    }
  }

  // Main-loop stalls while closing: a blocked loop delays every timer, the
  // quit deadline included.
  let lagProbe = null
  const startLagProbe = () => {
    if (lagProbe !== null) return
    let due = Date.now() + 100
    lagProbe = setInterval(() => {
      const now = Date.now()
      if (now - due > 200) write('loop-stall', `${String(now - due)}ms`)
      due = now + 100
    }, 100)
    lagProbe.unref()
  }

  const startClosing = (reason) => {
    if (closeStartedAt !== null) return
    closeStartedAt = Date.now()
    write('closing', reason)
    startLagProbe()
    for (const offset of SNAPSHOT_OFFSETS_MS) {
      setTimeout(() => {
        snapshot(`close+${String(offset / 1000)}s`)
      }, offset).unref()
    }
  }

  write(
    'start',
    `pid=${String(process.pid)} ppid=${String(process.ppid)} platform=${process.platform} ` +
      `cwd=${process.cwd()} electron=${process.versions.electron ?? '?'}`,
  )

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      let text
      try {
        text = util.format(...args)
      } catch {
        return
      }
      if (text.includes('[shutdown]')) {
        write('console', oneLine(text, 1_000))
      } else if (closeStartedAt !== null && consoleLinesAfterClose < CONSOLE_LINES_AFTER_CLOSE) {
        consoleLinesAfterClose += 1
        write('console', oneLine(`${level}: ${text}`, 500))
      }
    }
  }

  app.on('browser-window-created', (_event, win) => {
    const id = String(win.id)
    write('window-created', `id=${id}`)
    win.on('close', () => {
      write('window-close', `id=${id}`)
      startClosing(`window ${id} close`)
    })
    win.on('closed', () => {
      write('window-closed', `id=${id} remaining=${String(BrowserWindow.getAllWindows().length)}`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      write('render-process-gone', `window=${id} reason=${details.reason}`)
    })
  })
  app.on('child-process-gone', (_event, details) => {
    write(
      'child-process-gone',
      `type=${details.type} reason=${details.reason} exitCode=${String(details.exitCode)}`,
    )
  })

  // Registered before the app's own handler, so it sees every attempt first.
  app.on('before-quit', () => {
    beforeQuitCount += 1
    write('before-quit', `#${String(beforeQuitCount)}`)
    startClosing('before-quit')
    if (beforeQuitAt !== null) return
    beforeQuitAt = Date.now()
    setTimeout(() => {
      snapshot('deadline-0.5s')
    }, QUIT_CLEANUP_DEADLINE_MS - 500).unref()
  })
  app.on('will-quit', () => {
    write('will-quit')
  })
  app.on('quit', (_event, exitCode) => {
    write('quit', `exitCode=${String(exitCode)}`)
  })
  process.on('exit', (code) => {
    if (lagProbe !== null) clearInterval(lagProbe)
    write('process-exit', `code=${String(code)}`)
  })

  const quit = app.quit.bind(app)
  force(app, 'quit', () => {
    write('app.quit-called', callers())
    quit()
  })
  const exit = app.exit.bind(app)
  force(app, 'exit', (code) => {
    write('app.exit-called', `code=${String(code)} ${callers()}`)
    snapshot('at-app.exit')
    exit(code)
  })

  return {
    /** Call once the app's module has registered its own handlers. */
    afterAppLoaded() {
      app.on('before-quit', (event) => {
        write('before-quit:after-handlers', `defaultPrevented=${String(event.defaultPrevented)}`)
      })
    },
  }
}

module.exports = { install }
