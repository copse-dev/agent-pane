// Local ACP fixture: stream a reply, then wait for Stop. No model, network,
// or workspace tools are needed to exercise an active named-agent identity.
const { createInterface } = require('node:readline')
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let pendingPrompt
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') {
    reply({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'Maple', version: '1' } })
  } else if (message.method === 'session/new') {
    reply({ sessionId: 'riso-eval' })
  } else if (message.method === 'session/prompt') {
    pendingPrompt = message.id
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'riso-eval',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I’m reviewing the next section.' },
        },
      },
    })
  } else if (message.method === 'session/cancel' && pendingPrompt !== undefined) {
    send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } })
    pendingPrompt = undefined
  } else if (message.id !== undefined) {
    reply({})
  }
})
