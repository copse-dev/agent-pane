import { z } from 'zod'
import { SSH_WORKER_BUNDLE } from './ssh-worker-package.ts'

/**
 * The commands that install and start the worker on an SSH host
 * (`docs/plans/harness-worker-roadmap.md`, R3), as argv for
 * `SshConnection.execArgv`, so nothing the app passes is parsed by the
 * host's shell.
 *
 * The host needs only Node, at least {@link MIN_NODE}: the worker brings
 * everything else with it. It lives under `~/.copse/worker/<id>/`, one
 * directory per build, with its profile inside.
 */

/** The oldest Node the worker runs on: the first with `node:sqlite` on by default. */
export const MIN_NODE = '22.13.0'

export const WORKER_HOME = '.copse/worker'

/** What the host's Node says about itself. */
export interface RemoteNode {
  version: string
  execPath: string
  home: string
}

const remoteNodeSchema = z.object({
  version: z.string().min(1).max(64),
  execPath: z.string().min(1).max(4096),
  home: z.string().min(1).max(4096),
})

const PROBE_JS =
  'console.log(JSON.stringify({version:process.versions.node,execPath:process.execPath,home:require("os").homedir()}))'

export function probeNodeArgv(): string[] {
  return ['node', '-e', PROBE_JS]
}

/** The probe's answer, or null when the host's `node` did not give one. */
export function parseRemoteNode(stdout: string): RemoteNode | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const parsed = remoteNodeSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** Whether `version` is at least {@link MIN_NODE}. */
export function nodeIsRecentEnough(version: string, minimum: string = MIN_NODE): boolean {
  const have = parts(version)
  const need = parts(minimum)
  for (let index = 0; index < need.length; index++) {
    const a = have[index] ?? 0
    const b = need[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

export function installDir(node: RemoteNode, id: string): string {
  return `${node.home.replace(/\/+$/, '')}/${WORKER_HOME}/${id}`
}

/** Succeeds when this build is already unpacked there. */
export function installedArgv(dir: string): string[] {
  return ['test', '-f', `${dir}/${SSH_WORKER_BUNDLE}`]
}

/**
 * Unpack the archive (`ssh-worker-package.ts`) read as base64 from stdin into
 * `dir`, after checking its hash: a damaged or altered upload is refused, and
 * nothing is left half written, because it lands beside `dir` and is renamed
 * into place whole. Entry paths may not leave `dir`.
 */
const UNPACK_JS = `
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const [dir, hash] = process.argv.slice(1)
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  const archive = Buffer.from(Buffer.concat(chunks).toString('latin1'), 'base64')
  if (crypto.createHash('sha256').update(archive).digest('hex') !== hash) {
    console.error('the upload arrived damaged')
    process.exit(3)
  }
  const part = dir + '.part-' + process.pid
  fs.rmSync(part, { recursive: true, force: true })
  fs.mkdirSync(part, { recursive: true, mode: 0o700 })
  let at = 0
  while (at < archive.length) {
    const end = archive.indexOf(10, at)
    const entry = JSON.parse(archive.subarray(at, end).toString('utf8'))
    at = end + 1
    const relative = path.normalize(entry.path)
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      console.error('the upload names a path outside its directory')
      process.exit(4)
    }
    const file = path.join(part, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, archive.subarray(at, at + entry.size), { mode: entry.mode & 0o755 })
    at += entry.size
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(part, dir)
})
`

export function unpackArgv(node: RemoteNode, dir: string, hash: string): string[] {
  return [node.execPath, '-e', UNPACK_JS, dir, hash]
}

/**
 * Start the worker detached, so it outlives this command and the connection,
 * and print the socket it serves once a client can connect. A worker already
 * serving that profile is reused: the new one only reports its socket.
 * Prints the end of the worker's log and fails when it exits first or is not
 * up in 30 s.
 */
const START_SH = `
node="$1"; dir="$2"; version="$3"
ready="$dir/ready"
rm -f "$ready"
cd "$dir" || exit 1
if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=; fi
$detach nohup "$node" ${SSH_WORKER_BUNDLE} --user-data "$dir/profile" --app-version "$version" --ready-file "$ready" >"$dir/worker.log" 2>&1 </dev/null &
pid=$!
tries=0
while [ ! -s "$ready" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 150 ] || ! kill -0 "$pid" 2>/dev/null; then
    [ -s "$ready" ] && break
    tail -n 20 "$dir/worker.log" >&2
    exit 1
  fi
  sleep 0.2
done
cat "$ready"
`

export function startArgv(node: RemoteNode, dir: string, version: string): string[] {
  return ['sh', '-c', START_SH, 'sh', node.execPath, dir, version]
}
