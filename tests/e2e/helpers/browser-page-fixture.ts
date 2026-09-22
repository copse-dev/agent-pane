import { createServer } from 'node:http'
import { listenOnFixturePort } from './fixture-server.ts'

/** A real webview destination with no DNS, public network, or third-party assets. */
export async function startBrowserPageFixture(port: number) {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    if (path !== '/page') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html lang="en">
        <head>
          <title>Copse browser fixture</title>
          <style>
            body { margin: 16px; font: 14px system-ui; color: #23332d; background: #f3f5ef; }
            main { max-width: 200px; padding: 12px; background: white; border: 1px solid #c7d0c8; }
            h1 { margin-top: 0; font-size: 20px; }
          </style>
        </head>
        <body><main>
          <h1>Local browser page</h1>
          <p>This page is served by the test's local HTTP fixture.</p>
        </main></body>
      </html>`)
  })
  const origin = await listenOnFixturePort(server, port)
  return {
    origin,
    url: `${origin}/page`,
    requests,
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      server.closeAllConnections()
      await closed
    },
  }
}
