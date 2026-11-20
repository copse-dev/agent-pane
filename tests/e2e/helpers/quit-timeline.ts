/**
 * The harness's outside view of each relaunch's quit, for issue #4407.
 * DO-NOT-MERGE diagnostic branch: it observes, and changes nothing a spec does.
 *
 * `wdio.conf.ts` starts a tracker just before its pre-close (`markQuit()` then
 * `closeWindow()`) and marks each step. Until the outgoing Electron is gone and
 * nothing holds its devtools port, the tracker polls `/proc` (Linux) for:
 *
 * - the outgoing main process's state (`R`/`S`/`D`/`Z`/gone);
 * - the sockets on its devtools port and which processes hold them, with argv.
 *   Chromium does not mark that socket close-on-exec and libuv on Linux does
 *   not close inherited descriptors (see debug-port.ts), so a child can keep
 *   ChromeDriver's connection open after the app itself has exited;
 * - its descendants, as they appear and disappear, with argv.
 *
 * On finishing it merges its lines with the app's own `app-<pid>.log`
 * (tests/e2e/electron-shell/quit-timeline-fixture.cjs) into one
 * `relaunch-<n>-<spec>-pid<pid>.log`, offsets relative to the pre-close, and
 * appends a one-line summary to `summary.log` and to the worker's stdout.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { clearInterval, setInterval } from 'node:timers'
import { nonEmptyStringOr } from '@copse/std/unknown-value.ts'
import { readChromeOptions } from './chrome-options.ts'

export const QUIT_TIMELINE_DIR_ENV = 'COPSE_E2E_QUIT_TIMELINE_DIR'

/** Outside the checkout, so these writes never reach a workspace watcher. */
export function quitTimelineDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmptyStringOr(
    env[QUIT_TIMELINE_DIR_ENV]?.trim(),
    join(tmpdir(), 'copse-e2e-quit-timeline'),
  )
}

const POLL_MS = 250
/** Process-tree and socket-holder scans run every this many polls. */
const SCAN_EVERY = 4
const TRACK_CAP_MS = 120_000
const ARGV_CHARS = 400
/** A relaunch slower than this, by any measure, gets its full timeline printed. */
export const SLOW_RELAUNCH_MS = 10_000

export interface ProcStat {
  pid: number
  comm: string
  state: string
  ppid: number
}

/** Parse `/proc/<pid>/stat`. `comm` may itself contain spaces and parentheses. */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const ppid = Number(fields[1])
  if (!Number.isInteger(pid) || state === undefined || !Number.isInteger(ppid)) return null
  return { pid, comm: text.slice(open + 1, close), state, ppid }
}

const TCP_STATES: Readonly<Record<string, string>> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
}

export interface PortSocket {
  inode: string
  state: string
}

/**
 * Sockets in a `/proc/net/tcp{,6}` table whose *local* port is `port`, i.e.
 * the app side of the devtools connection. Inode 0 (TIME_WAIT, no owner) is
 * dropped: nothing can hold it.
 */
export function parseNetTcp(text: string, port: number): PortSocket[] {
  const found: PortSocket[] = []
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    const local = fields[1]
    const stateCode = fields[3]
    const inode = fields[9]
    if (local === undefined || stateCode === undefined || inode === undefined) continue
    const localPort = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16)
    if (localPort !== port || inode === '0') continue
    found.push({ inode, state: TCP_STATES[stateCode.toUpperCase()] ?? stateCode })
  }
  return found
}

/** The `--remote-debugging-port=` an Electron session was launched with. */
export function debugPortFromCapabilities(capabilities: unknown): number | null {
  try {
    const prefix = '--remote-debugging-port='
    const arg = (readChromeOptions(capabilities).args ?? []).find((a) => a.startsWith(prefix))
    const port = arg === undefined ? Number.NaN : Number(arg.slice(prefix.length))
    return Number.isInteger(port) ? port : null
  } catch {
    return null
  }
}

export interface TimelineLine {
  at: number
  source: string
  event: string
  detail: string
}

/** Parse one `<ISO time> <source> <event> <detail>` line. */
export function parseTimelineLine(line: string): TimelineLine | null {
  const match = /^(\S+) (\S+) (\S+)(?: (.*))?$/.exec(line)
  if (!match) return null
  const [, iso, source, event, detail] = match
  if (iso === undefined || source === undefined || event === undefined) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return { at, source, event, detail: detail ?? '' }
}

