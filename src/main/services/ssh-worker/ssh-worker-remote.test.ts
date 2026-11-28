import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { packArchive, packageFromArchive } from './ssh-worker-package.ts'
import {
  installDir,
  nodeIsRecentEnough,
  parseRemoteNode,
  profileDir,
  pruneArgv,
  startArgv,
  unpackArgv,
  type RemoteNode,
} from './ssh-worker-remote.ts'

const scratch = mkdtempSync(join(tmpdir(), 'copse-ssh-worker-remote-'))
after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const node: RemoteNode = {
  version: process.versions.node,
  execPath: process.execPath,
  home: scratch,
}

/** Run an argv as the host would, here. */
function run(argv: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const [command = '', ...args] = argv
  const result = spawnSync(command, args, { input, encoding: 'utf8' })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

describe('the host side of the SSH worker', () => {
  it("reads the host's Node from the probe, and nothing else", () => {
    assert.deepEqual(
      parseRemoteNode('motd line\n{"version":"22.13.1","execPath":"/usr/bin/node","home":"/h"}\n'),
      { version: '22.13.1', execPath: '/usr/bin/node', home: '/h' },
    )
    assert.equal(parseRemoteNode('node: command not found'), null)
    assert.equal(parseRemoteNode('{"version":""}'), null)
  })

  it('wants Node 22.13 or later', () => {
    assert.equal(nodeIsRecentEnough('22.13.0'), true)
    assert.equal(nodeIsRecentEnough('v24.1.0'), true)
    assert.equal(nodeIsRecentEnough('22.12.9'), false)
    assert.equal(nodeIsRecentEnough('20.19.0'), false)
  })

  it('installs each build in its own directory under the home', () => {
    assert.equal(installDir({ ...node, home: '/home/me/' }, 'abc'), '/home/me/.copse/worker/abc')
  })

  it('unpacks a whole archive, and refuses a damaged or escaping one', () => {
    const worker = packageFromArchive(
      packArchive([
        { path: 'ssh-worker.cjs', mode: 0o644, data: Buffer.from('worker') },
        { path: 'node_modules/pkg/bin', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
      ]),
    )
    const dir = join(scratch, 'install')
    const ok = run(unpackArgv(node, dir, worker.hash), worker.archive.toString('base64'))
    assert.equal(ok.code, 0, ok.stderr)
    assert.equal(readFileSync(join(dir, 'ssh-worker.cjs'), 'utf8'), 'worker')
    assert.equal(statSync(join(dir, 'node_modules/pkg/bin')).mode & 0o777, 0o755)

    const damaged = run(
      unpackArgv(node, join(scratch, 'damaged'), '0'.repeat(64)),
      worker.archive.toString('base64'),
    )
    assert.equal(damaged.code, 3)

    const escaping = packageFromArchive(
      packArchive([{ path: '../outside', mode: 0o644, data: Buffer.from('x') }]),
    )
    const refused = run(
      unpackArgv(node, join(scratch, 'escaping'), escaping.hash),
      escaping.archive.toString('base64'),
    )
    assert.equal(refused.code, 4)
  })

  it('prints the socket a started worker serves, and the log of one that died', () => {
    const dir = join(scratch, 'start')
    mkdirSync(dir)
    // Writes its ready file as the turn host does, then leaves.
    writeFileSync(
      join(dir, 'ssh-worker.cjs'),
      'const a = process.argv; const fs = require("fs"); fs.writeFileSync(a[a.indexOf("--ready-file") + 1], "/run/w.sock\\n"); fs.mkdirSync(a[a.indexOf("--user-data") + 1]); fs.writeFileSync(a[a.indexOf("--user-data") + 1] + "/seen", process.env.COPSE_DIR)',
    )
    const started = run(startArgv(node, dir, '1.2.3'))
    assert.equal(started.code, 0, started.stderr)
    assert.equal(started.stdout.trim(), '/run/w.sock')
    // Every build serves the one profile the host keeps, made private.
    assert.equal(
      readFileSync(join(profileDir(node), 'user-data', 'seen'), 'utf8'),
      profileDir(node),
    )
    assert.equal(statSync(profileDir(node)).mode & 0o777, 0o700)

    writeFileSync(join(dir, 'ssh-worker.cjs'), 'console.error("cannot start"); process.exit(1)')
    const died = run(startArgv(node, dir, '1.2.3'))
    assert.equal(died.code, 1)
    assert.match(died.stderr, /cannot start/)
  })

  it('removes the builds no worker runs from, and keeps the profile', async () => {
    const home = join(scratch, 'prune')
    const workers = join(home, '.copse', 'worker')
    const keep = 'a'.repeat(16)
    const old = 'b'.repeat(16)
    const busy = 'c'.repeat(16)
    for (const name of [keep, old, busy, 'profile', `${'d'.repeat(16)}.part-999999999`])
      mkdirSync(join(workers, name), { recursive: true })
    // A worker of the busy build, as `ps` shows one: its bundle by full path.
    const running = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
      join(workers, busy, 'ssh-worker.cjs'),
    ])
    try {
      await new Promise((resolve) => running.once('spawn', resolve))
      const pruned = run(pruneArgv({ ...node, home }, keep))
      assert.equal(pruned.code, 0, pruned.stderr)
      assert.deepEqual(readdirSync(workers).sort(), [keep, busy, 'profile'].sort())
    } finally {
      running.kill()
    }
  })
})
