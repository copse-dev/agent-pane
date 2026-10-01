export interface PluginInstallPin {
  contentHash: string
  revision: string
  version?: string
}

export interface PluginInstallRecord {
  schemaVersion: 1
  catalogId: string
  pluginId: string
  name: string
  version?: string
  source: {
    repository: string
    path: string
    revision: string
  }
  contentHash: string
  installedAt: string
  updatedAt: string
  provenance: 'unsigned'
  enabled: false
  previousPin?: PluginInstallPin
}

export interface PluginInstallReview {
  token: string
  catalogId: string
  pluginId: string
  name: string
  version?: string
  description?: string
  publisher: string
  contentHash: string
  revision: string
  skillCount: number
  mcpServerCount: number
  skills: readonly string[]
  mcpServers: readonly {
    name: string
    transport: 'stdio' | 'streamable-http' | 'sse'
    target: string
  }[]
  warnings: readonly string[]
  provenance: 'unsigned'
  operation: 'install' | 'update'
}

export interface PluginInstallCommitResult {
  record: PluginInstallRecord
}

export interface PluginUninstallResult {
  pluginId: string
  dataDeleted: boolean
}

export interface PluginRollbackResult {
  record: PluginInstallRecord
}
