import { once } from 'node:events'
import type { Server } from 'node:http'

/**
 * Listen on a fixed loopback port, falling back to an ephemeral one only if
 * that port is taken.
 *
 * A fixture page's URL lands in captures — the browser address bar, a plugin's
 * returned snapshot, a shared-link chip — and `listen(0)` puts a different port
 * there on every run. Specs run one at a time within a shard, and each closes
 * its server in `after`, so a fixed port is free in practice; the fallback only
 * keeps a stray listener on the runner from failing the spec outright (the
 * capture then differs, which is what the reference diff is for).
 *
 * Give every spec its own port so two fixtures never contend.
 */
export async function listenOnFixturePort(server: Server, port: number): Promise<string> {
  const bound = await bind(server, port).catch(async (error: unknown) => {
    if (!isAddressInUse(error)) throw error
    console.warn(
      `[fixture-server] port ${String(port)} is in use on this host; falling back to an ephemeral port, so URL captures will differ from the committed references`,
    )
    return bind(server, 0)
  })
  return `http://127.0.0.1:${String(bound)}`
}

async function bind(server: Server, port: number): Promise<number> {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no TCP port')
  return address.port
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  )
}
