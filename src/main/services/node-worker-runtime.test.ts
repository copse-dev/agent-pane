import assert from 'node:assert/strict'
import { it } from 'node:test'
import { nodeWorkerScript, resolveNodeWorkerExecutable } from './node-worker-runtime.ts'

it('uses a separate interpreter only in packaged macOS and resolves physical worker files', () => {
  const runtime = {
    packaged: true,
    platform: 'darwin',
    arch: 'arm64',
    resourcesPath: '/Applications/Copse.app/Contents/Resources',
    execPath: '/Applications/Copse.app/Contents/MacOS/Copse',
  } as const
  assert.equal(
    resolveNodeWorkerExecutable(runtime),
    '/Applications/Copse.app/Contents/Resources/app.asar.unpacked/dist/resources/node/arm64/node',
  )
  assert.equal(resolveNodeWorkerExecutable({ ...runtime, packaged: false }), runtime.execPath)
  assert.equal(resolveNodeWorkerExecutable({ ...runtime, platform: 'linux' }), runtime.execPath)
  assert.throws(() => resolveNodeWorkerExecutable({ ...runtime, resourcesPath: undefined }))
  assert.equal(
    nodeWorkerScript(
      '/Applications/Copse.app/Contents/Resources/app.asar/dist/main/sandbox-fs-worker.js',
    ),
    '/Applications/Copse.app/Contents/Resources/app.asar.unpacked/dist/main/sandbox-fs-worker.js',
  )
  assert.equal(
    nodeWorkerScript('/tmp/dev/dist/main/sandbox-fs-worker.js'),
    '/tmp/dev/dist/main/sandbox-fs-worker.js',
  )
})
