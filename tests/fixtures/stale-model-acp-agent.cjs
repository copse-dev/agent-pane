// Local ACP fixture for a thread whose chosen model the agent no longer offers.
// It advertises a single model through the `category: "model"` config option and
// answers each prompt with a fixed line, so the client's stale-model notice can be
// checked without a model, network, or tools. Spawned by
// `src/main/services/acp/acp-stale-model-spawn.test.ts` and
// `tests/e2e/acp-stale-model-notice.e2e.ts`.
const { createInterface } = require('node:readline')

const SESSION_ID = 'stale-model-fixture'
const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'fixture-model-3',
  options: [{ value: 'fixture-model-3', name: 'Fixture Model 3' }],
}
const REPLIES = ['The build passes on this model.', 'The tests pass too.']

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let turns = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') {
    reply({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'Fixture', version: '1' },
    })
  } else if (message.method === 'session/new') {
    reply({ sessionId: SESSION_ID, configOptions: [MODEL_OPTION] })
  } else if (message.method === 'session/prompt') {
    const text = REPLIES[turns] ?? `Reply ${String(turns + 1)}.`
    turns += 1
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })
    reply({ stopReason: 'end_turn' })
  } else if (message.id !== undefined) {
    reply({})
  }
})
