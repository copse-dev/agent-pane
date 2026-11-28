import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { canonicalWorkspaceTrustRoot } from '../security/workspace-trust.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'

const STORAGE_KEY = 'approvedProjectMcpConfigurations'
const approvalsSchema = z.array(
  z.object({
    root: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
)

export interface ProjectMcpConsent {
  root: string
  configs: McpServerConfig[]
  fingerprint: string
}

function approvedConfigs(): z.infer<typeof approvalsSchema> {
  const parsed = approvalsSchema.safeParse(storageGet(STORAGE_KEY))
  return parsed.success ? parsed.data : []
}

export function projectMcpConsent(root: string, configs: McpServerConfig[]): ProjectMcpConsent {
  const canonicalRoot = canonicalWorkspaceTrustRoot(root)
  return {
    root: canonicalRoot,
    configs,
    fingerprint: createHash('sha256').update(JSON.stringify(configs)).digest('hex'),
  }
}

export function isProjectMcpConfigApproved(consent: ProjectMcpConsent): boolean {
  return approvedConfigs().some(
    (entry) => entry.root === consent.root && entry.fingerprint === consent.fingerprint,
  )
}

/** Persist only the exact project definitions the OS confirmation showed. */
export function approveProjectMcpConfig(consent: ProjectMcpConsent): Promise<void> {
  return storageUpdate(STORAGE_KEY, (current) => {
    const parsed = approvalsSchema.safeParse(current)
    const entries = parsed.success ? parsed.data : []
    return [
      ...entries.filter((entry) => entry.root !== consent.root),
      { root: consent.root, fingerprint: consent.fingerprint },
    ]
  })
}

export function revokeProjectMcpConfig(root: string): Promise<void> {
  const canonicalRoot = canonicalWorkspaceTrustRoot(root)
  return storageUpdate(STORAGE_KEY, (current) => {
    const parsed = approvalsSchema.safeParse(current)
    return parsed.success ? parsed.data.filter((entry) => entry.root !== canonicalRoot) : []
  })
}
