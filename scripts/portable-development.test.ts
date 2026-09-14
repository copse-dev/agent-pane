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

function fixture(rootName = 'environment with spaces'): {
  parent: string
  root: string
  run: (
    directory: string,
    args: string[],
    environment?: NodeJS.ProcessEnv,
  ) => SpawnSyncReturns<string>
} {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'copse portable ')))
  const root = join(parent, rootName)
  const scripts = join(root, 'projects/agent-panel/scripts/portable')
  const bin = join(parent, 'system')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'uname'),
    '#!/bin/bash\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n',
  )
  chmodSync(join(bin, 'uname'), 0o755)
  for (const file of [
    'environment.sh',
    'versions.sh',
    'offline.sh',
    'clean-environment.sh',
    'dispatch.sh',
  ]) {
    copyFileSync(resolve('scripts/portable', file), join(scripts, file))
  }
  copyFileSync(resolve('scripts/portable/run.sh'), join(root, 'portable-dev'))
  writeFileSync(join(root, '.copse-checkout'), 'projects/agent-panel\n')
  const run = (
    directory: string,
    args: string[],
    environment: NodeJS.ProcessEnv = {},
  ): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [join(directory, 'portable-dev'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...environment, PATH: `${bin}:/usr/bin:/bin` },
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

test('named coding launchers use drive executables and relocated Claude state and temporary paths', () => {
  const f = fixture()
  try {
    const bin = join(f.root, 'apps/darwin-arm64/bin')
    mkdirSync(bin, { recursive: true })
    for (const tool of ['claude', 'codex']) {
      const executable = join(bin, tool)
      writeFileSync(
        executable,
        '#!/bin/bash\nprintf "%s\\n" "$0" "$CLAUDE_CONFIG_DIR" "$CLAUDE_CODE_TMPDIR" "$@"\n',
      )
      chmodSync(executable, 0o755)
    }
    const moved = join(f.parent, 'moved coding environment')
    renameSync(f.root, moved)
    for (const tool of ['claude', 'codex']) {
      const result = f.run(moved, [tool, 'argument with spaces'])
      assert.equal(result.status, 0, result.stderr)
      assert.equal(
        result.stdout,
        `${moved}/apps/darwin-arm64/bin/${tool}\n${moved}/data/claude\n${moved}/tmp\nargument with spaces\n`,
      )
    }
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('portable entry drops inherited work authentication and routing without exposing values', () => {
  const f = fixture('work/environment with spaces')
  try {
    const workEnvironment = {
      ANTHROPIC_API_KEY: 'work-secret',
      ANTHROPIC_AUTH_TOKEN: 'work-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'work-secret',
      ANTHROPIC_BASE_URL: 'https://work.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      OPENAI_API_KEY: 'work-secret',
      OPENAI_BASE_URL: 'https://work.invalid',
      AWS_PROFILE: 'work',
      AWS_ACCESS_KEY_ID: 'work-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/work-profile-sentinel/credentials.json',
      AZURE_OPENAI_API_KEY: 'work-secret',
      HTTPS_PROXY: 'https://work.invalid',
      NODE_OPTIONS: '--require=/work-profile-sentinel/preload.js',
      UNKNOWN_FUTURE_PROVIDER_TOKEN: 'work-secret',
      CLAUDE_CONFIG_DIR: '/work-profile-sentinel/claude',
      CODEX_HOME: '/work-profile-sentinel/codex',
      COPSE_DIR: '/work-profile-sentinel/copse',
      TERM: 'xterm-256color',
      LANG: 'en_GB.UTF-8',
    }
    const result = f.run(f.root, ['exec', '/usr/bin/env'], workEnvironment)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /work-secret|work\.invalid|\/work-profile-sentinel\//,
    )
    assert.doesNotMatch(
      result.stdout,
      /ANTHROPIC_|OPENAI_|AWS_|GOOGLE_|AZURE_|HTTPS_PROXY=|NODE_OPTIONS=|UNKNOWN_FUTURE_PROVIDER_TOKEN=|CODEX_HOME=/,
    )
    assert.match(result.stdout, /TERM=xterm-256color/)
    assert.match(result.stdout, /LANG=en_GB.UTF-8/)
    assert.ok(result.stdout.includes(`CLAUDE_CONFIG_DIR=${f.root}/data/claude\n`))
    assert.ok(result.stdout.includes(`COPSE_DIR=${f.root}/data/copse\n`))
    const originalHome = process.env['HOME']
    if (originalHome !== undefined) assert.ok(result.stdout.includes(`HOME=${originalHome}\n`))
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('portable execution permits deliberate environment configuration after the clean boundary', () => {
  const f = fixture()
  try {
    const result = f.run(
      f.root,
      [
        'exec',
        '/usr/bin/env',
        'ANTHROPIC_BASE_URL=http://127.0.0.1:1234',
        '/bin/bash',
        '-c',
        'printf "%s\\n" "$ANTHROPIC_BASE_URL"',
      ],
      { ANTHROPIC_BASE_URL: 'https://work.invalid' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'http://127.0.0.1:1234\n')
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test('offline settings reach package managers without changing normal execution', () => {
  const f = fixture()
  try {
    const command =
      'printf "%s\\n" "${npm_config_offline:-unset}" "${COREPACK_ENABLE_NETWORK:-unset}" "$COPSE_ELECTRON_HEADERS_CACHE"'
    const normal = f.run(f.root, ['exec', '/bin/bash', '-c', command])
    assert.equal(normal.status, 0, normal.stderr)
    const offline = f.run(f.root, ['exec', '/bin/bash', '-c', command], {
      COPSE_PORTABLE_OFFLINE: '1',
    })
    assert.equal(offline.status, 0, offline.stderr)
    assert.equal(offline.stdout, `true\n0\n${f.root}/cache/electron-headers\n`)
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

test('scratch directories do not inherit the enclosing checkout Git identity', () => {
  const f = fixture()
  try {
    assert.equal(spawnSync('git', ['init', f.parent]).status, 0)
    const scratch = join(f.root, 'tmp/scratch')
    mkdirSync(scratch, { recursive: true })
    assert.notEqual(
      f.run(f.root, ['exec', 'git', '-C', scratch, 'rev-parse', '--show-toplevel']).status,
      0,
    )
    assert.equal(f.run(f.root, ['exec', 'git', 'init', scratch]).status, 0)
    const initialized = f.run(f.root, [
      'exec',
      'git',
      '-C',
      scratch,
      'rev-parse',
      '--show-toplevel',
    ])
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(initialized.stdout.trim(), scratch)
  } finally {
    rmSync(f.parent, { recursive: true, force: true })
  }
})

test(
  'standalone engines preserve profiles, validate relocation, and clean up only owned children',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const result = spawnSync('python3', ['scripts/portable/local-engines.test.py'], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  },
)
