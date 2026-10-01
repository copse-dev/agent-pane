import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { GORTEX_EXCLUDE_PATTERNS } from './index-ignore.ts'
import { ensureSemanticIndex, probeSemanticBackends, stopGortexDaemon } from './semantic-index.ts'

/**
 * A stand-in `gortex` on PATH with the two behaviours the quit path must
 * survive, both measured against gortex v0.60.0 on Linux: `daemon start
 * --detach` writes the pidfile only as it returns, and `track` starts a daemon
 * of its own when none answers. Every daemon it starts is logged so the test
 * can check none outlives the stop.
 */
function writeFakeGortex(binDir: string): void {
  const script = join(binDir, 'gortex')
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const dir = path.dirname(process.argv[1])
const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'))
const pidfile = path.join(process.env.HOME, '.gortex', 'cache', 'daemon.pid')
const log = (line) => fs.appendFileSync(path.join(dir, 'events.log'), line + '\\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const running = () => {
  try {
    process.kill(Number(fs.readFileSync(pidfile, 'utf8')), 0)
    return true
  } catch {
    return false
  }
}
const startDaemon = () => {
  const child = spawn(process.execPath, [process.argv[1], 'daemon', 'run'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.mkdirSync(path.dirname(pidfile), { recursive: true })
  fs.writeFileSync(pidfile, String(child.pid))
  log('daemon ' + child.pid)
}
void (async () => {
  const [verb, sub] = process.argv.slice(2)
  if (verb === 'daemon' && sub === 'run') return void setInterval(() => {}, 1000)
  if (verb === 'daemon' && sub === 'status') process.exit(running() ? 0 : 1)
  if (verb === 'daemon' && sub === 'start') {
    log('start')
    if (running()) process.exit(1)
    await sleep(timing.startMs)
    return startDaemon()
  }
  if (verb === 'track') {
    log('track')
    await sleep(timing.connectMs)
    if (!running()) startDaemon()
    return void (await sleep(timing.waitMs))
  }
})()
`,
    'utf8',
  )
  chmodSync(script, 0o755)
}

function readEvents(binDir: string): string[] {
  try {
    return readFileSync(join(binDir, 'events.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** Every daemon the fake has started, kept across sessions so a failing run still reaps them. */
const startedDaemons = new Set<number>()

function daemonPids(binDir: string): number[] {
  const pids = readEvents(binDir)
    .filter((line) => line.startsWith('daemon '))
    .map((line) => Number(line.slice('daemon '.length)))
  for (const pid of pids) startedDaemons.add(pid)
  return pids
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Daemons the fake started that are still running once any SIGTERM has landed. */
async function survivingDaemons(binDir: string): Promise<number[]> {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  return daemonPids(binDir).filter(isAlive)
}

describe(
  'stopGortexDaemon while the index pipeline is running',
  { skip: process.platform === 'win32' },
  () => {
    const originalPath = process.env['PATH']
    const originalUserData = process.env['COPSE_PANEL_USER_DATA']
    let root = ''
    let binDir = ''
    let userData = ''

    before(() => {
      root = mkdtempSync(join(tmpdir(), 'copse-gortex-quit-'))
      binDir = join(root, 'bin')
      userData = join(root, 'user-data')
      mkdirSync(binDir)
      writeFakeGortex(binDir)
      process.env['PATH'] = [binDir, originalPath].join(delimiter)
      process.env['COPSE_PANEL_USER_DATA'] = userData
    })

    after(() => {
      daemonPids(binDir)
      for (const pid of startedDaemons) {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
      process.env['PATH'] = originalPath
      if (originalUserData === undefined) delete process.env['COPSE_PANEL_USER_DATA']
      else process.env['COPSE_PANEL_USER_DATA'] = originalUserData
      rmSync(root, { recursive: true, force: true })
    })

    /** A fresh app session: empty gortex home with excludes already written, a new workspace. */
    async function startSession(timing: {
      startMs: number
      connectMs: number
      waitMs: number
    }): Promise<string> {
      rmSync(join(userData, 'gortex'), { recursive: true, force: true })
      mkdirSync(join(userData, 'gortex', '.gortex'), { recursive: true })
      writeFileSync(
        join(userData, 'gortex', '.gortex', 'config.yaml'),
        ['exclude:', ...GORTEX_EXCLUDE_PATTERNS.map((p) => `    - ${p}`), ''].join('\n'),
      )
      writeFileSync(join(binDir, 'timing.json'), JSON.stringify(timing))
      daemonPids(binDir)
      rmSync(join(binDir, 'events.log'), { force: true })
      assert.equal(await probeSemanticBackends(), 'gortex')
      return mkdtempSync(join(root, 'workspace-'))
    }

    it('reaps a daemon whose `daemon start` was still running at quit', async () => {
      const workspace = await startSession({ startMs: 500, connectMs: 0, waitMs: 0 })
      const indexing = ensureSemanticIndex(workspace)
      await waitFor(() => readEvents(binDir).includes('start'), '`daemon start`')

      await stopGortexDaemon()
      await indexing

      assert.equal(daemonPids(binDir).length, 1, 'the in-flight start still brings up its daemon')
      assert.deepEqual(await survivingDaemons(binDir), [])
    })

    it('does not let a connecting `track` restart the daemon quit killed', async () => {
      const workspace = await startSession({ startMs: 0, connectMs: 300, waitMs: 5_000 })
      const indexing = ensureSemanticIndex(workspace)
      await waitFor(() => readEvents(binDir).includes('track'), '`track`')

      await stopGortexDaemon()
      await indexing

      assert.equal(daemonPids(binDir).length, 1, 'no replacement daemon was started')
      assert.deepEqual(await survivingDaemons(binDir), [])
    })

    it('starts nothing once the daemon has been stopped', async () => {
      const workspace = await startSession({ startMs: 0, connectMs: 0, waitMs: 0 })
      await stopGortexDaemon()
      await ensureSemanticIndex(workspace)

      assert.deepEqual(readEvents(binDir), [])
    })
  },
)
