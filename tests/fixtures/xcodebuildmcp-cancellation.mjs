import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const buildRoot = dirname(process.argv[2])
const load = (name) => import(pathToFileURL(join(buildRoot, name)).href)
const { setServer } = await load('server/server-state.js')
const { registerWorkflowsFromManifest, __resetToolRegistryForTests } =
  await load('utils/tool-registry.js')
const {
  getDefaultCommandExecutor,
  __setTestCommandExecutorOverride,
  __clearTestExecutorOverrides,
} = await load('utils/command.js')
const { sessionStore } = await load('utils/session-store.js')
const realExecutor = getDefaultCommandExecutor()
const handlers = new Map()
setServer({
  registerTool(name, _definition, handler) {
    handlers.set(name, handler)
    return { remove() {} }
  },
})
const directory = await mkdtemp(join(tmpdir(), 'copse-mcp-cancel-'))
const marker = join(directory, 'started')
let nativeExecutions = 0
__setTestCommandExecutorOverride((command, prefix, shell, options) => {
  nativeExecutions++
  if (nativeExecutions > 1) throw new Error('Cancelled request started another native command')
  return realExecutor(
    [
      process.execPath,
      '-e',
      'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 2000)',
      marker,
    ],
    prefix,
    false,
    options,
  )
})
try {
  sessionStore.clearAll()
  await registerWorkflowsFromManifest(['simulator-management'])
  const boot = handlers.get('boot_sim')
  assert.ok(boot, 'real MCP registry must register boot_sim')
  const controller = new AbortController()
  const task = boot(
    { simulatorId: '00000000-0000-4000-8000-000000000001' },
    { signal: controller.signal },
  )
  let pid
  for (let n = 0; n < 100; n++) {
    pid = await readFile(marker, 'utf8').catch(() => null)
    if (pid) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(pid, 'request must reach a real child process before cancellation')
  process.kill(Number(pid), 0)
  const start = performance.now()
  controller.abort(new Error('User cancelled native validation'))
  await task.catch(() => {})
  assert.ok(
    performance.now() - start < 1500,
    'MCP cancellation must stop native execution, not merely stop waiting for it',
  )
  assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' })
  assert.equal(nativeExecutions, 1)
  const { requestSignalStorage } = await load('utils/request-cancellation.js')
  const { getDefaultInteractiveSpawner } = await load('utils/execution/interactive-process.js')
  const interactiveController = new AbortController()
  const interactiveMarker = join(directory, 'interactive-started')
  const interactive = requestSignalStorage.run(interactiveController.signal, () =>
    getDefaultInteractiveSpawner()([
      process.execPath,
      '-e',
      'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 2000)',
      interactiveMarker,
    ]),
  )
  let interactivePid
  for (let n = 0; n < 100; n++) {
    interactivePid = await readFile(interactiveMarker, 'utf8').catch(() => null)
    if (interactivePid) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(interactivePid)
  process.kill(Number(interactivePid), 0)
  const closed = new Promise((resolve) => interactive.process.once('close', resolve))
  const interactiveStart = performance.now()
  interactiveController.abort()
  await closed
  assert.ok(
    performance.now() - interactiveStart < 1500,
    'cancelled launch/debug helpers must not survive their request',
  )
  assert.throws(() => process.kill(Number(interactivePid), 0), { code: 'ESRCH' })
} finally {
  __clearTestExecutorOverrides()
  __resetToolRegistryForTests()
  sessionStore.clearAll()
  await rm(directory, { recursive: true, force: true })
}
