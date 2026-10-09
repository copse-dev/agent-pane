/** Hosted diagnostic only: raw subprocess output is never persisted or printed. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [workspace, base, ref, count] = process.argv.slice(2)
if (!workspace || !base || !ref || !count) throw new Error('Missing diagnostic arguments')
const directory = join(workspace, 'copse-diagnostics')
mkdirSync(directory, { recursive: true })
const mark = (name: string): void => {
  writeFileSync(join(directory, name), '')
}
mark('01-node-started')
const major = /^\d+/.exec(process.versions.node)?.[0]
if (major) mark(`runtime-node-${major}`)
mark(typeof fetch === 'function' ? 'runtime-fetch-present' : 'runtime-fetch-missing')
if (process.env['HTTPS_PROXY'] || process.env['https_proxy']) mark('runtime-https-proxy-present')
const parts = Number(count)
if (!Number.isInteger(parts) || parts < 0 || parts > 49) throw new Error('Invalid part count')
const inputs = [
  'archive.json',
  'copse-git.cjs',
  ...Array.from({ length: parts }, (_, index) => `source.part-${String(index)}`),
]
if (inputs.some((file) => !existsSync(join(workspace, 'inputs', file)))) {
  mark('failed-input-files')
} else {
  mark('02-files-present')
  const git = spawnSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000 })
  if (git.status !== 0) mark('failed-git-runtime')
  else {
    mark('03-git-available')
    mark('04-worker-started')
    const result = spawnSync(
      process.execPath,
      [join(workspace, 'inputs/copse-git.cjs'), 'archive', base, ref, count],
      {
        encoding: 'utf8',
        timeout: 270_000,
        maxBuffer: 64 * 1024,
      },
    )
    if (result.status === 0) mark('05-snapshot-verified')
    else {
      // Only fixed identifiers leave the sandbox. Never forward stderr, paths or URLs.
      const stages = [
        ['reading setup metadata', 'metadata'],
        ['downloading the GitHub archive', 'download'],
        ['extracting the GitHub archive', 'extraction'],
        ['initializing Git', 'git-init'],
        ['verifying the pinned archive tree', 'archive-tree'],
        ['applying local changes', 'overlay'],
        ['verifying the local snapshot tree', 'snapshot-tree'],
        ['verifying the snapshot commit', 'snapshot-commit'],
        ['checking out the verified snapshot', 'checkout'],
      ] as const
      const stage = stages.find(([message]) =>
        result.stderr.includes(`Repository setup failed while ${message}`),
      )
      mark(
        `failed-${stage?.[1] ?? (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT' ? 'worker-timeout' : 'worker-runtime-or-assembly')}`,
      )
      const http =
        /Repository setup failed while downloading the GitHub archive \(HTTP ([1-5][0-9]{2})\)\./.exec(
          result.stderr,
        )?.[1]
      if (http) mark(`http-${http}`)
      const curl =
        /Repository setup failed while downloading the GitHub archive \(curl ([0-9]+|unavailable)\)\./.exec(
          result.stderr,
        )?.[1]
      if (curl) mark(`curl-${curl}`)
    }
  }
}
