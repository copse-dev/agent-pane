import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

// With the RunAsNode fuse off, `ELECTRON_RUN_AS_NODE` + the app's own
// executable launches another GUI instance, which exits as a second instance
// without running the script. Every Node child goes through the worker runtime.
it('never runs the Electron executable as Node from main-process code', () => {
  const offenders = productionSources('src/main').filter((path) => {
    if (path.endsWith('node-worker-runtime.ts')) return false
    const source = readFileSync(path, 'utf8')
    return source.includes('ELECTRON_RUN_AS_NODE') && source.includes('process.execPath')
  })
  assert.deepEqual(offenders, [])
})
