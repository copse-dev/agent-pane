import assert from 'node:assert/strict'
import { fixtureDeployment, runAzureScenario } from './fixture.mts'

const result = await runAzureScenario()
assert.equal(result.deployment, fixtureDeployment)
assert.equal(result.requests, 2)
assert.equal(result.credentialResolutions, 2)
assert.equal(result.rotatedCredential, true)
assert.equal(result.replayedToolResult, true)
assert.equal(result.text, 'Checked café. Done.')
assert.equal(result.inputTokens, 40)
assert.equal(result.outputTokens, 10)
assert.equal(result.cacheReadTokens, 8)
console.log(
  JSON.stringify(
    {
      mode: 'offline mock transport; no live Azure account or credentials',
      ...result,
    },
    null,
    2,
  ),
)
