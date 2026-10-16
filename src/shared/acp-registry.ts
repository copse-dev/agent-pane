/** Public discovery metadata, never an executable config or permission grant. */
export const ACP_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

export interface AcpRegistryEntry {
  id: string
  title: string
  version: string
  description: string
  website?: string
  packages: string[]
  platforms: string[]
  /** A simple binary name declared for this host, not a package runner. */
  command?: string
  args: string[]
  /** Filesystem presence only; no handshake or version check was run. */
  installedPath: string | null
}

export interface AcpRegistryListing {
  entries: AcpRegistryEntry[]
  fetchedAt: number
  skipped: number
}
