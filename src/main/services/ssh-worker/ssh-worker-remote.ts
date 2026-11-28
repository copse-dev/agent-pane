import { z } from 'zod'
import { SSH_WORKER_BUNDLE } from './ssh-worker-package.ts'

/**
 * The commands that install and start the worker on an SSH host
 * (`docs/plans/harness-worker-roadmap.md`, R3), as argv for
 * `SshConnection.execArgv`, so nothing the app passes is parsed by the
 * host's shell.
 *
 * The host needs only Node, at least {@link MIN_NODE}: the worker brings
 * everything else with it. Each build lives in `~/.copse/worker/<id>/`, and
 * every build shares one profile, `~/.copse/worker/profile/`, so a thread's
 * history outlives an update; builds no worker runs from are removed.
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

function workerHome(node: RemoteNode): string {
  return `${node.home.replace(/\/+$/, '')}/${WORKER_HOME}`
}

export function installDir(node: RemoteNode, id: string): string {
  return `${workerHome(node)}/${id}`
}

/**
 * The profile every build shares, as the worker's `COPSE_DIR`: its threads,
 * settings, worktrees and socket.
 */
export function profileDir(node: RemoteNode): string {
  return `${workerHome(node)}/profile`
}

/** Succeeds when this build is already unpacked there. */
export function installedArgv(dir: string): string[] {
  return ['test', '-f', `${dir}/${SSH_WORKER_BUNDLE}`]
}

/**
 * Unpack the archive (`ssh-worker-package.ts`) read as base64 from stdin into
 * `dir`, after checking its hash: a damaged upload is refused, and
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
  let code = 0
  try {
    fs.mkdirSync(part, { recursive: true, mode: 0o700 })
    let at = 0
    while (at < archive.length) {
      const end = archive.indexOf(10, at)
      const entry = JSON.parse(archive.subarray(at, end).toString('utf8'))
      at = end + 1
      const relative = path.normalize(String(entry.path))
      if (relative === '.' || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
        console.error('the upload names a path outside its directory')
        code = 4
        break
      }
      const file = path.join(part, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, archive.subarray(at, at + entry.size), { mode: entry.mode & 0o755 })
      at += entry.size
    }
    if (code === 0) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.renameSync(part, dir)
    }
  } catch (error) {
    console.error(String(error))
    code = 5
  } finally {
    fs.rmSync(part, { recursive: true, force: true })
  }
  process.exit(code)
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
node="$1"; dir="$2"; version="$3"; profile="$4"
# One ready file per start, so two starts at once cannot read or remove each
# other's.
ready="$dir/ready-$$"
rm -f "$ready"
cd "$dir" || exit 1
mkdir -p "$profile" && chmod 700 "$profile" || exit 1
# The worker outlives this connection: it must not hold a forwarded agent.
unset SSH_AUTH_SOCK
if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=; fi
# The bundle by its full path, so \`ps\` shows which build a worker runs.
# The profile is the worker's whole Copse directory: threads, worktrees and
# caches land there, apart from any Copse the host's user runs themselves.
COPSE_DIR="$profile" $detach nohup "$node" "$dir/${SSH_WORKER_BUNDLE}" --user-data "$profile/user-data" --app-version "$version" --ready-file "$ready" --relay-inference >"$dir/worker.log" 2>&1 </dev/null &
pid=$!
tries=0
while [ ! -s "$ready" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 150 ] || ! kill -0 "$pid" 2>/dev/null; then
    [ -s "$ready" ] && break
    tail -n 20 "$dir/worker.log" >&2
    # A worker that is only slow may still write it.
    (sleep 60; rm -f "$ready") >/dev/null 2>&1 </dev/null &
    exit 1
  fi
  sleep 0.2
done
cat "$ready"
rm -f "$ready"
`

export function startArgv(node: RemoteNode, dir: string, version: string): string[] {
  return ['sh', '-c', START_SH, 'sh', node.execPath, dir, version, profileDir(node)]
}

/**
 * Remove every build but `keep` that no running process was started from and
 * that was not uploaded in the last ten minutes, and the half-written uploads
 * of uploads that are no longer running. Prints
 * what it removed, one per line.
 */
const PRUNE_JS = `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const [home, keep] = process.argv.slice(1)
let running = ''
try {
  running = execFileSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
} catch {
  process.exit(0)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
for (const name of fs.readdirSync(home)) {
  const dir = path.join(home, name)
  const part = /^([0-9a-f]{16})\\.part-(\\d+)$/.exec(name)
  const build = /^[0-9a-f]{16}$/.test(name) && name !== keep
  if (part ? alive(Number(part[2])) : !build) continue
  if (!part && running.includes(dir + '/')) continue
  // Another app may have just uploaded it and not started it yet.
  if (!part && Date.now() - fs.statSync(dir).mtimeMs < 10 * 60 * 1000) continue
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(name)
}
`

export function pruneArgv(node: RemoteNode, keep: string): string[] {
  return [node.execPath, '-e', PRUNE_JS, workerHome(node), keep]
}
