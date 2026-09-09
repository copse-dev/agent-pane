/**
 * A scripted ACP agent for the container integration test
 * (`docs/plans/thread-in-container.md`, phase A-2): a plain Node program that
 * speaks the protocol over stdio, stands in for a real agent, and does the
 * three things the policy has to answer — an in-guest build, an outward push,
 * a host escape — then commits its work. Kept as a string, like the image
 * files, so the test can drop it into the workspace it carries in; the guest
 * runs it from there under `node`.
 *
 * Every command it is allowed to run, it runs itself, the way a real agent
 * would: the point of the test is that the *agent's own* effects are the
 * ones the contained policy admits or refuses, and that nothing an agent does
 * reaches a dialog.
 */
export const SCRIPTED_ACP_AGENT_SOURCE = `'use strict'
// A minimal ACP agent over ndjson JSON-RPC on stdio. See scripted-acp-agent.ts.
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const readline = require('node:readline')

let nextId = 1
const pending = new Map()
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

async function askToRun(sessionId, n, command) {
  const response = await request('session/request_permission', {
    sessionId,
    toolCall: {
      toolCallId: 't' + String(n),
      title: command,
      kind: 'execute',
      status: 'pending',
      rawInput: { command },
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  })
  const outcome = response && response.outcome
  const allowed = Boolean(outcome && outcome.outcome === 'selected' && outcome.optionId === 'allow')
  if (allowed) {
    try {
      execSync(command, { cwd: process.cwd(), stdio: 'ignore', shell: '/bin/sh' })
    } catch (error) {
      process.stderr.write('[scripted-agent] command failed: ' + String(error) + '\\n')
    }
  }
  return allowed
}

async function prompt(params) {
  const sessionId = params.sessionId
  const seen = []
  seen.push(['build', await askToRun(sessionId, 1, 'rm -rf build && mkdir build && echo built > build/out.txt')])
  seen.push(['push', await askToRun(sessionId, 2, 'git push origin HEAD')])
  seen.push(['escape', await askToRun(sessionId, 3, 'docker ps')])
  fs.writeFileSync(
    'agent-env.txt',
    'key=' + String(process.env.SCRIPTED_AGENT_KEY || '') + '\\n' +
      'canary=' + ('COPSE_SECRET_CANARY' in process.env ? 'present' : 'absent') + '\\n' +
      seen.map(([name, allowed]) => name + '=' + (allowed ? 'allowed' : 'refused')).join('\\n') + '\\n',
  )
  await askToRun(
    sessionId,
    4,
    "printf 'edited by the agent\\\\n' >> README.md && git add README.md build/out.txt agent-env.txt && git commit -q -m 'agent: edit readme'",
  )
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Finished the task; the push was refused.' },
    },
  })
  return { stopReason: 'end_turn' }
}

async function dispatch(message) {
  if (message.id !== undefined && message.method === undefined) {
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
    return
  }
  if (message.method === undefined) return
  const reply = (result) => {
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result })
  }
  try {
    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
          authMethods: [],
        })
        break
      case 'session/new':
        reply({ sessionId: 'scripted-session' })
        break
      case 'session/prompt':
        reply(await prompt(message.params))
        break
      case 'session/cancel':
        break
      default:
        reply({})
    }
  } catch (error) {
    if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error) } })
    }
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  void dispatch(message)
})
`
