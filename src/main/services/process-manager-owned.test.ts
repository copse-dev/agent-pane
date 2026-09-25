import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ownedProcessRows,
  parseProcessTable,
  type OwnedProcessRoot,
} from './process-manager-owned.ts'

test('attributes a live command to its terminal thread and ignores unrelated processes', () => {
  const roots: OwnedProcessRoot[] = [
    {
      pid: 10,
      label: 'Terminal',
      type: 'Terminal',
      threadId: 'thread-a',
      projectId: 'project-a',
      managed: { kind: 'terminal', id: 'session-a' },
    },
  ]
  const samples = parseProcessTable(
    ' 10 1 0.1 10240 /bin/zsh\n 11 10 12.5 2048 /bin/sleep\n 99 1 1.0 1024 /bin/other\n',
  )
  assert.deepEqual(
    ownedProcessRows(roots, samples).map(
      ({ pid, label, threadId, projectId, managed, memoryMiB }) => ({
        pid,
        label,
        threadId,
        projectId,
        managed,
        memoryMiB,
      }),
    ),
    [
      {
        pid: 10,
        label: 'Terminal',
        threadId: 'thread-a',
        projectId: 'project-a',
        managed: { kind: 'terminal', id: 'session-a' },
        memoryMiB: 10,
      },
      {
        pid: 11,
        label: 'sleep',
        threadId: 'thread-a',
        projectId: 'project-a',
        managed: { kind: 'terminal', id: 'session-a' },
        memoryMiB: 2,
      },
    ],
  )
})

test('keeps tracked processes visible when OS metrics cannot be sampled', () => {
  const rows = ownedProcessRows(
    [
      {
        pid: 42,
        label: 'pnpm dev',
        type: 'Background task',
        threadId: 'thread-b',
        projectId: 'project-b',
        managed: { kind: 'background', id: 'task-b', projectId: 'project-b', threadId: 'thread-b' },
      },
    ],
    [],
  )
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    pid: 42,
    startedAt: 0,
    label: 'pnpm dev',
    type: 'Background task',
    threadId: 'thread-b',
    projectId: 'project-b',
    managed: { kind: 'background', id: 'task-b', projectId: 'project-b', threadId: 'thread-b' },
    cpuPercent: null,
    memoryMiB: null,
  })
})
