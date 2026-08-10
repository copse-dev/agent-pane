import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPortRows, createPortScanCoalescer, portUrl } from './ports-registry.ts'
import type { OwnedProcess } from './port-owners.ts'
import type { ListeningPort } from './port-scan.ts'

function port(partial: Partial<ListeningPort> & { port: number }): ListeningPort {
  return { pid: null, command: '', address: '127.0.0.1', ...partial }
}

const shell: OwnedProcess = {
  pid: 100,
  owner: { kind: 'terminal', id: 'session-1', label: 'Terminal 1' },
}
const task: OwnedProcess = {
  pid: 200,
  owner: { kind: 'background', id: 'task-1', label: 'npm run dev' },
}

describe('portUrl', () => {
  it('offers a localhost URL for loopback and bind-all addresses', () => {
    for (const address of ['127.0.0.1', '::1', '0.0.0.0', '::', '*', 'localhost', '']) {
      assert.equal(
        portUrl(port({ port: 3000, address })),
        'http://localhost:3000',
        `expected a URL for ${address || '(empty)'}`,
      )
    }
  })

  it('offers no URL for a specific non-loopback interface', () => {
    // The built-in browser auto-allows loopback only, and this address may not
    // even be on this machine — a link we'd have to prompt for is worse than none.
    assert.equal(portUrl(port({ port: 3000, address: '192.168.1.20' })), null)
  })
})

describe('buildPortRows', () => {
  it('attributes a port to the shell it was started from, through intermediate pids', () => {
    // bash(100) -> npm(101) -> node(102), which is what actually binds the port.
    const parentMap = new Map([
      [102, 101],
      [101, 100],
    ])
    const rows = buildPortRows([port({ port: 3000, pid: 102, command: 'node' })], parentMap, [
      shell,
    ])
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0]?.owner, shell.owner)
  })

  it('leaves a port Copse did not start unowned', () => {
    const rows = buildPortRows([port({ port: 5432, pid: 900, command: 'postgres' })], new Map(), [
      shell,
    ])
    assert.equal(rows[0]?.owner, null)
  })

  it('leaves a port with no readable pid unowned rather than guessing', () => {
    const rows = buildPortRows([port({ port: 80, pid: null, command: '' })], new Map(), [shell])
    assert.equal(rows[0]?.owner, null)
  })

  it('sorts owned rows first, then by ascending port', () => {
    const rows = buildPortRows(
      [
        port({ port: 5432, pid: 900 }),
        port({ port: 8080, pid: 200 }),
        port({ port: 80, pid: 901 }),
        port({ port: 3000, pid: 100 }),
      ],
      new Map(),
      [shell, task],
    )
    assert.deepEqual(
      rows.map((row) => row.port),
      [3000, 8080, 80, 5432],
    )
  })

  it('does not climb past the ancestry it was given', () => {
    // A cyclic parent map (bogus `ps` output) must terminate rather than spin.
    const parentMap = new Map([
      [1, 2],
      [2, 1],
    ])
    const rows = buildPortRows([port({ port: 3000, pid: 1 })], parentMap, [shell])
    assert.equal(rows[0]?.owner, null)
  })
})

describe('createPortScanCoalescer', () => {
  it('shares an in-flight host scan and starts a new one after it settles', async () => {
    let calls = 0
    let finish: ((result: { rows: []; tool: string }) => void) | undefined
    const scan = createPortScanCoalescer(
      () =>
        new Promise((resolve) => {
          calls++
          finish = resolve
        }),
    )

    const first = scan()
    const concurrent = scan()
    assert.equal(concurrent, first)
    assert.equal(calls, 1)
    finish?.({ rows: [], tool: 'lsof' })
    await first

    const next = scan()
    assert.equal(calls, 2)
    finish?.({ rows: [], tool: 'lsof' })
    await next
  })
})
