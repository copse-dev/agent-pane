import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

interface PreparationStep {
  label: string
  path: string
}

const root = process.cwd()
const steps: PreparationStep[] = [
  { label: 'Node version check', path: 'scripts/check-node-version.cjs' },
  {
    label: 'Electron ChromeDriver download',
    path: 'node_modules/electron-chromedriver/download-chromedriver.js',
  },
  { label: 'Electron runtime preparation', path: 'scripts/patch-dev-name.mts' },
  { label: 'native module preparation', path: 'scripts/postinstall-native.mts' },
  { label: 'gortex preparation', path: 'scripts/fetch-gortex.mts' },
]

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
