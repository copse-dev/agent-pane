import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const PORT_BINDING_REQUEST_ENV = 'COPSE_PORT_BINDING_REQUEST'

// Main builds this exact workspace policy while it still has the validated
// worktree registration and active thread's read-root ledger. The worker may
// accept only a loopback network overlay across the process boundary.
const overlaySchema = z.object({
  network: z.object({
    allowedDomains: z.array(z.enum(['localhost', '127.0.0.1', '::1'])),
    deniedDomains: z.array(z.string()),
    allowLocalBinding: z.literal(true),
  }),
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
  env: z.record(z.string(), z.string()).optional(),
  overlay: overlaySchema,
  violationId: z.string().optional(),
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
