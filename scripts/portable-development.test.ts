import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

function fixture(): {
  parent: string
  root: string
  run: (directory: string, args: string[]) => SpawnSyncReturns<string>
} {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'copse portable ')))
  const root = join(parent, 'environment with spaces')
  const scripts = join(root, 'projects/agent-panel/scripts/portable')
  const bin = join(parent, 'system')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'uname'),
    '#!/bin/bash\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n',
  )
  chmodSync(join(bin, 'uname'), 0o755)
  for (const file of ['environment.sh', 'versions.sh']) {
    copyFileSync(resolve('scripts/portable', file), join(scripts, file))
  }
  copyFileSync(resolve('scripts/portable/run.sh'), join(root, 'portable-dev'))
  writeFileSync(join(root, '.copse-checkout'), 'projects/agent-panel\n')
  const run = (directory: string, args: string[]): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [join(directory, 'portable-dev'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    })
  return { parent, root, run }
}

test('portable launcher preserves arguments and derives paths after relocating a root with spaces', () => {
  const f = fixture()
  try {
    const moved = join(f.parent, 'renamed volume environment')
    renameSync(f.root, moved)
    const result = f.run(moved, [
      'exec',
      '/bin/bash',
      '-c',
      'printf "%s\\n" "$COPSE_DIR" "$npm_config_store_dir" "$1"',
      'bash',
      'argument with spaces; $(false)',
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      result.stdout,
      `${moved}/data/copse\n${moved}/cache/pnpm\nargument with spaces; $(false)\n`,
    )
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('portable launcher refuses traversal and symlink escapes before sourcing checkout code', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, '.copse-checkout'), 'projects/../../outside\n')
    assert.match(f.run(f.root, ['exec', '/usr/bin/true']).stderr, /Invalid .copse-checkout/)
    symlinkSync(f.parent, join(f.root, 'projects/escape'))
    writeFileSync(join(f.root, '.copse-checkout'), 'projects/escape\n')
    assert.match(f.run(f.root, ['exec', '/usr/bin/true']).stderr, /outside this environment/)
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('portable run refuses an unprepared checkout without starting package installation', () => {
  const f = fixture()
  try {
    const result = f.run(f.root, ['run'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /setup is incomplete/)
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('portable prepare supplies a valid shell no-op for the Make nvm prefix', () => {
  const f = fixture()
  try {
    writeFileSync(
      join(f.root, 'projects/agent-panel/Makefile'),
      'SHELL := /bin/bash\nbuild:\n\t@$(USE_NVM); echo built\n',
    )
    const result = f.run(f.root, ['prepare'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /built/)
    assert.equal(
      readFileSync(join(f.root, '.copse-prepared-path'), 'utf8').trim(),
      join(f.root, 'projects/agent-panel'),
    )
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('a repository-local environment resolves its parent checkout after moving', () => {
  const f = fixture()
  try {
    const repo = join(f.parent, 'moved repository')
    renameSync(join(f.root, 'projects/agent-panel'), repo)
    const environment = join(repo, '.portable')
    renameSync(f.root, environment)
    writeFileSync(join(environment, '.copse-checkout'), '..\n')
    const result = f.run(environment, [
      'exec',
      '/bin/bash',
      '-c',
      'printf "%s\\n" "$PWD" "$COPSE_DIR"',
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${repo}\n${environment}/data/copse\n`)
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('failed preparation invalidates a previous successful launch marker', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, '.copse-prepared-path'), join(f.root, 'projects/agent-panel'))
    writeFileSync(join(f.root, 'projects/agent-panel/Makefile'), 'build:\n\t@exit 1\n')
    assert.notEqual(f.run(f.root, ['prepare']).status, 0)
    const launch = f.run(f.root, ['run'])
    assert.equal(launch.status, 1)
    assert.match(launch.stderr, /setup is incomplete/)
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})
