/** CLI host inference remaps only the socket destination, never the URL authority. */
import { Agent, buildConnector } from 'undici'
import { normalizeHostname } from '@copse/llm/credential-url.ts'
import { dialAddress, hostLocalAliasRefusal } from './egress-broker.ts'
import { HOST_LOCAL_ALIAS, parseEgressRule } from './egress-rules.ts'

export function createResolvedProviderFetch(
  resolve: Readonly<Record<string, string>>,
  connect: buildConnector.connector = buildConnector({}),
): { fetch: typeof globalThis.fetch; close: () => Promise<void> } {
  const mappings = new Map(
    Object.entries(resolve).map(([host, addr]) => [normalizeHostname(host), addr]),
  )
  if (mappings.has(HOST_LOCAL_ALIAS)) {
    const refusal = hostLocalAliasRefusal(
      [parseEgressRule(`${HOST_LOCAL_ALIAS}:443`)],
      Object.fromEntries(mappings),
    )
    if (refusal) throw new Error(refusal)
  }
  const agent = new Agent({
    connect: (options, callback): void => {
      const hostname = normalizeHostname(options.hostname)
      const mapped = mappings.get(hostname)
      if (hostname === HOST_LOCAL_ALIAS && mapped === undefined) {
        callback(
          new Error(`${HOST_LOCAL_ALIAS} must be resolved to this computer's loopback`),
          null,
        )
        return
      }
      if (mapped === undefined) {
        connect(options, callback)
        return
      }
      try {
        const destination = dialAddress(
          Object.fromEntries(mappings),
          hostname,
          Number(options.port),
        )
        // localhost always means loopback, including the reserved host-local alias.
        const dialHost = normalizeHostname(destination.host)
        connect(
          {
            ...options,
            hostname: dialHost === 'localhost' ? '127.0.0.1' : dialHost,
            port: String(destination.port),
            // Connector TLS verification and SNI must name the logical endpoint.
            servername: options.servername ?? normalizeHostname(options.hostname),
          },
          callback,
        )
      } catch (error) {
        callback(error instanceof Error ? error : new Error('Invalid --resolve destination'), null)
      }
    },
  })
  return {
    fetch: (input, init): Promise<Response> => {
      const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher: agent }
      return globalThis.fetch(input, options)
    },
    close: (): Promise<void> => agent.destroy(),
  }
}
