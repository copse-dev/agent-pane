// A stand-in container engine for the tests: a Node script that speaks the
// three engine verbs the container backend uses (`run`, `kill`, `image
// inspect`) and runs the command on the host instead of in a container, in
// the requested working directory and with exactly the requested environment.
// It builds no wall — the conformance test never holds it to one; the real
// engine is exercised by the gated end-to-end test — but it lets the backend's
// plumbing be checked without a daemon: argv shape, cwd, environment, exit
// codes, output, kills and cleanup. Test-only helper, kept out of the barrel.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContainerEngine } from './container-backend.ts'

/** The image the fake reports as present; any other name is "no such image". */
export const FAKE_IMAGE = 'copse-review-fake:present'

const FAKE_ENGINE_SOURCE = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const registry = process.argv[2]
const [verb, ...rest] = process.argv.slice(3)

function record(name, data) {
  fs.writeFileSync(path.join(registry, name + '.json'), JSON.stringify(data))
}

if (verb === 'image') {
  const image = rest[rest.length - 1]
  if (image === ${JSON.stringify(FAKE_IMAGE)}) { process.stdout.write('sha256:fake\\n'); process.exit(0) }
  process.stderr.write('Error response from daemon: No such image: ' + image + '\\n')
  process.exit(1)
}

if (verb === 'kill') {
  const name = rest[rest.length - 1]
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(registry, name + '.json'), 'utf8'))
    try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
  } catch {}
  process.exit(0)
}

if (verb !== 'run') { process.stderr.write('fake engine: unknown verb ' + verb + '\\n'); process.exit(125) }

const withValue = new Set(['--name', '--workdir', '--env', '--label', '--mount', '--volume', '--user'])
let name = ''
let cwd = process.cwd()
const env = { PATH: process.env.PATH }
const flags = []
let i = 0
for (; i < rest.length; i++) {
  const arg = rest[i]
  if (!arg.startsWith('--')) break
  if (arg.includes('=')) { flags.push(arg); continue }
  flags.push(arg)
  if (withValue.has(arg)) {
    const value = rest[++i]
    if (arg === '--name') name = value
    else if (arg === '--workdir') cwd = value
    else if (arg === '--env') { const eq = value.indexOf('='); env[value.slice(0, eq)] = value.slice(eq + 1) }
    else flags.push(value)
  }
}
const image = rest[i]
const argv = rest.slice(i + 1)
if (image !== ${JSON.stringify(FAKE_IMAGE)}) {
  process.stderr.write('Unable to find image ' + image + ' locally\\n')
  process.exit(125)
}
const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
record(name, { pid: child.pid, cwd, env, flags, image, argv })
child.on('error', (err) => { process.stderr.write(String(err) + '\\n'); process.exit(126) })
child.on('exit', (code, signal) => { process.exit(signal ? 137 : (code ?? 1)) })
`

/**
 * Write the fake engine beside `registryDir` (where it records each run) and
 * return the engine argv the backend takes.
 */
export async function writeFakeContainerEngine(registryDir: string): Promise<ContainerEngine> {
  const script = join(registryDir, 'fake-engine.cjs')
  await writeFile(script, FAKE_ENGINE_SOURCE)
  return [process.execPath, script, registryDir]
}
