import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_PNPM_PREPARE,
  DEFAULT_PREPARE_TIMEOUT_MS,
  REVIEW_CONFIG_FILENAME,
  detectProjectCommands,
} from './project-commands.ts'

/** The unsupported reason, or a marker that makes a wrongly supported project fail the match. */
function reasonOf(detected: Awaited<ReturnType<typeof detectProjectCommands>>): string {
  return detected.ecosystem === 'unsupported' ? detected.reason : `supported: ${detected.ecosystem}`
}

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-commands-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
  }
  return root
}

describe('detectProjectCommands', () => {
  const roots: string[] = []
  before(() => {
    roots.length = 0
  })
  after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  it('detects a TypeScript pnpm project from its scripts, in run order', async () => {
    const root = await project({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        scripts: { test: 'vitest', build: 'tsc -b', typecheck: 'tsc --noEmit', dev: 'x' },
        devDependencies: { typescript: '^5' },
      }),
    })
    roots.push(root)
    const detected = detectProjectCommands(root)
    if (detected.ecosystem === 'unsupported') throw new Error(detected.reason)
    assert.equal(detected.ecosystem, 'typescript-pnpm')
    assert.equal(detected.source, 'package.json')
    assert.deepEqual(
      detected.commands.map((command) => [command.kind, [...command.argv], command.timeoutMs]),
      [
        ['prepare', [...DEFAULT_PNPM_PREPARE], DEFAULT_PREPARE_TIMEOUT_MS],
        ['build', ['pnpm', 'run', 'build'], DEFAULT_CHECK_TIMEOUT_MS],
        ['typecheck', ['pnpm', 'run', 'typecheck'], DEFAULT_CHECK_TIMEOUT_MS],
        ['test', ['pnpm', 'run', 'test'], DEFAULT_CHECK_TIMEOUT_MS],
      ],
    )
  })

  it('accepts a lockfile plus tsconfig as the pnpm and TypeScript signals', async () => {
    const root = await project({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'tsconfig.json': '{}',
    })
    roots.push(root)
    const detected = detectProjectCommands(root)
    assert.equal(detected.ecosystem, 'typescript-pnpm')
  })

  it('names the B5 reason when the project is not pnpm or not TypeScript', async () => {
    const npm = await project({
      'package.json': JSON.stringify({
        scripts: { test: 'jest' },
        devDependencies: { typescript: '5' },
      }),
    })
    const js = await project({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'pnpm-lock.yaml': '',
    })
    const empty = await project({})
    roots.push(npm, js, empty)
    assert.match(reasonOf(detectProjectCommands(npm)), /pnpm.*B5/)
    assert.match(reasonOf(detectProjectCommands(js)), /tsconfig/)
    assert.match(reasonOf(detectProjectCommands(empty)), /package\.json/)
  })

  it('lets review.config.json override, disable and time-limit commands', async () => {
    const root = await project({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        scripts: { test: 'vitest', lint: 'eslint' },
        devDependencies: { typescript: '5' },
      }),
      [REVIEW_CONFIG_FILENAME]: JSON.stringify({
        commands: { prepare: null, lint: null, test: ['node', '--test'] },
        timeoutsMs: { test: 1234 },
      }),
    })
    roots.push(root)
    const detected = detectProjectCommands(root)
    if (detected.ecosystem === 'unsupported') throw new Error(detected.reason)
    assert.equal(detected.ecosystem, 'configured')
    assert.equal(detected.source, REVIEW_CONFIG_FILENAME)
    assert.deepEqual(
      detected.commands.map((command) => [command.kind, [...command.argv], command.timeoutMs]),
      [['test', ['node', '--test'], 1234]],
    )
  })

  it('needs no ecosystem at all when the config declares the commands', async () => {
    const root = await project({
      [REVIEW_CONFIG_FILENAME]: JSON.stringify({ commands: { build: ['make'] } }),
    })
    roots.push(root)
    const detected = detectProjectCommands(root)
    assert.equal(detected.ecosystem, 'configured')
  })

  it('rejects an invalid config rather than guessing', async () => {
    const root = await project({
      [REVIEW_CONFIG_FILENAME]: JSON.stringify({ commands: { test: 'vitest run' } }),
    })
    roots.push(root)
    assert.match(reasonOf(detectProjectCommands(root)), /review\.config\.json/)
  })
})
