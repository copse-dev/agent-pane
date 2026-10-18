import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listAcpSessionProcesses, registerAcpSessionProcess } from './acp-process-registry.ts'
import { copseChildRoots, ownedProcessRows, parseProcessTable } from '../process-manager-owned.ts'

test('attributes sandbox hosts and their agent descendants without counting them as shared', () => {
  let pid: number | undefined = 20
  const unregister = registerAcpSessionProcess({
    threadId: 'thread-a',
    projectId: 'project-a',
    command: '/opt/bin/claude',
    processId: () => pid,
  })
  try {
    const roots = listAcpSessionProcesses().map((session) => ({
      ...session,
      type: 'Subprocess' as const,
    }))
    const samples = parseProcessTable(
      [
        '20 1 0.0 1024 /Applications/Copse',
        '21 20 0.0 2048 /usr/bin/sandbox-exec',
        '22 21 1.0 819200 /usr/bin/node',
        '23 22 0.0 4096 /usr/bin/git',
      ].join('\n'),
    )
    assert.deepEqual(
      copseChildRoots(samples, 1, new Set([1]), new Set(roots.map((root) => root.pid))),
      [],
    )
    const rows = ownedProcessRows(roots, samples)
    assert.equal(rows.length, 4)
    assert.equal(rows[0]?.label, 'claude')
    assert.ok(rows.every((row) => row.threadId === 'thread-a' && row.projectId === 'project-a'))
    assert.equal(
      rows.reduce((sum, row) => sum + (row.memoryMiB ?? 0), 0),
      807,
    )
    pid = undefined
    assert.deepEqual(listAcpSessionProcesses(), [], 'exited children cannot claim a reused PID')
  } finally {
    unregister()
  }
  assert.deepEqual(listAcpSessionProcesses(), [])
})

test('old registration cleanup cannot remove its replacement and ignores invalid roots', () => {
  const old = registerAcpSessionProcess({ threadId: 'a', command: 'agent', processId: () => 40 })
  const replacement = registerAcpSessionProcess({
    threadId: 'a',
    command: 'agent',
    processId: () => 41,
  })
  const invalid = registerAcpSessionProcess({ threadId: 'b', command: 'agent', processId: () => 0 })
  try {
    old()
    old()
    assert.deepEqual(listAcpSessionProcesses(), [{ pid: 41, label: 'agent', threadId: 'a' }])
  } finally {
    old()
    replacement()
    invalid()
  }
})
