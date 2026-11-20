import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getVncService } from '../services/vnc/vnc-service.ts'
import { containVncEventErrors } from './vnc.ts'

// What `vnc:send` does with input for a connection the server already closed:
// the service throws, and `ipcMain.on` has no caller to hand that to.
test('input for a connection that already closed is dropped, not thrown into the main process', (t) => {
  const warnings: string[] = []
  t.mock.method(console, 'warn', (message: string) => {
    warnings.push(message)
  })
  const service = getVncService()
  const send = (_event: null, id: string): void => {
    service.send(id, 1, new Uint8Array([5, 0, 0, 0, 0, 0]))
  }
  const id = '3f0c5a0e-6a51-4a0b-9f0e-0d6a6c1c2b11'
  assert.throws(() => {
    send(null, id)
  }, /Unknown VNC connection/)

  assert.doesNotThrow(() => {
    containVncEventErrors('vnc:send', send)(null, id)
  })
  assert.deepEqual(warnings, ['[copse-panel] dropped vnc:send: Unknown VNC connection'])
})

test('a contained listener still receives its arguments', () => {
  const seen: unknown[][] = []
  containVncEventErrors('vnc:start', (event: string, id: string) => {
    seen.push([event, id])
  })('event', 'id')
  assert.deepEqual(seen, [['event', 'id']])
})
