import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { ShellReplayLeaseStore, type ShellReplayLeaseIdentity } from './capability-lease.ts'
import { scriptReplayScope } from './script-replay-scope.ts'

/** Binary identity fixtures are never executed. */
function writeInterpreter(path: string, version = 'first'): void {
  copyFileSync('/bin/sh', path)
  chmodSync(path, 0o755)
  appendFileSync(path, version)
}

async function withProject(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'script-replay-'))
  mkdirSync(join(root, 'scripts'))
  for (const file of ['audit.mjs', 'other.mjs', 'audit.py', 'audit.sh']) {
    writeFileSync(join(root, 'scripts', file), '')
  }
  try {
    await run(root)
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

async function issueScript(
  store: ShellReplayLeaseStore,
  owner: ShellReplayLeaseIdentity,
  command: string,
): Promise<ReturnType<ShellReplayLeaseStore['issue']>> {
  return store.issue(owner, command, await scriptReplayScope(command, owner.executionRoot))
}

describe('script argument replay leases', { skip: process.platform === 'win32' }, () => {
  it('admits the running native Node executable', async () => {
    await withProject(async (root) => {
      assert.notEqual(
        await scriptReplayScope(
          `${JSON.stringify(process.execPath)} scripts/audit.mjs first`,
          root,
        ),
        null,
      )
    })
  })

  it('permits changing literal arguments including quoted browser code after a fixed cd', async () => {
    await withProject(async (root) => {
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      await issueScript(
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
        assert.equal((await store.consume(owner, command, () => true)).matched, true, command)
      }
    })
  })

  it('fails closed on shell evaluation, environment, interpreter options and changed structure', async () => {
    await withProject(async (root) => {
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      await issueScript(store, owner, 'node scripts/audit.mjs first')
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
        assert.equal((await store.consume(owner, command, () => true)).matched, false, command)
      }
      assert.equal(
        (await store.consume(owner, 'node scripts/audit.mjs second', () => false)).matched,
        true,
      )
    })
  })

  it('keeps interpreter options and unsupported invocations on exact-command matching', async () => {
    await withProject(async (root) => {
      for (const command of [
        'node --no-warnings scripts/audit.mjs first',
        'node -e "console.log(1)"',
        'node missing.mjs first',
        'node scripts/audit.mjs > output',
        'pnpm test -- first',
      ]) {
        assert.equal(await scriptReplayScope(command, root), null, command)
      }
      writeInterpreter(join(root, 'python3'))
      writeInterpreter(join(root, 'bash'))
      for (const command of ['./python3 scripts/audit.py first', './bash scripts/audit.sh first']) {
        assert.notEqual(await scriptReplayScope(command, root), null, command)
      }
    })
  })

  it('binds argument changes to the owner, expiry and ten-run budget', async () => {
    await withProject(async (root) => {
      let now = 0
      const store = new ShellReplayLeaseStore({ now: (): number => now })
      const owner = identity(root)
      const lease = await issueScript(store, owner, 'node scripts/audit.mjs first')
      for (const changed of [
        { ...owner, threadId: 'other' },
        { ...owner, projectId: 'other' },
        { ...owner, turnTreeId: asTurnTreeId('other') },
        { ...owner, executionRoot: join(root, 'scripts') },
        { ...owner, containment: 'project-sandbox' as const },
      ]) {
        assert.equal(
          (await store.consume(changed, 'node scripts/audit.mjs second', () => true)).matched,
          false,
        )
      }
      for (let index = 0; index < 10; index++) {
        assert.equal(
          (await store.consume(owner, 'node scripts/audit.mjs ' + String(index), () => false))
            .matched,
          true,
        )
      }
      assert.equal(
        (await store.consume(owner, 'node scripts/audit.mjs final', () => true)).matched,
        false,
      )
      await issueScript(store, owner, 'node scripts/audit.mjs first')
      now = lease.expiresAt
      assert.equal(
        (await store.consume(owner, 'node scripts/audit.mjs expired', () => true)).matched,
        false,
      )
      store.issue({ ...owner, containment: 'project-sandbox' }, 'node scripts/audit.mjs first')
      assert.equal(
        (
          await store.consume(
            { ...owner, containment: 'project-sandbox' },
            'node scripts/audit.mjs second',
            () => true,
          )
        ).matched,
        false,
      )
    })
  })

  it('requires fresh approval after script writes and same-path replacement', async () => {
    await withProject(async (root) => {
      const script = join(root, 'scripts', 'audit.mjs')
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      await issueScript(store, owner, 'node scripts/audit.mjs first')
      writeFileSync(script, '// changed after approval\n')
      assert.equal(
        (await store.consume(owner, 'node scripts/audit.mjs second', () => true)).matched,
        false,
      )
      assert.equal(
        (await store.consume(owner, 'node scripts/audit.mjs first', () => true)).matched,
        false,
      )
      await issueScript(store, owner, 'node scripts/audit.mjs first')
      const replacement = join(root, 'scripts', 'replacement.mjs')
      writeFileSync(replacement, '// changed after approval\n')
      renameSync(replacement, script)
      assert.equal(
        (await store.consume(owner, 'node scripts/audit.mjs third', () => true)).matched,
        false,
      )
    })
  })

  it('binds an explicit interpreter to its target and bytes', async () => {
    await withProject(async (root) => {
      for (const name of ['first', 'second']) {
        writeInterpreter(join(root, name))
      }
      const interpreter = join(root, 'node')
      symlinkSync('first', interpreter)
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      await issueScript(store, owner, './node scripts/audit.mjs first')
      assert.equal(
        (await store.consume(owner, './node scripts/audit.mjs second', () => true)).matched,
        true,
      )
      unlinkSync(interpreter)
      symlinkSync('second', interpreter)
      assert.equal(
        (await store.consume(owner, './node scripts/audit.mjs third', () => true)).matched,
        false,
      )
      await issueScript(store, owner, './node scripts/audit.mjs first')
      writeInterpreter(join(root, 'second'), 'changed')
      assert.equal(
        (await store.consume(owner, './node scripts/audit.mjs fourth', () => true)).matched,
        false,
      )
    })
  })

  it('rechecks bare-interpreter PATH resolution and executability', async () => {
    await withProject(async (root) => {
      const oldPath = process.env['PATH']
      const first = join(root, 'first')
      const second = join(root, 'second')
      for (const directory of [first, second]) {
        mkdirSync(directory)
        writeInterpreter(join(directory, 'node'))
      }
      try {
        process.env['PATH'] = first
        const store = new ShellReplayLeaseStore()
        const owner = identity(root)
        await issueScript(store, owner, 'node scripts/audit.mjs first')
        process.env['PATH'] = second
        assert.equal(
          (await store.consume(owner, 'node scripts/audit.mjs second', () => true)).matched,
          false,
        )
        process.env['PATH'] = first
        chmodSync(join(first, 'node'), 0o644)
        assert.equal(
          (await store.consume(owner, 'node scripts/audit.mjs third', () => true)).matched,
          false,
        )
      } finally {
        if (oldPath === undefined) delete process.env['PATH']
        else process.env['PATH'] = oldPath
      }
    })
  })

  it('does not offer argument grants for missing or non-regular interpreters and scripts', async () => {
    await withProject(async (root) => {
      assert.equal(await scriptReplayScope('./missing/node scripts/audit.mjs first', root), null)
      mkdirSync(join(root, 'node'))
      mkdirSync(join(root, 'scripts', 'directory.mjs'))
      assert.equal(await scriptReplayScope('./node scripts/audit.mjs first', root), null)
      assert.equal(await scriptReplayScope('node scripts/directory.mjs first', root), null)
    })
  })

  it('keeps a text shim on exact-command grants when its dispatch configuration changes', async () => {
    await withProject(async (root) => {
      for (const version of ['first', 'second']) writeInterpreter(join(root, version), version)
      writeFileSync(join(root, 'selected-interpreter'), join(root, 'first'))
      writeFileSync(join(root, 'node'), '#!/bin/sh\nexec "$(cat selected-interpreter)" "$@"\n', {
        mode: 0o755,
      })
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      const command = './node scripts/audit.mjs first'
      const initial = await scriptReplayScope(command, root)
      store.issue(owner, command, initial)
      // Only dispatch configuration changes: the shim's path and bytes stay fixed.
      writeFileSync(join(root, 'selected-interpreter'), join(root, 'second'))
      assert.equal(
        (await store.consume(owner, './node scripts/audit.mjs second', () => true)).matched,
        false,
      )
      assert.equal(initial, null)
      assert.equal(await scriptReplayScope(command, root), null)
      assert.equal((await store.consume(owner, command, () => false)).matched, true)
    })
  })

  it('rejects shell text prefixed with native executable magic', async () => {
    await withProject(async (root) => {
      const header =
        process.platform === 'darwin'
          ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
          : Buffer.from([0x7f, 0x45, 0x4c, 0x46])
      writeFileSync(
        join(root, 'node'),
        Buffer.concat([header, Buffer.from('\nexec "$(cat selected-interpreter)" "$@"\n')]),
        { mode: 0o755 },
      )
      assert.equal(await scriptReplayScope('./node scripts/audit.mjs first', root), null)
    })
  })

  it('keeps CDPATH-dependent cd prefixes on exact-command grants', async () => {
    await withProject(async (root) => {
      const original = process.env['CDPATH']
      process.env['CDPATH'] = join(root, 'outside')
      try {
        assert.equal(await scriptReplayScope('cd scripts && node audit.mjs first', root), null)
        assert.notEqual(await scriptReplayScope('cd ./scripts && node audit.mjs first', root), null)
      } finally {
        if (original === undefined) delete process.env['CDPATH']
        else process.env['CDPATH'] = original
      }
    })
  })

  it('rejects a script moved outside the root during interpreter fingerprinting', async (t) => {
    await withProject(async (root) => {
      const outside = mkdtempSync(join(tmpdir(), 'script-replay-outside-'))
      const link = join(root, 'scripts', 'link.mjs')
      writeFileSync(join(outside, 'outside.mjs'), '// must not become the approved local script\n')
      writeInterpreter(join(root, 'node'))
      symlinkSync('audit.mjs', link)
      const originalHash = crypto.createHash
      let retargeted = false
      const hash = t.mock.method(
        crypto,
        'createHash',
        (...args: Parameters<typeof originalHash>) => {
          if (!retargeted) {
            retargeted = true
            unlinkSync(link)
            symlinkSync(join(outside, 'outside.mjs'), link)
          }
          return originalHash(...args)
        },
      )
      syncBuiltinESMExports()
      try {
        assert.equal(await scriptReplayScope('./node scripts/link.mjs first', root), null)
        assert.equal(retargeted, true)
      } finally {
        hash.mock.restore()
        syncBuiltinESMExports()
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  it('honours revocation, expiry and concurrent replay limits while fingerprinting', async () => {
    await withProject(async (root) => {
      writeInterpreter(join(root, 'node'))
      let now = 0
      const store = new ShellReplayLeaseStore({ now: (): number => now })
      const owner = identity(root)
      const command = './node scripts/audit.mjs first'
      const replay = './node scripts/audit.mjs second'
      const revoked = await issueScript(store, owner, command)
      const pendingRevoked = store.consume(owner, replay, () => true)
      store.revoke(revoked.id)
      assert.equal((await pendingRevoked).matched, false)

      const expired = await issueScript(store, owner, command)
      const pendingExpired = store.consume(owner, replay, () => true)
      now = expired.expiresAt
      assert.equal((await pendingExpired).matched, false)

      await issueScript(store, owner, command)
      const matches = await Promise.all(
        Array.from({ length: 13 }, () => store.consume(owner, replay, () => true)),
      )
      assert.equal(matches.filter((match) => match.matched).length, 10)
    })
  })

  it('rejects symlink retargeting and outside-project scripts', async () => {
    await withProject(async (root) => {
      const link = join(root, 'scripts', 'link.mjs')
      symlinkSync('audit.mjs', link)
      const store = new ShellReplayLeaseStore()
      const owner = identity(root)
      await issueScript(store, owner, 'node scripts/link.mjs first')
      unlinkSync(link)
      symlinkSync('other.mjs', link)
      assert.equal(
        (await store.consume(owner, 'node scripts/link.mjs second', () => true)).matched,
        false,
      )
      writeFileSync(join(root, 'outside.mjs'), '')
      assert.equal(
        await scriptReplayScope('node ../outside.mjs first', join(root, 'scripts')),
        null,
      )
    })
  })
})
