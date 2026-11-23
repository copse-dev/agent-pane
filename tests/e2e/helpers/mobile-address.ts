import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'

/**
 * A private IPv4 address on this host whose Mobile Companion port is free.
 * A daily Copse may already own the stable port on one interface: this only
 * probes availability, and never stops it or sends requests to its profile.
 */
export async function availableMobileAddress(port = 42773): Promise<string | undefined> {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === 'IPv4' &&
        !entry.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
    )
    .map((entry) => entry.address)
  for (const address of addresses) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => {
        resolve(false)
      })
      probe.listen(port, address, () => {
        probe.close(() => {
          resolve(true)
        })
      })
    })
    if (available) return address
  }
  return undefined
}
