import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseSupervisedTaskAuditEvent,
  parseSupervisedTaskAuditLog,
  parseSupervisedTaskMeta,
  serializeSupervisedTaskAuditEvent,
  taskAuditPath,
  taskDir,
  taskMetaPath,
  tasksDir,
} from './task-schema.ts'

const fix = join(process.cwd(), 'tests/fixtures/background-supervisor')

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fix, name), 'utf8'))
}

describe('task-schema paths', () => {
  it('keeps task artifacts under tasks/<taskId>/', () => {
    assert.equal(tasksDir(), 'tasks')
    assert.equal(taskDir('t1'), 'tasks/t1')
    assert.equal(taskMetaPath('t1'), 'tasks/t1/meta.json')
    assert.equal(taskAuditPath('t1'), 'tasks/t1/audit.jsonl')
  })
})

describe('task-schema fixtures validate', () => {
  it('accepts queued / running / waiting / blocked / completed metas', () => {
    assert.ok(parseSupervisedTaskMeta(readJson('meta-queued.json')))
    assert.ok(parseSupervisedTaskMeta(readJson('meta-running-with-handle.json')))
    assert.ok(parseSupervisedTaskMeta(readJson('meta-waiting-wake-at.json')))
    assert.ok(parseSupervisedTaskMeta(readJson('meta-blocked.json')))
    assert.ok(parseSupervisedTaskMeta(readJson('meta-completed.json')))
  })

  it('rejects unknown state and missing taskId', () => {
    const base = readJson('meta-queued.json')
    assert.ok(base && typeof base === 'object')
    assert.equal(parseSupervisedTaskMeta({ ...base, state: 'teleporting' }), null)
    assert.equal(parseSupervisedTaskMeta({ ...base, taskId: '' }), null)
  })

  it('rejects malformed triggers', () => {
    const base = readJson('meta-queued.json')
    assert.ok(base && typeof base === 'object')
    assert.equal(parseSupervisedTaskMeta({ ...base, trigger: { kind: 'wake_at' } }), null)
    assert.equal(parseSupervisedTaskMeta({ ...base, trigger: { kind: 'cron' } }), null)
  })

  it('accepts durable handler input and rejects non-record input', () => {
    const base = readJson('meta-queued.json')
    assert.ok(base && typeof base === 'object')
    const parsed = parseSupervisedTaskMeta({ ...base, handlerInput: { prNumber: 42 } })
    assert.deepEqual(parsed?.handlerInput, { prNumber: 42 })
    assert.equal(parseSupervisedTaskMeta({ ...base, handlerInput: ['not', 'a', 'record'] }), null)
  })

  it('parses happy-path and reconcile audit JSONL fixtures', () => {
    const happy = parseSupervisedTaskAuditLog(readFileSync(join(fix, 'audit-happy.jsonl'), 'utf8'))
    assert.equal(happy.length, 3)
    assert.equal(happy[0]?.action, 'enqueue')
    assert.equal(happy[2]?.toState, 'completed')

    const recon = parseSupervisedTaskAuditLog(
      readFileSync(join(fix, 'audit-reconcile.jsonl'), 'utf8'),
    )
    assert.equal(recon.length, 3)
    const failEvent = recon[2]
    assert.ok(failEvent)
    assert.equal(failEvent.action, 'fail')
    assert.equal(failEvent.reason, 'process handle lost on restart')
  })

  it('skips malformed audit lines and rejects events without toState', () => {
    const mixed = [
      '{"v":1,"id":"ok","taskId":"t","action":"enqueue","at":1,"toState":"queued"}',
      'not-json',
      '{"v":1,"id":"bad","taskId":"t","action":"start","at":2}',
      '',
    ].join('\n')
    const events = parseSupervisedTaskAuditLog(mixed)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.id, 'ok')

    assert.equal(
      parseSupervisedTaskAuditEvent({
        v: 1,
        id: 'x',
        taskId: 't',
        action: 'start',
        at: 1,
      }),
      null,
    )
  })

  it('round-trips audit events through serialize', () => {
    const [first] = parseSupervisedTaskAuditLog(
      readFileSync(join(fix, 'audit-happy.jsonl'), 'utf8'),
    )
    assert.ok(first)
    const again = parseSupervisedTaskAuditEvent(
      JSON.parse(serializeSupervisedTaskAuditEvent(first)) as unknown,
    )
    assert.deepEqual(again, first)
  })
})
