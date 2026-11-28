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

/**
 * Write the archive's files (read as base64 from stdin, hash-checked) into
 * `dir`, each replaced whole and private, leaving the directory's other files
 * as they are.
 */
const WRITE_FILES_JS = `
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let at = 0
  while (at < archive.length) {
    const end = archive.indexOf(10, at)
    const entry = JSON.parse(archive.subarray(at, end).toString('utf8'))
    at = end + 1
    const name = String(entry.path)
    if (name !== path.basename(name) || name.startsWith('.')) {
      console.error('the upload names a path outside its directory')
      process.exit(4)
    }
    const file = path.join(dir, name)
    const part = file + '.part-' + process.pid
    fs.writeFileSync(part, archive.subarray(at, at + entry.size), { mode: 0o600 })
    fs.renameSync(part, file)
    at += entry.size
  }
})
`

export function writeFilesArgv(node: RemoteNode, dir: string, hash: string): string[] {
  return [node.execPath, '-e', WRITE_FILES_JS, dir, hash]
}

/** The worker's own profile stores (`config.json` and friends). */
export function userDataDir(node: RemoteNode): string {
  return `${profileDir(node)}/user-data`
}

/** Where the worker keeps a thread (`copseWorkspaceDir()/<project>/<thread>`). */
export function remoteThreadDir(node: RemoteNode, projectId: string, threadId: string): string {
  return `${profileDir(node)}/workspace/${projectId}/${threadId}`
}

/** Where a thread's new history is unpacked before it replaces the old. */
export function stagingDir(node: RemoteNode): string {
  return `${profileDir(node)}/staging`
}

/**
 * Whether a process on the host holds the thread's writer lease
 * (`writer-lease.ts`): the highest epoch, not released, its heartbeat in time
 * and its pid alive. A turn the worker runs, or started by itself, holds it.
 */
const LEASE_HELD_JS = `
const leaseHeld = async (dir) => {
  let names
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return false
  }
  const epochs = names.map((name) => /^writer\\.lease\\.(\\d+)$/.exec(name)).filter(Boolean).map((m) => Number(m[1]))
  if (epochs.length === 0) return false
  let lease
  try {
    lease = JSON.parse(await fs.promises.readFile(path.join(dir, 'writer.lease.' + Math.max(...epochs)), 'utf8'))
  } catch {
    // A lease being written is a lease being taken.
    return true
  }
  if (lease.releasedAt !== undefined || Date.now() - lease.heartbeatAt > lease.ttlMs) return false
  try {
    process.kill(lease.pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
`

/**
 * Print what the host has of a thread, as JSON: the size of its
 * `events.jsonl` (-1 for none), the SHA-256 of its first `prefix` bytes,
 * and whether a turn holds it there.
 */
const THREAD_STATE_JS = `
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const [dir, prefix] = process.argv.slice(1)
${LEASE_HELD_JS}
const main = async () => {
  const held = await leaseHeld(dir)
  let data
  try {
    data = await fs.promises.readFile(path.join(dir, 'events.jsonl'))
  } catch {
    return { size: -1, prefixHash: '', held }
  }
  const head = data.subarray(0, Math.min(Number(prefix), data.length))
  return { size: data.length, prefixHash: crypto.createHash('sha256').update(head).digest('hex'), held }
}
main().then((state) => console.log(JSON.stringify(state)))
`

export function threadStateArgv(node: RemoteNode, dir: string, prefix: number): string[] {
  return [node.execPath, '-e', THREAD_STATE_JS, dir, String(prefix)]
}

/**
 * Print a thread's history files (`isThreadHistoryPath`) as one archive in
 * base64, so the app can keep its copy of the thread (the user's choice: the
 * host's is the thread's own, the laptop keeps a mirror). Prints nothing for a
 * thread the host does not have.
 */
const PACK_THREAD_JS = `
const fs = require('fs'), path = require('path')
const [dir] = process.argv.slice(1)
const tops = new Set(['meta.json', 'events.jsonl', 'agent-history.json', 'messages', 'blobs', 'subagents', 'plans'])
const parts = []
const walk = async (rel) => {
  for (const name of (await fs.promises.readdir(path.join(dir, rel))).sort()) {
    const child = rel === '' ? name : rel + '/' + name
    if (rel === '' && !tops.has(name)) continue
    const info = await fs.promises.lstat(path.join(dir, child))
    if (info.isDirectory()) await walk(child)
    else if (info.isFile()) {
      const data = await fs.promises.readFile(path.join(dir, child))
      parts.push(Buffer.from(JSON.stringify({ path: child, mode: info.mode & 0o755, size: data.length }) + '\\n'), data)
    }
  }
}
if (fs.existsSync(path.join(dir, 'meta.json')))
  walk('').then(() => {
    const text = Buffer.concat(parts).toString('base64')
    // The length last, so a copy cut short on the way is never taken whole.
    process.stdout.write(text + '\\nend ' + text.length + '\\n')
  })
`

const HISTORY_TOPS = [
  'meta.json',
  'events.jsonl',
  'agent-history.json',
  'messages',
  'blobs',
  'subagents',
  'plans',
]

/**
 * Replace a thread's history there with the archive on stdin, leaving what is
 * not history (the writer's lease, the dispatch record) in place. The new
 * history is unpacked beside the thread first, so a damaged upload changes
 * nothing.
 */
const REPLACE_HISTORY_JS = `
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const [dir, hash, staging] = process.argv.slice(1)
const tops = ${JSON.stringify(HISTORY_TOPS)}
${LEASE_HELD_JS}
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', async () => {
  const archive = Buffer.from(Buffer.concat(chunks).toString('latin1'), 'base64')
  if (crypto.createHash('sha256').update(archive).digest('hex') !== hash) {
    console.error('the upload arrived damaged')
    process.exit(3)
  }
  if (await leaseHeld(dir)) {
    console.error('a turn runs the thread there')
    process.exit(5)
  }
  const part = path.join(staging, path.basename(dir) + '-' + process.pid)
  try {
    await fs.promises.mkdir(part, { recursive: true, mode: 0o700 })
    let at = 0
    while (at < archive.length) {
      const end = archive.indexOf(10, at)
      const entry = JSON.parse(archive.subarray(at, end).toString('utf8'))
      at = end + 1
      const relative = path.normalize(String(entry.path))
      const top = relative.split(path.sep)[0]
      if (path.isAbsolute(relative) || relative.split(path.sep).includes('..') || !tops.includes(top))
        throw new Error('the upload names a path outside the thread')
      const file = path.join(part, relative)
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.promises.writeFile(file, archive.subarray(at, at + entry.size), { mode: 0o600 })
      at += entry.size
    }
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    for (const top of tops) {
      await fs.promises.rm(path.join(dir, top), { recursive: true, force: true })
      await fs.promises.rename(path.join(part, top), path.join(dir, top)).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  } catch (error) {
    console.error(String(error && error.message))
    process.exitCode = 4
  } finally {
    await fs.promises.rm(part, { recursive: true, force: true })
  }
})
`

/** What `replaceHistoryArgv` exits with while a turn runs the thread there. */
export const THREAD_HELD_EXIT = 5

export function replaceHistoryArgv(node: RemoteNode, dir: string, hash: string): string[] {
  return [node.execPath, '-e', REPLACE_HISTORY_JS, dir, hash, stagingDir(node)]
}

export function packThreadArgv(node: RemoteNode, dir: string): string[] {
  return [node.execPath, '-e', PACK_THREAD_JS, dir]
}