export interface RelaunchSummaryInput {
  seq: number
  spec: string
  pid: number | null
  port: number | null
  t0: number
  lines: readonly TimelineLine[]
}

export interface RelaunchSummary {
  slow: boolean
  text: string
}

type LineTest = (line: TimelineLine) => boolean

function firstAt(lines: readonly TimelineLine[], test: LineTest): number | null {
  return lines.find(test)?.at ?? null
}

/** One line per relaunch: when each quit milestone happened, relative to the pre-close. */
export function summariseRelaunch(input: RelaunchSummaryInput): RelaunchSummary {
  const { lines, t0 } = input
  const rel = (at: number | null): string => (at === null ? 'none' : `+${String(at - t0)}ms`)
  const app =
    (event: string): LineTest =>
    (line) =>
      line.source === 'app' && line.event === event
  const harness =
    (event: string): LineTest =>
    (line) =>
      line.source === 'harness' && line.event === event
  const shutdown =
    (pattern: RegExp): LineTest =>
    (line) =>
      line.source === 'app' && line.event === 'console' && pattern.test(line.detail)

  const closeStart = firstAt(lines, harness('closeWindow:start'))
  const closeEnd = firstAt(
    lines,
    (line) =>
      line.source === 'harness' &&
      (line.event === 'closeWindow:end' || line.event === 'pre-close:error') &&
      (closeStart === null || line.at >= closeStart),
  )
  const closeError = lines.find(harness('pre-close:error'))?.detail
  const closeMs = closeStart !== null && closeEnd !== null ? closeEnd - closeStart : null

  const outcomeLine = lines.find(shutdown(/\[shutdown\] cleanup:outcome /))
  const outcome = /cleanup:outcome (\S+)/.exec(outcomeLine?.detail ?? '')?.[1] ?? 'none'
  // The call that ended the process: a hard exit if there was one, else the
  // last quit (the first is usually Electron's own after the last window).
  const exitCall = lines.find(app('app.exit-called')) ?? lines.filter(app('app.quit-called')).at(-1)

  const steps: { name: string; ms: number }[] = []
  for (const line of lines) {
    if (line.source !== 'app' || line.event !== 'console') continue
    const match = /\[shutdown\] step:end (\S+) ([\d.]+)ms/.exec(line.detail)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      steps.push({ name: match[1], ms: Number(match[2]) })
    }
  }
  steps.sort((a, b) => b.ms - a.ms)
  const openAtDeadline =
    /deadline: open steps (.*)$/.exec(
      lines.find(shutdown(/\[shutdown\] deadline: open steps /))?.detail ?? '',
    )?.[1] ?? 'n/a'

  const childCounts = new Map<string, number>()
  for (const line of lines) {
    if (line.source !== 'app' || line.event !== 'child' || !line.detail.startsWith('deadline-'))
      continue
    const comm = /comm=(\S+)/.exec(line.detail)?.[1] ?? '?'
    childCounts.set(comm, (childCounts.get(comm) ?? 0) + 1)
  }
  const stalls = lines.filter(app('loop-stall')).map((line) => Number.parseInt(line.detail, 10))
  const pidGone = firstAt(lines, harness('pid-gone'))
  // Who still held the devtools port once the app itself had gone: what keeps
  // ChromeDriver's connection open after the process it launched exited.
  const holdersAfterExit =
    pidGone === null
      ? 'n/a'
      : (lines.find((line) => harness('port-holders')(line) && line.at >= pidGone)?.detail ?? 'n/a')
  const portFree = firstAt(lines, harness('port-free'))

  const slow =
    closeMs === null ||
    closeMs > SLOW_RELAUNCH_MS ||
    pidGone === null ||
    pidGone - t0 > SLOW_RELAUNCH_MS ||
    outcome === 'timed-out'

  const fields = [
    `#${String(input.seq)}`,
    input.spec,
    `pid=${input.pid === null ? '?' : String(input.pid)}`,
    `port=${input.port === null ? '?' : String(input.port)}`,
    `closeWindow=${closeMs === null ? '?' : `${String(closeMs)}ms`}${closeError ? '(error)' : ''}`,
    `window-close=${rel(firstAt(lines, app('window-close')))}`,
    `window-closed=${rel(firstAt(lines, app('window-closed')))}`,
    `before-quit=${rel(firstAt(lines, app('before-quit')))}`,
    `cleanup=${outcome}@${rel(outcomeLine?.at ?? null)}`,
    `exit-call=${exitCall ? `${exitCall.event.replace('-called', '')}@${rel(exitCall.at)}` : 'none'}`,
    `will-quit=${rel(firstAt(lines, app('will-quit')))}`,
    `process-exit=${rel(firstAt(lines, app('process-exit')))}`,
    `pid-gone=${pidGone === null ? 'NOT-SEEN' : rel(pidGone)}`,
    `port-free=${portFree === null ? 'NOT-SEEN' : rel(portFree)}`,
    `holders-after-exit=[${holdersAfterExit}]`,
    `reload-end=${rel(firstAt(lines, harness('reloadSession:end')))}`,
    `slowest=[${steps
      .slice(0, 3)
      .map((step) => `${step.name}:${step.ms.toFixed(0)}ms`)
      .join(',')}]`,
    `open@deadline=[${openAtDeadline}]`,
    `children@deadline=[${[...childCounts].map(([comm, n]) => `${comm}x${String(n)}`).join(',')}]`,
    `stalls=${String(stalls.length)}/max${String(stalls.length === 0 ? 0 : Math.max(...stalls))}ms`,
  ]
  return { slow, text: `${slow ? 'SLOW ' : ''}${fields.join(' ')}` }
}

