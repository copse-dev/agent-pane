import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const PORT_BINDING_REQUEST_ENV = 'COPSE_PORT_BINDING_REQUEST'

/**
 * A public host a per-command network scope may open: a DNS name, optionally one
 * leading `*.` wildcard label. Never loopback, an IP literal or a bare label, so a
 * scoped command cannot reach a local service through this policy.
 */
export const SCOPED_NETWORK_DOMAIN =
  /^(?:\*\.)?(?!localhost$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9]$/

// Main builds this exact workspace policy while it still has the validated
// worktree registration and active thread's read-root ledger. The worker may
// accept only two network overlays across the process boundary: loopback with
// binding (an approved dev server), or a short list of public hosts without
// binding (one network-scoped command, `network-scoped-shell.ts`).
const loopbackNetworkSchema = z.object({
  allowedDomains: z.array(z.enum(['localhost', '127.0.0.1', '::1'])),
  deniedDomains: z.array(z.string()),
  allowLocalBinding: z.literal(true),
})
const scopedNetworkSchema = z.object({
  allowedDomains: z.array(z.string().regex(SCOPED_NETWORK_DOMAIN)).min(1).max(8),
  deniedDomains: z.array(z.string()),
  allowLocalBinding: z.literal(false),
})
const overlaySchema = z.object({
  network: z.union([loopbackNetworkSchema, scopedNetworkSchema]),
  filesystem: z.object({
    denyRead: z.array(z.string()),
    allowRead: z.array(z.string()),
    allowWrite: z.array(z.string()),
    denyWrite: z.array(z.string()),
    allowGitConfig: z.boolean(),
  }),
})

const requestSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().refine(isAbsolute),
  // Selected by main with its thread identity, never from the command's env.
  tmpDir: z.string().refine(isAbsolute),
  env: z.record(z.string(), z.string()).optional(),
  overlay: overlaySchema,
  violationId: z.string().optional(),
  /** A foreground command: give it EOF on stdin instead of a held-open pipe. */
  closeStdin: z.boolean().optional(),
})

export type PortBindingRequest = z.infer<typeof requestSchema>

export function parsePortBindingRequest(raw: string): PortBindingRequest | null {
  return safeJsonParse(raw, decodeWithSchema(requestSchema))
}

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('network-denial'), host: z.string(), port: z.number().optional() }),
  z.object({ type: z.literal('violations'), count: z.number().int().nonnegative() }),
])

export type PortBindingMessage = z.infer<typeof messageSchema>

export function parsePortBindingMessage(value: unknown): PortBindingMessage | null {
  const result = messageSchema.safeParse(value)
  return result.success ? result.data : null
}
