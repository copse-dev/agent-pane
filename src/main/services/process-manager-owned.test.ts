import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  copseChildRoots,
  ownedProcessRows,
  parseProcessArgs,
  parseProcessTable,
  selfHelperLabel,
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

test('shows a pid-file daemon only while that pid is still the expected executable', () => {
  const gortex: OwnedProcessRoot = {
    pid: 50,
    label: 'gortex daemon',
    type: 'Indexer',
    threadId: null,
    command: 'gortex',
  }
  const live = ownedProcessRows(
    [gortex],
    parseProcessTable(' 50 1 3.5 524288 /app/resources/gortex/gortex\n'),
  )
  assert.deepEqual(
    live.map(({ pid, label, type, threadId, memoryMiB }) => ({
      pid,
      label,
      type,
      threadId,
      memoryMiB,
    })),
    [{ pid: 50, label: 'gortex daemon', type: 'Indexer', threadId: null, memoryMiB: 512 }],
  )
  assert.deepEqual(
    ownedProcessRows([gortex], parseProcessTable(' 50 1 0.0 1024 /usr/bin/reused\n')),
    [],
    'a reused pid is not reported as the daemon',
  )
  assert.deepEqual(ownedProcessRows([gortex], []), [], 'a stale pid file is not shown')
})

test("lists Copse's own non-Electron children once, with their descendants", () => {
  const samples = parseProcessTable(
    [
      ' 100 1 1.0 4096 /Applications/Copse.app/Contents/MacOS/Copse',
      ' 101 100 2.0 4096 Copse Helper (Renderer)',
      ' 102 100 0.5 8192 /usr/local/bin/node',
      ' 103 102 0.1 2048 /usr/local/bin/mcp-server',
      ' 104 100 0.0 1024 /bin/zsh',
      ' 105 1 0.0 1024 /usr/local/bin/node',
    ].join('\n'),
  )
  const terminal: OwnedProcessRoot = {
    pid: 104,
    label: 'Terminal',
    type: 'Terminal',
    threadId: 'thread-a',
  }
  const helpers = copseChildRoots(samples, 100, new Set([100, 101]), new Set([104]))
  assert.deepEqual(helpers, [{ pid: 102, label: 'node', type: 'Subprocess', threadId: null }])
  assert.deepEqual(
    ownedProcessRows([terminal, ...helpers], samples).map(({ pid, label, type, threadId }) => ({
      pid,
      label,
      type,
      threadId,
    })),
    [
      { pid: 102, label: 'node', type: 'Subprocess', threadId: null },
      { pid: 103, label: 'mcp-server', type: 'Command', threadId: null },
      { pid: 104, label: 'Terminal', type: 'Terminal', threadId: 'thread-a' },
    ],
  )
})

test('names Copse-as-Node helpers after their worker script', () => {
  const args = parseProcessArgs(
    [
      ' 7 /Applications/My Apps/Copse.app/Contents/MacOS/Copse /Applications/My Apps/Copse.app/Contents/Resources/app.asar/dist/main/acp-session-host-worker.js',
      ' 8 /opt/copse/copse /opt/copse/resources/dist/main/custom-worker.mjs --flag',
      ' 9 /opt/copse/copse -e process.exit()',
    ].join('\n'),
  )
  assert.equal(selfHelperLabel(args.get(7) ?? ''), 'Agent session host')
  assert.equal(selfHelperLabel(args.get(8) ?? ''), 'custom-worker')
  assert.equal(selfHelperLabel(args.get(9) ?? ''), 'Copse helper')
  assert.equal(selfHelperLabel(''), 'Copse helper')
})
