/** The secret-free run.json contract, written by the host and validated by the guest. */
import { z } from 'zod'
import {
  decodeProviderDescription,
  type ProviderDescription,
} from '../providers/provider-description.ts'
import { acpAgentConfigSchema } from '../storage/settings-writable.ts'

export const threadContainerRunSpecSchema = z.object({
  runtimeId: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  provider: z
    .unknown()
    .transform((value, context): ProviderDescription => {
      const description = decodeProviderDescription(value)
      if (description !== null) return description
      context.addIssue({ code: 'custom', message: 'not a provider description' })
      return z.NEVER
    })
    .nullable(),
  contextWindow: z.number().int().positive().nullable(),
  apiKeyEnv: z.string().min(1).nullable(),
  acp: z
    .object({
      agent: acpAgentConfigSchema,
      keyEnvName: z.string(),
      login: z.object({ files: z.array(z.string().min(1)) }).optional(),
    })
    .nullable(),
  installDependencies: z.boolean().default(false),
  budgets: z.object({
    wallClockMs: z.number().positive(),
    tokenCeiling: z.number().positive(),
  }),
  workspace: z.string().min(1),
  carryInRef: z.string().min(1),
  carryInBase: z.string().min(1),
  originUrl: z.string().nullable().default(null),
  maxSteps: z.number().int().positive().nullable(),
})

export type ThreadContainerRunSpec = z.infer<typeof threadContainerRunSpecSchema>
