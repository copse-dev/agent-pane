import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { WORKER_ROLES } from './worker-capabilities.ts'
import {
  serializeWorkerProtocol,
  WORKER_PROTOCOL_MANIFEST_PATH,
  workerProtocolDocument,
  workerProtocolManifest,
} from './worker-protocol-document.ts'

/**
 * The committed manifest is the written-down worker protocol. It must equal
 * what the line schemas generate, so the protocol changes only when someone
 * regenerates it (`pnpm run gen:worker-protocol`) and the change shows in review.
 */
describe('worker protocol document', () => {
  const document = workerProtocolDocument()
  const manifest = workerProtocolManifest(document)

  it('matches the committed manifest', () => {
    const onDisk = readFileSync(resolve(WORKER_PROTOCOL_MANIFEST_PATH), 'utf8')
    assert.equal(
      onDisk,
      serializeWorkerProtocol(manifest),
      `${WORKER_PROTOCOL_MANIFEST_PATH} is stale: run \`pnpm run gen:worker-protocol\` and commit it`,
    )
  })

  it('has every role open with hello both ways, the worker saying what it can run', () => {
    for (const role of WORKER_ROLES) {
      const { clientToWorker, workerToClient } = manifest.roles[role]
      assert.deepEqual(clientToWorker['hello'], ['protocol', 'version'], role)
      const hello = workerToClient['hello'] ?? []
      for (const field of ['pid', 'protocol', 'version'])
        assert.ok(hello.includes(field), `${role} hello has ${field}`)
      assert.ok(
        hello.includes('capabilities') || hello.includes('capabilities?'),
        `${role} hello says what the worker can run`,
      )
    }
  })

  it('writes plain JSON Schema for each direction of each role', () => {
    for (const role of WORKER_ROLES) {
      const schemas = document.roles[role]
      assert.ok(Number.isInteger(schemas.protocol) && schemas.protocol > 0, role)
      for (const direction of [schemas.clientToWorker, schemas.workerToClient])
        assert.ok(Array.isArray(direction['oneOf'] ?? direction['anyOf']), role)
    }
    assert.doesNotThrow(() => JSON.parse(serializeWorkerProtocol(document)))
  })
})
