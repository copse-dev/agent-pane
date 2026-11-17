import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { acpChildStdoutStream, appendAcpStderrTail } from './acp-child-stream.ts'

function spawnNode(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

describe('acpChildStdoutStream', () => {
  it('closes with the output when the agent exits cleanly', async () => {
    const child = spawnNode('process.stdout.write("hello")')
    const stream = acpChildStdoutStream(
      child,
      'agent',
      () => '',
      () => {},
    )

    assert.equal(await readAll(stream), 'hello')
  })

  it('errors with the exit code and stderr tail when the agent fails', async () => {
    const child = spawnNode('process.exit(3)')
    const stream = acpChildStdoutStream(
      child,
      'agent',
      () => 'auth expired\n',
      () => {},
    )

    await assert.rejects(readAll(stream), {
      message: 'The coding agent "agent" exited with code 3. Its error output: auth expired',
    })
  })

  it('stops the agent when the read is cancelled', async () => {
    const child = spawnNode('setInterval(() => {}, 1000)')
    let stopped = 0
    const stream = acpChildStdoutStream(
      child,
      'agent',
      () => '',
      () => {
        stopped += 1
        child.kill()
      },
    )

    await stream.cancel()
    assert.equal(stopped, 1)
  })
})

describe('appendAcpStderrTail', () => {
  it('keeps only the newest 8000 characters', () => {
    const tail = appendAcpStderrTail('a'.repeat(7_999), 'bc')

    assert.equal(tail.length, 8_000)
    assert.ok(tail.endsWith('abc'))
  })
})
