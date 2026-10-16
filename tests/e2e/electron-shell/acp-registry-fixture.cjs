'use strict'

const { appendFileSync, existsSync, readFileSync } = require('node:fs')

// Test-shell-only replacement of the HTTP boundary; product code still decodes
// the registry, scans PATH and crosses the real Settings IPC. No product flag.
exports.install = (fixturePath) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json') {
      return originalFetch(input, init)
    }
    appendFileSync(`${fixturePath}.requests`, 'fetch\n')
    return Promise.resolve(
      existsSync(`${fixturePath}.offline`)
        ? new Response('Offline fixture', { status: 503 })
        : new Response(readFileSync(fixturePath, 'utf8'), {
            headers: { 'content-type': 'application/json' },
          }),
    )
  }
}
