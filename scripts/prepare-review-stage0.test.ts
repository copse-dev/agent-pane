import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const script = resolve('scripts/prepare-review-stage0.mts')

it(
  "gives a review cell a placeholder at the path Electron's loader returns, and nothing that launches",
  { skip: process.platform !== 'linux' && 'review cells are Linux' },
  async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'review-stage0-prep-'))
    try {
      // pnpm itself is the cell's; here it only has to succeed.
      const bin = join(checkout, '.bin')
      await mkdir(bin)
      await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n')
      await chmod(join(bin, 'pnpm'), 0o755)
      const electron = join(checkout, 'node_modules', 'electron')
      await mkdir(electron, { recursive: true })
      await writeFile(join(electron, 'package.json'), '{"name":"electron"}\n')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
      }
      delete env['npm_config_store_dir']
      delete env['NODE_TEST_CONTEXT']
      const result = spawnSync(process.execPath, [script], { cwd: checkout, env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /placeholder Electron executable/)
      assert.equal(await readFile(join(electron, 'path.txt'), 'utf8'), 'electron')
      const placeholder = join(electron, 'dist', 'electron')
      await access(placeholder)
      const launched = spawnSync(placeholder, [], { encoding: 'utf8' })
      assert.equal(launched.status, 1)
      assert.match(launched.stderr, /Electron is not installed in this review cell/)
      // A checkout that already has Electron's binary keeps it.
      await writeFile(join(electron, 'path.txt'), 'real-electron')
      assert.equal(spawnSync(process.execPath, [script], { cwd: checkout, env }).status, 0)
      assert.equal(await readFile(join(electron, 'path.txt'), 'utf8'), 'real-electron')
    } finally {
      await rm(checkout, { recursive: true, force: true })
    }
  },
)
