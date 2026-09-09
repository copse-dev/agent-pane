/** Container wire contracts. Shared by IPC, the host, and the guest; no runtime state. */
import { z } from 'zod'

export const containerRunRequestSchema = z.object({
  projectId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
  prompt: z.string().min(1).max(200_000),
  model: z.string().min(1).max(256),
  budgets: z.object({
    wallClockMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000),
    tokenCeiling: z.number().int().min(1_000).max(100_000_000),
  }),
  extraEgress: z
    .array(z.string().regex(/^(?:\*\.)?[a-z0-9.-]+:\d{1,5}$/i))
    .max(16)
    .optional(),
  useAgentLogin: z.boolean().optional(),
  installDependencies: z.boolean().optional(),
  continueFrom: z
    .string()
    .regex(/^[a-z0-9-]{1,128}$/i)
    .optional(),
  continueContext: z
    .object({
      prompt: z.string().max(200_000),
      report: z.string().max(200_000),
      ref: z
        .string()
        .regex(/^refs\/copse\/runs\/[a-z0-9-]{1,128}$/i)
        .nullable(),
    })
    .optional(),
})

export const threadContainerResultSchema = z.object({
  threadId: z.string(),
  stopReason: z.enum(['completed', 'budget:wall-clock', 'budget:tokens', 'aborted', 'error']),
  error: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  harness: z.union([z.literal('copse'), z.object({ acp: z.string() })]),
  promptsAttempted: z.number(),
  deferrals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      subject: z.string(),
      reasons: z.array(z.string()).optional(),
    }),
  ),
  denials: z.array(z.object({ subject: z.string(), reasons: z.array(z.string()) })),
  commits: z.array(z.string()),
  containment: z.object({
    declared: z.boolean(),
    declineReason: z.string().nullable(),
    projectSandbox: z.boolean(),
  }),
  toolNames: z.array(z.string()),
  finalText: z.string(),
})

export const containerRuntimeAttestationSchema = z.object({
  runtimeId: z.string().min(1),
  image: z.string().min(1),
  imageDigest: z.string().min(1).optional(),
  user: z.number().int().positive(),
  readOnlyRootfs: z.boolean(),
  capDropAll: z.boolean(),
  noNewPrivileges: z.boolean(),
  pidsLimit: z.number().int().positive(),
  memoryLimit: z.string().min(1),
  network: z.enum(['none', 'brokered']),
  egressAllowlist: z.array(z.string().min(1)),
  hostMounts: z.array(z.string().min(1)),
  securityProfiles: z.enum(['default', 'unconfined']).optional(),
  perCommandNetwork: z.enum(['token-gated', 'none']).optional(),
})
