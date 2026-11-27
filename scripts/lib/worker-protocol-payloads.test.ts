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

  it('keeps an optional payload optional, and describes what the app checks', () => {
    const roles = published['roles']
    assert.ok(isRecord(roles) && isRecord(roles['turns']))
    const union = roles['turns']['workerToClient']
    assert.ok(isRecord(union))
    const variants = union['oneOf'] ?? union['anyOf']
    assert.ok(Array.isArray(variants))
    const message = (name: string): Record<string, unknown> => {
      const found: unknown = variants.find(
        (variant: unknown) =>
          isRecord(variant) &&
          isRecord(variant['properties']) &&
          isRecord(variant['properties']['t']) &&
          variant['properties']['t']['const'] === name,
      )
      assert.ok(isRecord(found) && isRecord(found['properties']), name)
      return found
    }
    const chunk = message('chunk')
    assert.ok(Array.isArray(chunk['required']))
    assert.ok(!chunk['required'].includes('stamp'))
    // Checked by the app before it acts, so a worker must be told their fields.
    for (const [name, field] of [
      ['thread-prompt', 'command'],
      ['task-call', 'call'],
    ] as const) {
      const properties = message(name)['properties']
      assert.ok(isRecord(properties))
      const shape = properties[field]
      assert.ok(isRecord(shape) && Object.keys(shape).length > 0, `${name}.${field} has a shape`)
    }
  })

  it("publishes a host's thread prompt as the window's command less what the app adds", () => {
    const defs = published['$defs']
    assert.ok(isRecord(defs))
    const command = defs['HostThreadPromptCommand']
    assert.ok(isRecord(command) && isRecord(command['properties']))
    assert.ok(Array.isArray(command['required']))
    for (const added of ['id', 'expiresAt']) {
      assert.ok(!Object.hasOwn(command['properties'], added), added)
      assert.ok(!command['required'].includes(added), added)
    }
    assert.deepEqual(command['properties']['thread'], { $ref: '#/$defs/Thread' })
  })

  it('refuses a message or field that is not on the line', () => {
    const document = workerProtocolDocument()
    const roles = structuredClone(document.roles)
    const union = roles.turns.workerToClient
    const variants = union['oneOf'] ?? union['anyOf']
    assert.ok(Array.isArray(variants))
    roles.turns.workerToClient = {
      ...union,
      oneOf: variants.filter(
        (variant: unknown) =>
          !(
            isRecord(variant) &&
            isRecord(variant['properties']) &&
            isRecord(variant['properties']['t']) &&
            variant['properties']['t']['const'] === 'snapshot'
          ),
      ),
      anyOf: undefined,
    }
    assert.throws(() => withPayloadTypes({ ...document, roles }, api.$defs), /snapshot/)
  })

  it('refuses a payload type the API protocol does not describe', () => {
    const { StreamChunk: _gone, ...rest } = api.$defs
    assert.throws(() => withPayloadTypes({ ...workerProtocolDocument() }, rest), /StreamChunk/)
  })
})