// --- /proc readers (Linux; every reader returns empty elsewhere) -------------

const onLinux = process.platform === 'linux'

function readProcStat(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'))
  } catch {
    return null
  }
}

function readFullArgv(pid: number): string {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .join(' ')
  } catch {
    return '?'
  }
}

function readArgv(pid: number): string {
  const argv = readFullArgv(pid)
  return argv.length > ARGV_CHARS ? `${argv.slice(0, ARGV_CHARS)}…` : argv
}

function listPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
  } catch {
    return []
  }
}

/** The Electron main process launched with this devtools port (not a `--type=` helper). */
function findAppPid(port: number): number | null {
  if (!onLinux) return null
  for (const pid of listPids()) {
    // The full argv: Chromium puts the port well past the shortened form.
    const argv = readFullArgv(pid)
    if (argv.includes(`--remote-debugging-port=${String(port)}`) && !argv.includes('--type=')) {
      return pid
    }
  }
  return null
}

function portSockets(port: number): PortSocket[] {
  if (!onLinux) return []
  const sockets: PortSocket[] = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      sockets.push(...parseNetTcp(readFileSync(table, 'utf8'), port))
    } catch {
      // No IPv6 table on this host.
    }
  }
  return sockets
}

/** Which processes hold any of these socket inodes, as `pid -> inodes`. */
function socketHolders(inodes: ReadonlySet<string>): Map<number, string[]> {
  const holders = new Map<number, string[]>()
  if (!onLinux || inodes.size === 0) return holders
  for (const pid of listPids()) {
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${String(pid)}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = readlinkSync(`/proc/${String(pid)}/fd/${fd}`)
      } catch {
        continue
      }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
      if (inode === undefined || !inodes.has(inode)) continue
      holders.set(pid, [...(holders.get(pid) ?? []), inode])
    }
  }
  return holders
}

