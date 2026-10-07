'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Consume a fixture once, after the old Electron process has shut down. */
function applyPendingSeedConfig(profileRoot, workspaceRoot = path.join(profileRoot, 'workspace')) {
  try {
    fs.renameSync(
      path.join(profileRoot, '.e2e-pending-config.json'),
      path.join(profileRoot, 'config.json'),
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
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

module.exports = { applyPendingSeedConfig }
