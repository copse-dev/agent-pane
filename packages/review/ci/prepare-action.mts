// Trusted Actions setup. No model/App credentials are present in this step.
// Contributor lockfiles are data; contributor manifests/scripts are never run here.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { decodeActionRequest, npmTarballs } from './action-policy.mts'

const request = decodeActionRequest(process.env['COPSE_REVIEW_REQUEST'] ?? '')
const reviewerRoot = resolve(process.env['COPSE_REVIEWER_ROOT'] ?? '.')
const runnerTemp = process.env['RUNNER_TEMP']
const githubEnv = process.env['GITHUB_ENV']
if (!runnerTemp || !githubEnv) throw new Error('Copse review requires GitHub Actions')
if (process.env['GITHUB_SERVER_URL'] !== 'https://github.com') {
  throw new Error('Copse Actions currently supports public github.com repositories only')
}
const root = join(runnerTemp, 'copse-review-action')
const repo = join(root, 'repository')
const cache = join(root, 'npm-cache')
const seed = join(root, 'seed')
await mkdir(seed, { recursive: true })
await mkdir(join(cache, '_cacache'), { recursive: true })

const git = (args: readonly string[]): string =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: seed,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
git([
  'clone',
  '--quiet',
  '--filter=blob:none',
  '--no-checkout',
  `https://github.com/${request.repository}.git`,
  repo,
])
git([
  '-C',
  repo,
  'fetch',
  '--no-tags',
  'origin',
  `+refs/pull/${String(request.pr)}/head:refs/remotes/copse/head`,
  request.base,
])
if (git(['-C', repo, 'rev-parse', 'refs/remotes/copse/head']) !== request.head) {
  throw new Error('The pull request changed before Copse could prepare it')
}
const mergeBase = git(['-C', repo, 'merge-base', request.base, request.head])
const urls = new Set<string>()
for (const ref of new Set([mergeBase, request.head])) {
  for (const url of npmTarballs(git(['-C', repo, 'show', `${ref}:package-lock.json`])))
    urls.add(url)
}
// The working directory contains only this caller-owned empty config; npm never
// sees .npmrc, package.json, workspace declarations or scripts from the PR.
const npmrc = join(seed, 'empty.npmrc')
const globalNpmrc = join(seed, 'global.npmrc')
await writeFile(npmrc, '')
await writeFile(globalNpmrc, '')
for (const url of urls) {
  execFileSync(
    'npm',
    [
      'cache',
      'add',
      url,
      '--cache',
      cache,
      '--ignore-scripts',
      '--userconfig',
      npmrc,
      '--globalconfig',
      globalNpmrc,
    ],
    {
      cwd: seed,
      stdio: 'inherit',
    },
  )
}
const image = `copse-review-cell:${process.env['GITHUB_RUN_ID'] ?? 'local'}`
const proxyCa = process.env['CODEX_PROXY_CERT']
execFileSync(
  'docker',
  [
    'build',
    ...(proxyCa ? ['--secret', `id=proxy_ca,src=${proxyCa}`] : []),
    '--file',
    join(reviewerRoot, 'packages/review/Dockerfile.cell'),
    '--tag',
    image,
    seed,
  ],
  {
    cwd: seed,
    stdio: 'inherit',
  },
)
await appendFile(
  githubEnv,
  `COPSE_REVIEW_TARGET=${repo}\nCOPSE_REVIEW_STORE=${cache}\nCOPSE_REVIEW_CELL_IMAGE=${image}\n`,
)
