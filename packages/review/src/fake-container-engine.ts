// A stand-in container engine for the tests: a Node script that speaks the
// engine verbs the container backend uses (`create`, `start`, `rm`, `image
// inspect`, and Apple container's `delete` and space-separated flags), the
// liveness probes (`info`, `system status`) and `build`, which only records the
// tag as present. It runs
// the command on the host instead of in a container, in
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
const createDelayMs = Number(process.argv[3])
const [verb, ...rest] = process.argv.slice(4)

function record(name, data) {
  fs.writeFileSync(path.join(registry, name + '.json'), JSON.stringify(data))
}

function present(image) {
  return image === ${JSON.stringify(FAKE_IMAGE)} || fs.existsSync(path.join(registry, 'images', encodeURIComponent(image)))
}

if (verb === 'info' || verb === 'system') process.exit(0)

if (verb === 'build') {
  const tag = rest[rest.indexOf('--tag') + 1]
  fs.mkdirSync(path.join(registry, 'images'), { recursive: true })
  fs.writeFileSync(path.join(registry, 'images', encodeURIComponent(tag)), JSON.stringify(rest))
  process.exit(0)
}

if (verb === 'image') {
  const image = rest[rest.length - 1]
  if (present(image)) { process.stdout.write('sha256:fake\\n'); process.exit(0) }
  process.stderr.write('Error response from daemon: No such image: ' + image + '\\n')
  process.exit(1)
}

if (verb === 'rm' || verb === 'delete') {
  const name = rest[rest.length - 1]
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(registry, name + '.json'), 'utf8'))
    if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') } }
  } catch {}
  fs.rmSync(path.join(registry, name + '.active'), { force: true })
  fs.writeFileSync(path.join(registry, name + '.removed'), '')
  process.exit(0)
}

if (verb === 'inspect') {
  // Apple container's read-back: the configuration the create flags asked for,
  // as Apple container reports it. inspect-override.json in the registry
  // stands in for an engine that accepted a flag and did not apply it.
  const name = rest[rest.length - 1]
  let data
  try { data = JSON.parse(fs.readFileSync(path.join(registry, name + '.json'), 'utf8')) } catch {
    process.stderr.write('Error: container not found: ' + name + '\\n')
    process.exit(1)
  }
  const f = data.flags
  const values = (flag) => f.flatMap((value, index) => (f[index - 1] === flag ? [value] : []))
  const one = (flag) => values(flag)[0]
  const nproc = (one('--ulimit') || '').replace('nproc=', '').split(':').map(Number)
  const memory = one('--memory') || ''
  const units = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }
  const memoryInBytes = Number(memory.slice(0, -1)) * (units[memory.slice(-1).toLowerCase()] || 1)
  const mounts = [
    ...values('--tmpfs').map((spec) => {
      const at = spec.indexOf(':')
      return { destination: spec.slice(0, at), source: 'tmpfs', options: spec.slice(at + 1).split(','), type: { tmpfs: {} } }
    }),
    ...values('--volume').map((spec) => {
      const [source, destination, mode] = spec.split(':')
      return { destination, source, options: mode === 'ro' ? ['ro'] : [], type: { virtiofs: {} } }
    }),
  ]
  const configuration = {
    capAdd: [],
    capDrop: values('--cap-drop'),
    readOnly: f.includes('--read-only'),
    networks: one('--network') === 'none' ? [] : ['default'],
    useInit: f.includes('--init'),
    ssh: false,
    virtualization: false,
    publishedPorts: [],
    publishedSockets: [],
    labels: Object.fromEntries(values('--label').map((label) => [label.slice(0, label.indexOf('=')), label.slice(label.indexOf('=') + 1)])),
    resources: { cpus: Number(one('--cpus')), memoryInBytes },
    initProcess: { user: { raw: { userString: one('--user') || '0:0' } }, rlimits: [{ limit: 'RLIMIT_NPROC', soft: nproc[0], hard: nproc[1] }] },
    mounts,
  }
  const override = path.join(registry, 'inspect-override.json')
  if (fs.existsSync(override)) Object.assign(configuration, JSON.parse(fs.readFileSync(override, 'utf8')))
  process.stdout.write(JSON.stringify([{ configuration, status: { state: 'stopped' } }]))
  process.exit(0)
}

if (verb === 'start') {
  const name = rest[rest.length - 1]
  if (!fs.existsSync(path.join(registry, name + '.active'))) process.exit(125)
  const data = JSON.parse(fs.readFileSync(path.join(registry, name + '.json'), 'utf8'))
  const { argv, cwd, env } = data
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  record(name, { ...data, pid: child.pid })
  child.on('error', (err) => { process.stderr.write(String(err) + '\\n'); process.exit(126) })
  child.on('exit', (code, signal) => { process.exit(signal ? 137 : (code ?? 1)) })
  return
}

if (verb !== 'create') { process.stderr.write('fake engine: unknown verb ' + verb + '\\n'); process.exit(125) }

const withValue = new Set([
  '--name', '--workdir', '--env', '--label', '--mount', '--volume', '--user', '--entrypoint',
  // Apple container's spelling of the same walls takes its values separately.
  '--cap-drop', '--ulimit', '--memory', '--cpus', '--tmpfs', '--network',
])
let name = ''
let entrypoint = '/app/entrypoint.sh'
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
    else if (arg === '--entrypoint') entrypoint = value
    else if (arg === '--workdir') cwd = value
    else if (arg === '--env') { const eq = value.indexOf('='); env[value.slice(0, eq)] = value.slice(eq + 1) }
    else flags.push(value)
  }
}
const image = rest[i]
let argv = [entrypoint, ...rest.slice(i + 1)]
// The host has no kernel flag to set for the cell, so the Apple dialect's
// \`setpriv --no-new-privs -- <argv>\` wrapper runs <argv> directly here.
if (entrypoint === 'setpriv' && argv[1] === '--no-new-privs' && argv[2] === '--') argv = argv.slice(3)
if (!present(image)) {
  process.stderr.write('Unable to find image ' + image + ' locally\\n')
  process.exit(125)
}
fs.writeFileSync(path.join(registry, name + '.creating'), '')
setTimeout(() => {
  record(name, { cwd, env, flags, image, argv })
  fs.writeFileSync(path.join(registry, name + '.active'), '')
  process.stdout.write(name + '\\n')
}, createDelayMs)
`

/**
 * Write the fake engine beside `registryDir` (where it records each run) and
 * return the engine argv the backend takes.
 */
export async function writeFakeContainerEngine(
  registryDir: string,
  createDelayMs = 0,
): Promise<ContainerEngine> {
  const script = join(registryDir, 'fake-engine.cjs')
  await writeFile(script, FAKE_ENGINE_SOURCE)
  return [process.execPath, script, registryDir, String(createDelayMs)]
}
