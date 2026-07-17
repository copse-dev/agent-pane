import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSnapshotCommit,
  dockerRunCommand,
  gitSshCommand,
  newRunId,
  parseOraclePlan,
  roundRobinSpecs,
  shardWdioArgs,
  splitSshHost,
} from './remote-e2e.mts'

describe('parseOraclePlan', () => {
  it('parses the mode/count/specs plan the oracle emits', () => {
    const plan = parseOraclePlan(
      'mode=subset\ncount=2\nspecs=tests/e2e/a.e2e.ts tests/e2e/b.e2e.ts\n',
    )
    assert.equal(plan.mode, 'subset')
    assert.deepEqual(plan.specs, ['tests/e2e/a.e2e.ts', 'tests/e2e/b.e2e.ts'])
  })

  it('parses full and skip plans with empty spec lists', () => {
    assert.deepEqual(parseOraclePlan('mode=full\ncount=0\nspecs=\n'), { mode: 'full', specs: [] })
    assert.deepEqual(parseOraclePlan('mode=skip\ncount=0\nspecs=\n'), { mode: 'skip', specs: [] })
  })

  it('rejects unknown modes and missing mode lines', () => {
    assert.throws(() => parseOraclePlan('mode=sideways\nspecs=\n'))
    assert.throws(() => parseOraclePlan('count=3\nspecs=a\n'))
  })
})

describe('roundRobinSpecs', () => {
  it('distributes specs round-robin like the CI shard split', () => {
    assert.deepEqual(roundRobinSpecs(['a', 'b', 'c', 'd', 'e'], 2), [
      ['a', 'c', 'e'],
      ['b', 'd'],
    ])
  })

  it('drops empty buckets when there are fewer specs than shards', () => {
    assert.deepEqual(roundRobinSpecs(['a'], 3), [['a']])
  })

  it('treats n < 1 as a single bucket', () => {
    assert.deepEqual(roundRobinSpecs(['a', 'b'], 0), [['a', 'b']])
  })
})

describe('shardWdioArgs', () => {
  it('turns a subset plan into per-shard --spec args', () => {
    assert.deepEqual(shardWdioArgs({ mode: 'subset', specs: ['a', 'b', 'c'] }, 2), [
      ['--spec', 'a', '--spec', 'c'],
      ['--spec', 'b'],
    ])
  })

  it('turns a full plan into wdio --shard args', () => {
    assert.deepEqual(shardWdioArgs({ mode: 'full', specs: [] }, 3), [
      ['--shard', '1/3'],
      ['--shard', '2/3'],
      ['--shard', '3/3'],
    ])
  })

  it('runs a full plan unsharded as one argless invocation', () => {
    assert.deepEqual(shardWdioArgs({ mode: 'full', specs: [] }, 1), [[]])
  })
})

describe('newRunId', () => {
  it('is time-prefixed and usable in refs, paths, and container names', () => {
    const id = newRunId(1_752_710_000_000)
    assert.match(id, /^r[a-z0-9]+$/)
    assert.ok(id.startsWith(`r${(1_752_710_000_000).toString(36)}`))
  })
})

describe('splitSshHost', () => {
  it('splits user@ip', () => {
    assert.deepEqual(splitSshHost('root@1.2.3.4'), ['root', '1.2.3.4'])
    assert.deepEqual(splitSshHost('ubuntu@ec2-1-2-3-4.compute.amazonaws.com'), [
      'ubuntu',
      'ec2-1-2-3-4.compute.amazonaws.com',
    ])
  })
})

describe('gitSshCommand', () => {
  it('quotes every ssh option so GIT_SSH_COMMAND survives sh parsing', () => {
    const cmd = gitSshCommand({ keyPath: '/tmp/my key.pem', remoteUser: 'root', sshHost: 'public' })
    assert.ok(cmd.startsWith("'ssh' '-i' '/tmp/my key.pem'"))
    assert.ok(cmd.includes("'BatchMode=yes'"))
    assert.ok(cmd.includes("'UserKnownHostsFile=/dev/null'"))
  })
})

describe('dockerRunCommand', () => {
  it('builds a one-shot, resource-capped container invocation', () => {
    const cmd = dockerRunCommand({
      detach: false,
      keepTree: false,
      sha: 'abc123',
      shardId: 'r1-s1',
      wdioArgs: ['--spec', 'tests/e2e/a.e2e.ts'],
    })
    assert.ok(cmd.startsWith("'sudo' 'docker' 'run' '--rm' '--init'"))
    assert.ok(cmd.includes("'--name' 'remote-e2e-r1-s1'"))
    assert.ok(cmd.includes("'--memory' '6g' '--shm-size' '2g'"))
    assert.ok(cmd.includes("'-v' '/srv/remote-e2e:/srv/remote-e2e'"))
    assert.ok(cmd.includes("'--entrypoint' 'bash'"))
    assert.ok(
      cmd.endsWith("'/srv/remote-e2e/exec-run.sh' 'r1-s1' 'abc123' '--spec' 'tests/e2e/a.e2e.ts'"),
    )
    assert.ok(!cmd.includes(" '-d' "))
  })

  it('adds -d for detached runs and KEEP_TREE for kept trees', () => {
    const cmd = dockerRunCommand({
      detach: true,
      keepTree: true,
      sha: 'abc123',
      shardId: 'r1',
      wdioArgs: [],
    })
    assert.ok(cmd.includes("'-d'"))
    assert.ok(cmd.includes("'-e' 'KEEP_TREE=1'"))
  })
})

describe('createSnapshotCommit', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'remote-e2e-snap-'))
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@copse.invalid'])
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'init'])
    return dir
  }

  it('returns HEAD itself for a clean tree', () => {
    const dir = initRepo()
    try {
      const head = git(dir, ['rev-parse', 'HEAD'])
      assert.deepEqual(createSnapshotCommit(dir), { dirty: false, sha: head })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('captures unstaged and untracked changes without touching HEAD or the index', () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      writeFileSync(join(dir, 'new.txt'), 'brand new\n')
      const headBefore = git(dir, ['rev-parse', 'HEAD'])
      const statusBefore = git(dir, ['status', '--porcelain'])

      const snapshot = createSnapshotCommit(dir)
      assert.equal(snapshot.dirty, true)
      assert.notEqual(snapshot.sha, headBefore)
      // Snapshot parent is HEAD; its tree carries both changes.
      assert.equal(git(dir, ['rev-parse', `${snapshot.sha}^`]), headBefore)
      assert.equal(git(dir, ['show', `${snapshot.sha}:a.txt`]), 'two')
      assert.equal(git(dir, ['show', `${snapshot.sha}:new.txt`]), 'brand new')
      // The working tree, HEAD, and real index are untouched.
      assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore)
      assert.equal(git(dir, ['status', '--porcelain']), statusBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects .gitignore in the snapshot', () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, '.gitignore'), 'secret.txt\n')
      writeFileSync(join(dir, 'secret.txt'), 'do not ship\n')
      const snapshot = createSnapshotCommit(dir)
      assert.equal(snapshot.dirty, true)
      assert.throws(() => git(dir, ['show', `${snapshot.sha}:secret.txt`]))
      assert.equal(git(dir, ['show', `${snapshot.sha}:.gitignore`]), 'secret.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
