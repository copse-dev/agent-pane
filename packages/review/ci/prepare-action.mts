// Trusted Actions setup. No model/App credentials are present in this step.
// Contributor lockfiles are data; contributor manifests/scripts are never run here.
import { execFileSync } from 'node:child_process'
import { mkdir, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cellImageBuildArgs, cellPlatform, primeDependencyCache } from '../src/cell-preparation.ts'
import { decodeActionRequest } from './action-policy.mts'

const request = decodeActionRequest(process.env['COPSE_REVIEW_REQUEST'] ?? '')
const reviewerRoot = resolve(process.env['COPSE_REVIEWER_ROOT'] ?? '.')
const runnerTemp = process.env['RUNNER_TEMP']
const githubEnv = process.env['GITHUB_ENV']
const githubOutput = process.env['GITHUB_OUTPUT']
if (!runnerTemp || !githubEnv || !githubOutput)
  throw new Error('Copse review requires GitHub Actions')
if (process.env['GITHUB_SERVER_URL'] !== 'https://github.com') {
  throw new Error('Copse Actions currently supports public github.com repositories only')
}
const root = join(runnerTemp, 'copse-review-action')
const repo = join(root, 'repository')
const profile = process.env['COPSE_REVIEW_PREPARATION'] ?? 'npm'
if (profile !== 'npm' && profile !== 'copse-pnpm') throw new Error('Unknown preparation profile')
if (profile === 'copse-pnpm' && request.repository !== 'copse-dev/agent-pane') {
  throw new Error('The Copse pnpm preparation policy is restricted to its own repository')
}
const cache = join(root, profile === 'npm' ? 'npm-cache' : 'pnpm-store')
const seed = join(root, 'seed')
await mkdir(seed, { recursive: true })
await mkdir(join(cache, '_cacache'), { recursive: true })

const git = (args: readonly string[], trim = true): string => {
  const output = execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: seed,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  return trim ? output.trim() : output
}
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
  console.log(
    '::notice::The pull request changed before Copse could prepare it; skipping superseded review',
  )
  await appendFile(githubOutput, 'ready=false\n')
  process.exit(0)
}
const mergeBase = git(['-C', repo, 'merge-base', request.base, request.head])
const revisions = new Set([mergeBase, request.head])
await primeDependencyCache({
  profile,
  revisions: [...revisions],
  show: (revision, path) => git(['-C', repo, 'show', `${revision}:${path}`], false),
  seed,
  cache,
  // The cell runs on this runner's CPU; on GitHub's Linux runners the host
  // and the cell are the same platform, so this fetches what it always did.
  platform: cellPlatform(),
  run: (file, args, options) => {
    execFileSync(file, [...args], {
      cwd: options.cwd,
      stdio: 'inherit',
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    })
  },
})
const image = `copse-review-cell:${process.env['GITHUB_RUN_ID'] ?? 'local'}`
const proxyCa = process.env['CODEX_PROXY_CERT']
execFileSync(
  'docker',
  cellImageBuildArgs({
    dialect: 'docker',
    dockerfile: join(reviewerRoot, 'packages/review/Dockerfile.cell'),
    tag: image,
    context: seed,
    ...(proxyCa ? { proxyCaFile: proxyCa } : {}),
  }),
  {
    cwd: seed,
    stdio: 'inherit',
  },
)
await appendFile(
  githubEnv,
  `COPSE_REVIEW_TARGET=${repo}\nCOPSE_REVIEW_STORE=${cache}\nCOPSE_REVIEW_CELL_IMAGE=${image}\n` +
    `COPSE_REVIEW_PREPARE=${join(reviewerRoot, profile === 'npm' ? 'packages/review/ci/prepare-npm-checkout.mts' : 'scripts/prepare-review-stage0.mts')}\n`,
)
await appendFile(githubOutput, 'ready=true\n')