function descendants(root: number): ProcStat[] {
  if (!onLinux) return []
  const byParent = new Map<number, ProcStat[]>()
  for (const pid of listPids()) {
    const stat = readProcStat(pid)
    if (!stat) continue
    byParent.set(stat.ppid, [...(byParent.get(stat.ppid) ?? []), stat])
  }
  const found: ProcStat[] = []
  const queue = [root]
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of byParent.get(parent) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

// --- the tracker -------------------------------------------------------------

let relaunchSeq = 0
let currentSpec = 'unknown-spec'
let currentTest = ''
const active = new Set<RelaunchTracker>()

export function setQuitTimelineSpec(spec: string | undefined): void {
  currentSpec = spec === undefined ? 'unknown-spec' : basename(spec)
}

export function setQuitTimelineTest(title: string): void {
  currentTest = title
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

export class RelaunchTracker {
  readonly seq: number
  readonly spec: string
  readonly t0 = Date.now()
  readonly port: number | null
  readonly pid: number | null
  private readonly dir: string
  private readonly file: string
  private readonly lines: string[] = []
  private readonly timer: NodeJS.Timeout | null
  private polls = 0
  private finished = false
  private lastPidState: string | null = null
  private lastSockets = ''
  private lastHolders = ''
  private readonly knownHolders = new Set<number>()
  private knownChildren = new Map<number, string>()
  private pidGone = false
  private reloadDone = false
  private portFree = false

  constructor(capabilities: unknown, dir = quitTimelineDir()) {
    relaunchSeq += 1
    this.seq = relaunchSeq
    this.spec = currentSpec
    this.dir = dir
    this.port = debugPortFromCapabilities(capabilities)
    this.pid = this.port === null ? null : findAppPid(this.port)
    const name = `relaunch-${String(this.seq).padStart(3, '0')}-${this.spec}`
    this.file = join(dir, `${name}.harness.log`)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Recording is best-effort; the relaunch goes ahead regardless.
    }
    this.mark(
      'relaunch:start',
      `spec=${this.spec} test=${JSON.stringify(currentTest)} pid=${String(this.pid)} ` +
        `port=${String(this.port)} platform=${process.platform}`,
    )
    this.timer =
      onLinux && this.pid !== null
        ? setInterval(() => {
            this.poll()
          }, POLL_MS)
        : null
    this.timer?.unref()
    active.add(this)
    if (this.timer !== null) this.poll()
  }

  mark(event: string, detail?: string): void {
    const line = `${new Date().toISOString()} harness ${event}${detail ? ` ${detail}` : ''}`
    this.lines.push(line)
    try {
      appendFileSync(this.file, `${line}\n`)
    } catch {
      // Best-effort.
    }
  }

  markError(event: string, error: unknown): void {
    this.mark(event, describeError(error))
  }

  /** `reloadSession` returned. A tracker that cannot poll has nothing left to wait for. */
  reloadEnded(error: unknown): void {
    if (error === undefined) this.mark('reloadSession:end')
    else this.markError('reloadSession:end', error)
    this.reloadDone = true
    if (this.timer === null || (this.pidGone && this.portFree)) this.finish('reload-ended')
  }

  private poll(): void {
    if (this.finished || this.pid === null || this.port === null) return
    this.polls += 1
    const stat = this.pidGone ? null : readProcStat(this.pid)
    const pidState = stat === null ? 'gone' : stat.state
    if (pidState !== this.lastPidState) {
      this.mark('pid-state', `${this.lastPidState ?? 'start'}->${pidState}`)
      this.lastPidState = pidState
    }
    let forceScan = false
    if (!this.pidGone && (pidState === 'gone' || pidState === 'Z')) {
      this.pidGone = true
      this.mark('pid-gone', `state=${pidState}`)
      forceScan = true
    }

    const sockets = portSockets(this.port)
    const socketSummary = summariseStates(sockets.map((socket) => socket.state))
    const socketsChanged = socketSummary !== this.lastSockets
    if (socketsChanged) {
      this.mark('port-sockets', socketSummary || 'none')
      this.lastSockets = socketSummary
    }
    if (!this.portFree && sockets.length === 0) {
      this.portFree = true
      this.mark('port-free')
    }

    if (forceScan || socketsChanged || this.polls % SCAN_EVERY === 1) {
      this.scanHolders(sockets)
      if (!this.pidGone) this.scanChildren()
    }

    if (this.pidGone && this.portFree && this.reloadDone) this.finish('done')
    else if (Date.now() - this.t0 > TRACK_CAP_MS) this.finish('cap')
  }

  private scanHolders(sockets: readonly PortSocket[]): void {
    const stateByInode = new Map(sockets.map((socket) => [socket.inode, socket.state]))
    const holders = socketHolders(new Set(stateByInode.keys()))
    const summary = [...holders]
      .sort(([a], [b]) => a - b)
      .map(([pid, inodes]) => {
        const comm = readProcStat(pid)?.comm ?? '?'
        const states = summariseStates(inodes.map((inode) => stateByInode.get(inode) ?? '?'))
        return `${String(pid)}:${comm}[${states}]`
      })
      .join(' ')
    if (summary !== this.lastHolders) {
      this.mark('port-holders', summary || 'none')
      this.lastHolders = summary
    }
    for (const pid of holders.keys()) {
      if (this.knownHolders.has(pid)) continue
      this.knownHolders.add(pid)
      const stat = readProcStat(pid)
      this.mark(
        'holder',
        `pid=${String(pid)} ppid=${String(stat?.ppid ?? '?')} comm=${stat?.comm ?? '?'} argv=${readArgv(pid)}`,
      )
    }
  }

  private scanChildren(): void {
    if (this.pid === null) return
    const now = new Map(descendants(this.pid).map((child) => [child.pid, child.comm]))
    for (const [pid, comm] of now) {
      if (this.knownChildren.has(pid)) continue
      this.mark('child+', `pid=${String(pid)} comm=${comm} argv=${readArgv(pid)}`)
    }
    for (const [pid, comm] of this.knownChildren) {
      if (!now.has(pid)) this.mark('child-', `pid=${String(pid)} comm=${comm}`)
    }
    this.knownChildren = now
  }

  /** Read through a call, so a `finish()` inside `poll()` is seen. */
  private hasFinished(): boolean {
    return this.finished
  }

  /** Stop polling, merge with the app's own log, and write the summary. */
  finish(reason: string): void {
    if (this.finished) return
    if (reason !== 'done' && reason !== 'cap' && this.timer !== null) {
      // One last look before stopping; it may itself finish the tracker.
      this.poll()
      if (this.hasFinished()) return
    }
    this.finished = true
    if (this.timer !== null) clearInterval(this.timer)
    active.delete(this)
    this.mark('finish', reason)

    const appLines: string[] = []
    if (this.pid !== null) {
      try {
        appLines.push(
          ...readFileSync(join(this.dir, `app-${String(this.pid)}.log`), 'utf8').split('\n'),
        )
      } catch {
        // The app never wrote one (fixture off, or a pid we could not find).
      }
    }
    const parsed = [...this.lines, ...appLines]
      .flatMap((line) => {
        const timelineLine = parseTimelineLine(line)
        return timelineLine === null ? [] : [timelineLine]
      })
      .filter((line) => line.at >= this.t0 - 2_000 || line.event === 'start')
      .sort((a, b) => a.at - b.at)
    const summary = summariseRelaunch({
      seq: this.seq,
      spec: this.spec,
      pid: this.pid,
      port: this.port,
      t0: this.t0,
      lines: parsed,
    })
    const body = parsed.map((line) => {
      const offset = `${line.at - this.t0 >= 0 ? '+' : ''}${String(line.at - this.t0)}ms`
      return `${offset.padStart(9)} ${line.source.padEnd(7)} ${line.event}${line.detail ? ` ${line.detail}` : ''}`
    })
    const name = `relaunch-${String(this.seq).padStart(3, '0')}-${this.spec}-pid${String(this.pid)}`
    try {
      appendFileSync(
        join(this.dir, `${name}.log`),
        [`# ${summary.text}`, `# t0=${new Date(this.t0).toISOString()}`, ...body, ''].join('\n'),
      )
      appendFileSync(join(this.dir, 'summary.log'), `${summary.text} file=${name}.log\n`)
    } catch {
      // Best-effort.
    }
    console.log(`[quit-timeline] ${summary.text}`)
  }
}

function summariseStates(states: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1)
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, n]) => `${state}:${String(n)}`)
    .join(',')
}

/** Finish every tracker still running (the worker's session is ending). */
export function finishAllQuitTimelines(reason: string): void {
  for (const tracker of [...active]) tracker.finish(reason)
}

let latest: RelaunchTracker | null = null

/** Start tracking the relaunch about to happen. */
export function beginRelaunchQuitTimeline(capabilities: unknown): RelaunchTracker {
  latest = new RelaunchTracker(capabilities)
  return latest
}

/** The most recently started tracker, for marks after the relaunch. */
export function latestRelaunchQuitTimeline(): RelaunchTracker | null {
  return latest
}
