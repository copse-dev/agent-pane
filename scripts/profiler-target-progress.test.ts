import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { it } from 'node:test'
import {
  requestTargetProgress,
  TARGET_PROGRESS_SOURCE,
} from './test-support/profiler-target-progress.ts'

async function withTarget(
  source: string,
  run: (child: ChildProcess) => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) })
    await run(child)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
}

const READY = `process.send({ type: 'ready' }); setInterval(() => {}, 1000);`
const ACK = `({ type:'profiler-target-progress-ack', nonce:request.nonce,
  stage:request.stage, pid:process.pid, node:process.version, v8:process.versions.v8,
  arch:process.arch, coverage:Boolean(process.env.NODE_V8_COVERAGE) })`

it('runs the actual target protocol and requires a new nonce for each main-loop checkpoint', async () => {
  await withTarget(TARGET_PROGRESS_SOURCE, async (child) => {
    const first = await requestTargetProgress(child, 'after-initial-close')
    const second = await requestTargetProgress(child, 'after-cleanup')
    assert.equal(first.pid, child.pid)
    assert.equal(second.pid, child.pid)
    assert.equal(first.stage, 'after-initial-close')
    assert.equal(second.stage, 'after-cleanup')
    assert.notEqual(first.nonce, second.nonce)
    assert.equal(first.node, process.version)
    assert.equal(first.v8, process.versions.v8)
    assert.equal(first.coverage, Boolean(process.env['NODE_V8_COVERAGE']))
    assert.equal(child.listenerCount('message'), 0)
  })
})

it('ignores a stale nonce but accepts the following exact acknowledgement', async () => {
  await withTarget(
    `${READY}
process.on('message', request => {
  process.send({ ...${ACK}, nonce:'stale' }); process.send(${ACK});
});`,
    async (child) => {
      assert.equal((await requestTargetProgress(child, 'fresh')).stage, 'fresh')
    },
  )
})

it('fails when no fresh acknowledgement arrives', async () => {
  await withTarget(
    `${READY}
process.on('message', request => process.send({ ...${ACK}, nonce:'stale' }));`,
    async (child) => {
      await assert.rejects(requestTargetProgress(child, 'missing', 100), /timed out during missing/)
      assert.equal(child.listenerCount('message'), 0)
    },
  )
})

it('rejects matching-nonce replies for another PID or stage', async () => {
  for (const change of ['pid: process.pid + 1', "stage: 'different'"]) {
    await withTarget(
      `${READY}
process.on('message', request => process.send({ ...${ACK}, ${change} }));`,
      async (child) => {
        await assert.rejects(requestTargetProgress(child, 'identity'), /identity mismatch/)
      },
    )
  }
})

it('rejects malformed acknowledgements instead of accepting partial progress', async () => {
  await withTarget(
    `${READY}
process.on('message', request => process.send({ type:'profiler-target-progress-ack', nonce:request.nonce }));`,
    async (child) => {
      await assert.rejects(requestTargetProgress(child, 'malformed'), /Malformed target progress/)
    },
  )
})

it('fails on target exit and refuses progress from an already-exited target', async () => {
  await withTarget(
    `${READY}
process.on('message', () => process.exit(7));`,
    async (child) => {
      await assert.rejects(
        requestTargetProgress(child, 'death'),
        /Target (exited|IPC disconnected)/,
      )
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      assert.equal(child.exitCode, 7)
      await assert.rejects(requestTargetProgress(child, 'already-dead'), /Target unavailable/)
    },
  )
})
