import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativePreparationSteps } from './lib/native-preparation-steps.mts'
import { recordLifecycleInstall } from './lib/dev-sync.mts'

const root = process.cwd()
const steps = nativePreparationSteps(process.platform)

for (const step of steps) {
  const absolute = join(root, step.path)
  if (!existsSync(absolute)) {
    throw new Error(`${step.label} input is missing: ${step.path}`)
  }
  console.log(`==> ${step.label}…`)
  const result = spawnSync(process.execPath, [absolute], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${step.label} failed (${result.signal ?? String(result.status)})`)
  }
}

try {
  if (recordLifecycleInstall(root, process.env)) {
    console.log('==> Recorded this install, so make run will not repeat it')
  }
} catch (err) {
  // The install itself succeeded; without the record `make run` just installs again.
  console.warn(`==> Could not record this install for make run: ${String(err)}`)
}
