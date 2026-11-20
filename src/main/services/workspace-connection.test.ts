import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareWorkspaceConnection } from './workspace-connection.ts'

test('remote activation checks enablement before connecting', async () => {
  let connected = false
  await assert.rejects(
    prepareWorkspaceConnection({
      enabled: false,
      connected: false,
      connect: async () => {
        connected = true
      },
    }),
    /\[workspace-connection\] Enable SSH workspaces/,
  )
  assert.equal(connected, false)
})

test('a connected host does no extra connection work', async () => {
  await prepareWorkspaceConnection({
    enabled: true,
    connected: true,
    connect: async () => {
      throw new Error('must not reconnect')
    },
  })
})

test('connection failure is distinguished from a missing project folder', async () => {
  await assert.rejects(
    prepareWorkspaceConnection({
      enabled: true,
      connected: false,
      connect: async () => {
        throw new Error('offline')
      },
    }),
    /\[workspace-connection\] SSH connection failed: offline/,
  )
})
