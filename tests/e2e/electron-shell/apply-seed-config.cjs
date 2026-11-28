'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Consume a fixture once, after the old Electron process has shut down. */
function applyPendingSeedConfig(profileRoot, workspaceRoot = path.join(profileRoot, 'workspace')) {
  let seeded = false
  for (const name of ['config', 'settings', 'last-run']) {
    try {
      fs.renameSync(
        path.join(profileRoot, `.e2e-pending-${name}.json`),
        path.join(profileRoot, `${name}.json`),
      )
      seeded = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  // A fixture wrote a new profile: a turn host the previous app started read the
  // old one (and the old app's environment), so this app must start its own.
  // A relaunch with no new fixture keeps it, as a crash relaunch does.
  if (seeded) stopProfileTurnHosts(profileRoot)
  // Only fixtures that directly rewrote thread files request this one-shot reset.
  // Ordinary relaunches preserve the projection, just like production startup.
  let projects
  try {
    projects = fs.readdirSync(workspaceRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(workspaceRoot, project.name)
    // A fixture asked for this whole project store to go once the app that had
    // its thread index open has exited (see removeProjectStoreOnRelaunch).
    if (fs.existsSync(path.join(dir, '.e2e-remove-project'))) {
      fs.rmSync(dir, { recursive: true, force: true })
      continue
    }
    const marker = path.join(dir, '.e2e-reset-thread-index')
    if (!fs.existsSync(marker)) continue
    for (const file of [
      'catalog.jsonl',
      '.thread-index.sqlite',
      '.thread-index.sqlite-wal',
      '.thread-index.sqlite-shm',
      '.thread-index.sqlite-journal',
    ]) {
      fs.rmSync(path.join(dir, file), { force: true })
    }
    fs.unlinkSync(marker)
  }
}

/** Kill the turn hosts serving this profile and wait for them to exit. */
function stopProfileTurnHosts(profileRoot) {
  if (process.platform === 'win32') return
  let listing
  try {
    listing = require('node:child_process').execFileSync('ps', ['-axo', 'pid=,args='], {
      encoding: 'utf8',
    })
  } catch {
    return
  }
  const pids = listing
    .split('\n')
    .filter((line) => line.includes('turn-host.js') && line.includes(`--user-data ${profileRoot}`))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const tick = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5000
  while (pids.some(alive) && Date.now() < deadline) Atomics.wait(tick, 0, 0, 20)
}

module.exports = { applyPendingSeedConfig }
