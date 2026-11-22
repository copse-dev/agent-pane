import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describeDlopenFailures } from './lib/dlopen-failure.mts'
import { nativePreparationSteps } from './lib/native-preparation-steps.mts'
import { recordLifecycleInstall } from './lib/dev-sync.mts'

const root = process.cwd()
const steps = nativePreparationSteps(process.platform)
// A failing native load reports a single long dyld line, and pnpm's install
// reporter (which reads our stderr through a pipe) cuts it at the terminal
// width. Keep a copy of a piped stderr to restate the reason on short lines. A
// terminal shows the line in full, and steps keep their TTY progress output.
const captureStderr = !process.stderr.isTTY
const MAX_CAPTURED_STDERR = 256 * 1024

interface StepOutcome {
  failure: Error | undefined
  stderr: string
}

function runStep(path: string, args: readonly string[]): Promise<StepOutcome> {
  return new Promise((resolve) => {
    let stderr = ''
    const child = spawn(process.execPath, [path, ...args], {
      cwd: root,
      env: process.env,
      stdio: ['inherit', 'inherit', captureStderr ? 'pipe' : 'inherit'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: unknown) => {
      const text = String(chunk)
      process.stderr.write(text)
      stderr = (stderr + text).slice(-MAX_CAPTURED_STDERR)
    })
    child.once('error', (error) => {
      resolve({ failure: error, stderr })
    })
    child.once('close', (status, signal) => {
      const failure = status !== 0 ? new Error(`exit ${signal ?? String(status)}`) : undefined
      resolve({ failure, stderr })
    })
  })
}

for (const step of steps) {
  const absolute = join(root, step.path)
  if (!existsSync(absolute)) {
    throw new Error(`${step.label} input is missing: ${step.path}`)
  }
  console.log(`==> ${step.label}…`)
  const { failure, stderr } = await runStep(absolute, step.args ?? [])
  if (failure) {
    const dlopenFailures = describeDlopenFailures(stderr)
    if (dlopenFailures.length > 0) {
      // Short prefixes, so dyld's reason still fits an 80-column reporter line.
      console.error(`==> ${step.label} could not load a native module:`)
      for (const line of dlopenFailures) console.error(`  ${line}`)
    }
    if (step.required === false) {
      console.warn(`==> ${step.label} failed, continuing: ${failure.message}`)
    } else {
      throw failure
    }
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
