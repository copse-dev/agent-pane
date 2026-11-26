import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PortRow } from './ports-registry.ts'
import { threadServerPorts } from './thread-loopback-ports.ts'

function row(port: number, owner: PortRow['owner']): PortRow {
  return { port, pid: 100 + port, address: '127.0.0.1', command: 'node', owner, url: null }
}

describe('threadServerPorts', () => {
  it("keeps only ports bound under the thread's own sandboxed background tasks", () => {
    const rows = [
      row(3000, { kind: 'background', id: 'dev', label: 'node src/server.js' }),
      row(3000, { kind: 'background', id: 'dev', label: 'node src/server.js' }),
      row(5173, { kind: 'background', id: 'vite', label: 'vite' }),
      // Another thread's task, a Shells tab, and a listener Copse did not start.
      row(4000, { kind: 'background', id: 'elsewhere', label: 'x' }),
      row(5432, { kind: 'terminal', id: 'tab-1', label: 'zsh' }),
      row(11434, null),
    ]
    assert.deepEqual(threadServerPorts(rows, new Set(['vite', 'dev'])), [3000, 5173])
    assert.deepEqual(threadServerPorts(rows, new Set()), [])
  })
})
