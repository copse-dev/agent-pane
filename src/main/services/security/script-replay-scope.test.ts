import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { ShellReplayLeaseStore, type ShellReplayLeaseIdentity } from './capability-lease.ts'
import { scriptReplayScope } from './script-replay-scope.ts'

function withProject(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'script-replay-'))
  mkdirSync(join(root, 'scripts'))
  for (const file of ['audit.mjs', 'other.mjs', 'audit.py', 'audit.sh']) {
    writeFileSync(join(root, 'scripts', file), '')
  }
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function identity(root: string): ShellReplayLeaseIdentity {
  return {
    projectId: 'project',
    threadId: 'thread',
    turnTreeId: asTurnTreeId('tree'),
    executionRoot: root,
    containment: 'external',
  }
}

function issueScript(
  store: ShellReplayLeaseStore,
  owner: ShellReplayLeaseIdentity,
  command: string,
): ReturnType<ShellReplayLeaseStore['issue']> {
  return store.issue(owner, command, scriptReplayScope(command, owner.executionRoot))
}

describe('script argument replay leases', () => {
  it('permits changing literal arguments including quoted browser code after a fixed cd', () => {
    withProject((root) => {
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      issueScript(
        store,
        owner,
        'cd scripts && node audit.mjs \'document.querySelectorAll("dialog")\'',
      )
      for (const command of [
        'cd scripts && node audit.mjs \'Array.from(document.querySelectorAll("iframe"))\'',
        'cd scripts && node audit.mjs \'console.log("$HOME; $(ignored)")\' --headed',
        'cd scripts && node ./audit.mjs --mode inspect',
        'cd scripts && node audit.mjs',
      ]) {
        assert.equal(store.consume(owner, command, () => true).matched, true, command)
      }
    })
  })

  it('fails closed on shell evaluation, environment, interpreter options and changed structure', () => {
    withProject((root) => {
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      issueScript(store, owner, 'node scripts/audit.mjs first')
      for (const command of [
        'python3 scripts/audit.mjs second',
        '/usr/bin/node scripts/audit.mjs second',
        'node scripts/other.mjs second',
        'node --require scripts/other.mjs scripts/audit.mjs second',
        'NODE_OPTIONS=--inspect node scripts/audit.mjs second',
        'env node scripts/audit.mjs second',
        'node scripts/audit.mjs second && echo appended',
        'echo before && node scripts/audit.mjs second',
        'node scripts/audit.mjs second | cat',
        'node scripts/audit.mjs second > output',
        'node scripts/audit.mjs < input',
        'node scripts/audit.mjs "$(touch escaped)"',
        'node scripts/audit.mjs "\u0060touch escaped\u0060"',
        'node scripts/audit.mjs $HOME',
        'node scripts/audit.mjs ~',
        'node scripts/audit.mjs {one,two}',
        'node scripts/audit.mjs *',
        'node scripts/audit.mjs (echo escaped)',
        'node scripts/audit.mjs # comment',
        "node scripts/audit.mjs 'unterminated",
      ]) {
        assert.equal(store.consume(owner, command, () => true).matched, false, command)
      }
      assert.equal(store.consume(owner, 'node scripts/audit.mjs second', () => false).matched, true)
    })
  })

  it('keeps interpreter options and unsupported invocations on exact-command matching', () => {
    withProject((root) => {
      for (const command of [
        'node --no-warnings scripts/audit.mjs first',
        'node -e "console.log(1)"',
        'node missing.mjs first',
        'node scripts/audit.mjs > output',
        'pnpm test -- first',
      ]) {
        assert.equal(scriptReplayScope(command, root), null, command)
      }
      for (const command of ['python3 scripts/audit.py first', 'bash scripts/audit.sh first']) {
        assert.notEqual(scriptReplayScope(command, root), null, command)
      }
    })
  })

  it('binds argument changes to the owner, expiry and ten-run budget', () => {
    withProject((root) => {
      let now = 0
      const store = new ShellReplayLeaseStore({ now: (): number => now })
      const owner = identity(root)
      const lease = issueScript(store, owner, 'node scripts/audit.mjs first')
      for (const changed of [
        { ...owner, threadId: 'other' },
        { ...owner, projectId: 'other' },
        { ...owner, turnTreeId: asTurnTreeId('other') },
        { ...owner, executionRoot: join(root, 'scripts') },
        { ...owner, containment: 'project-sandbox' as const },
      ]) {
        assert.equal(
          store.consume(changed, 'node scripts/audit.mjs second', () => true).matched,
          false,
        )
      }
      for (let index = 0; index < 10; index++) {
        assert.equal(
          store.consume(owner, 'node scripts/audit.mjs ' + String(index), () => false).matched,
          true,
        )
      }
      assert.equal(store.consume(owner, 'node scripts/audit.mjs final', () => true).matched, false)
      issueScript(store, owner, 'node scripts/audit.mjs first')
      now = lease.expiresAt
      assert.equal(
        store.consume(owner, 'node scripts/audit.mjs expired', () => true).matched,
        false,
      )
      store.issue({ ...owner, containment: 'project-sandbox' }, 'node scripts/audit.mjs first')
      assert.equal(
        store.consume(
          { ...owner, containment: 'project-sandbox' },
          'node scripts/audit.mjs second',
          () => true,
        ).matched,
        false,
      )
    })
  })

  it('rejects symlink retargeting and outside-project scripts', () => {
    withProject((root) => {
      const link = join(root, 'scripts', 'link.mjs')
      symlinkSync('audit.mjs', link)
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      issueScript(store, owner, 'node scripts/link.mjs first')
      unlinkSync(link)
      symlinkSync('other.mjs', link)
      assert.equal(store.consume(owner, 'node scripts/link.mjs second', () => true).matched, false)
      writeFileSync(join(root, 'outside.mjs'), '')
      assert.equal(scriptReplayScope('node ../outside.mjs first', join(root, 'scripts')), null)
    })
  })
})
