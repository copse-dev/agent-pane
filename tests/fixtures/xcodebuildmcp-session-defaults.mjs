import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const buildRoot = dirname(process.argv[2])
const { createSessionAwareTool } = await import(
  pathToFileURL(join(buildRoot, 'utils/typed-tool-factory.js')).href
)
const { sessionStore } = await import(pathToFileURL(join(buildRoot, 'utils/session-store.js')).href)
const defaults = { projectPath: '/demo/Demo.xcodeproj', scheme: 'Demo', configuration: 'Debug' }
sessionStore.clearAll()
sessionStore.setDefaults(defaults)
let received
const context = { emit() {}, attach() {} }
const schema = z.object({
  projectPath: z.string().optional(),
  scheme: z.string().optional(),
  configuration: z.string().optional(),
  buildForTesting: z.boolean().optional(),
  testProductsPath: z.string().optional(),
  xctestrunPath: z.string().optional(),
})
function handler(requirements) {
  return createSessionAwareTool({
    internalSchema: schema,
    requirements,
    exclusivePairs: [],
    getExecutor: () => undefined,
    logicFunction: async (args) => {
      received = args
    },
  })
}
await handler([{ allOf: ['scheme'] }])(
  { buildForTesting: true, testProductsPath: '/demo/tests.xctestproducts' },
  context,
)
assert.equal(
  context.structuredOutput,
  undefined,
  'building test products must keep required session defaults',
)
assert.deepEqual(received, {
  ...defaults,
  buildForTesting: true,
  testProductsPath: '/demo/tests.xctestproducts',
})
for (const source of [
  { testProductsPath: '/demo/tests.xctestproducts' },
  { xctestrunPath: '/demo/tests.xctestrun' },
]) {
  await handler([])(source, context)
  assert.deepEqual(
    received,
    source,
    'prepared test execution must still omit source-project defaults',
  )
}
assert.deepEqual(sessionStore.getAll(), defaults, 'merging must not mutate saved defaults')
sessionStore.clearAll()

const { withTestProductsExtension } = await import(
  pathToFileURL(join(buildRoot, 'utils/test-products-path.js')).href
)
assert.equal(withTestProductsExtension('/demo/output'), '/demo/output.xctestproducts')
assert.equal(
  withTestProductsExtension('/demo/output.xctestproducts'),
  '/demo/output.xctestproducts',
)

// A rejected profile switch must tell the model how to recover, rather than
// silently rendering an unrelated Show Defaults table.
const { createSessionSetDefaultsExecutor } = await import(
  pathToFileURL(join(buildRoot, 'mcp/tools/session-management/session_set_defaults.js')).href
)
const { renderDomainResultTextItems } = await import(
  pathToFileURL(join(buildRoot, 'utils/renderers/domain-result-text.js')).href
)
const rejectedProfile = await createSessionSetDefaultsExecutor({ executor: async () => {} })({
  profile: 'missing-validation-profile',
})
assert.equal(rejectedProfile.didError, true)
const renderedError = JSON.stringify(renderDomainResultTextItems(rejectedProfile))
assert.ok(renderedError.includes('createIfNotExists=true'), renderedError)
assert.ok(renderedError.includes('missing-validation-profile'), renderedError)
assert.ok(!renderedError.includes('"status":"success"'), renderedError)
assert.equal(sessionStore.getActiveProfile(), null)

const beforeInvalidCreate = sessionStore.getAll()
const invalidCreate = await createSessionSetDefaultsExecutor({ executor: async () => {} })({
  simulatorName: 'Disposable validation',
  createIfNotExists: true,
})
assert.equal(
  invalidCreate.didError,
  true,
  'a profile flag must not report success as simulator creation',
)
assert.ok(invalidCreate.error.includes('does not create a Simulator'))
assert.deepEqual(
  sessionStore.getAll(),
  beforeInvalidCreate,
  'invalid creation must not mutate session defaults',
)

// Approving a target-less boot cannot mutate a default/personal simulator:
// the real pinned factory rejects before starting any command.
sessionStore.clearAll()
const { handler: bootWithoutDefaults } = await import(
  pathToFileURL(join(buildRoot, 'mcp/tools/simulator/boot_sim.js')).href
)
const missingTarget = { emit() {}, attach() {} }
const { __setTestCommandExecutorOverride, __clearTestExecutorOverrides } = await import(
  pathToFileURL(join(buildRoot, 'utils/command.js')).href
)
let attemptedNativeCommands = 0
__setTestCommandExecutorOverride(async () => {
  attemptedNativeCommands++
  throw new Error('Validation must precede native execution')
})
try {
  await bootWithoutDefaults({}, missingTarget)
} finally {
  __clearTestExecutorOverrides()
}
assert.equal(attemptedNativeCommands, 0)
assert.ok(
  JSON.stringify(missingTarget.structuredOutput).includes('Provide simulatorId or simulatorName'),
)
