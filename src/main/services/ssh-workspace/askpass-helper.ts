#!/usr/bin/env node
import { connect } from 'node:net'

const socketPath = process.env['COPSE_SSH_ASKPASS_SOCKET']
const nonce = process.env['COPSE_SSH_ASKPASS_NONCE']
const prompt = process.argv[2] ?? process.env['SSH_ASKPASS_PROMPT'] ?? ''

if (!socketPath || !nonce) process.exit(1)

const client = connect(socketPath)
client.on('error', () => {
  process.exit(1)
})
client.write(`${JSON.stringify({ nonce, prompt })}\n`)

let buffer = ''
client.on('data', (chunk) => {
  buffer += chunk.toString()
})
client.on('end', () => {
  try {
    const parsed: unknown = JSON.parse(buffer.trim())
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'response' in parsed &&
      (typeof parsed.response === 'string' || parsed.response === null)
    ) {
      if (!parsed.response) process.exit(1)
      process.stdout.write(parsed.response)
      process.exit(0)
    }
  } catch {
    // fall through
  }
  process.exit(1)
})
