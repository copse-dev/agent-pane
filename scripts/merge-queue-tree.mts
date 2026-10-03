import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
const PUBLIC_ORIGIN = 'https://github.com/copse-dev/agent-pane.git'
const GIT = '/usr/bin/git'
const CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'http.lowSpeedLimit=1',
  '-c',
  'http.lowSpeedTime=30',
]

/** Reconstruct the candidate's merge tree without checking out or executing it. */
export async function computeMergeTree(
  baseSha: string,
  prHead: string,
  options: { cwd?: string } = {},
): Promise<string> {
  if (!SHA.test(baseSha) || !SHA.test(prHead)) {
    throw new Error('Merge tree requires immutable 40-character lowercase commit SHAs')
  }
  const deadline = Date.now() + 180_000
  const cwd = resolve(options.cwd ?? process.cwd())
  const scratch = await mkdtemp(join(tmpdir(), 'copse-queue-tree-'))
  // Do not inherit Git config injection, askpass, exec-path, index, worktree,
  // replacement objects or alternate-object variables from the invoking job.
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: 'https',
    // Preserve transport configuration only; none of these execute Git drivers.
    ...(process.env['HTTPS_PROXY'] ? { HTTPS_PROXY: process.env['HTTPS_PROXY'] } : {}),
    ...(process.env['HTTP_PROXY'] ? { HTTP_PROXY: process.env['HTTP_PROXY'] } : {}),
    ...(process.env['NO_PROXY'] ? { NO_PROXY: process.env['NO_PROXY'] } : {}),
    ...(process.env['SSL_CERT_FILE'] ? { SSL_CERT_FILE: process.env['SSL_CERT_FILE'] } : {}),
  }
  const git = async (directory: string, args: string[], lazyFetch = false): Promise<string> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Merge tree verification timed out')
    const { stdout } = await execute(GIT, [...CONFIG, ...args], {
      cwd: directory,
      env: { ...env, GIT_NO_LAZY_FETCH: lazyFetch ? '0' : '1' },
      encoding: 'utf8',
      timeout: Math.min(120_000, remaining),
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
    })
    return stdout.trim()
  }
  try {
    const origin = await git(cwd, ['remote', 'get-url', 'origin'])
    if (origin !== PUBLIC_ORIGIN)
      throw new Error('Queue merge verification requires the public trusted origin')
    const objectPath = await git(cwd, ['rev-parse', '--git-path', 'objects'])
    if (!objectPath || objectPath.includes('\n'))
      throw new Error('Invalid trusted object directory')
    await git(scratch, ['-c', 'init.templateDir=', 'init', '--bare', '--object-format=sha1'])
    await mkdir(join(scratch, 'objects', 'info'), { recursive: true })
    await writeFile(
      join(scratch, 'objects', 'info', 'alternates'),
      `${isAbsolute(objectPath) ? objectPath : resolve(cwd, objectPath)}\n`,
    )
    // This fresh bare config is the only config used by merge-tree. Candidate
    // .gitattributes can name drivers, but no custom driver can be configured.
    await git(scratch, ['remote', 'add', 'origin', PUBLIC_ORIGIN])
    await git(scratch, ['config', 'remote.origin.promisor', 'true'])
    await git(scratch, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
    await git(scratch, ['config', 'extensions.partialClone', 'origin'])
    const commitPresent = async (sha: string): Promise<boolean> => {
      let type: string
      try {
        type = await git(scratch, ['cat-file', '-t', sha])
      } catch {
        return false
      }
      if (type !== 'commit')
        throw new Error('Merge tree inputs must identify commits, not trees or blobs')
      return true
    }
    const basePresent = await commitPresent(baseSha)
    const headPresent = await commitPresent(prHead)
    let historyPresent = basePresent && headPresent
    if (historyPresent) {
      try {
        // No blob traversal: detect missing parents in shallow checkouts.
        await git(scratch, ['rev-list', '--count', baseSha, prHead])
      } catch {
        historyPresent = false
      }
    }
    if (!historyPresent) {
      // No depth cap: merge-base needs complete history. Filter out unrelated
      // historical blobs; Git lazily obtains only blobs needed by this merge.
      await git(scratch, [
        'fetch',
        '--no-tags',
        '--filter=blob:none',
        '--no-write-fetch-head',
        'origin',
        baseSha,
        prHead,
      ])
      await git(scratch, ['cat-file', '-e', `${baseSha}^{commit}`])
      await git(scratch, ['cat-file', '-e', `${prHead}^{commit}`])
      await git(scratch, ['rev-list', '--count', baseSha, prHead])
    }
    // Conflicts produce a nonzero exit, even if Git prints a provisional tree.
    const tree = await git(
      scratch,
      ['merge-tree', '--write-tree', '--no-messages', baseSha, prHead],
      true,
    )
    if (!SHA.test(tree)) throw new Error('Git did not return one unambiguous merge tree')
    return tree
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
