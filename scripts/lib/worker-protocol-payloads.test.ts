import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { API_PROTOCOL_VERSION } from '../../src/shared/api-protocol.mts'
import { workerProtocolDocument } from '../../src/main/services/worker-protocol/worker-protocol-document.ts'
import { isRecord } from '../../src/shared/unknown-value.mts'
import { generateApiProtocol } from './api-protocol.mts'
import { WORKER_PAYLOAD_TYPES, withPayloadTypes } from './worker-protocol-payloads.mts'

function refs(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) refs(item, into)
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') into.push(item)
      else refs(item, into)
    }
  return into
}

describe('worker protocol payload types', () => {
  const api = generateApiProtocol({ version: API_PROTOCOL_VERSION })
  const published = withPayloadTypes({ ...workerProtocolDocument() }, api.$defs)

  it('points every pass-through payload at its type, and carries every type it names', () => {
    const text = JSON.stringify(published)
    for (const payload of WORKER_PAYLOAD_TYPES)
      assert.ok(
        text.includes(`"${payload.field}":{"$ref":"#/$defs/${payload.type}"}`),
        payload.type,
      )
    const defs = published['$defs']
    assert.ok(isRecord(defs))
    for (const ref of refs(published)) {
      assert.ok(ref.startsWith('#/$defs/'), ref)
      assert.ok(Object.hasOwn(defs, ref.slice('#/$defs/'.length)), `${ref} is defined`)
    }
  })

  it('refuses a payload type the API protocol does not describe', () => {
    const { StreamChunk: _gone, ...rest } = api.$defs
    assert.throws(() => withPayloadTypes({ ...workerProtocolDocument() }, rest), /StreamChunk/)
  })
})
