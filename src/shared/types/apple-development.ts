import { z } from 'zod'

export const APPLE_ACTIONS = ['build', 'test', 'run'] as const
export type AppleAction = (typeof APPLE_ACTIONS)[number]

export const APPLE_OPERATION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type AppleOperationStatus = (typeof APPLE_OPERATION_STATUSES)[number]

export const appleCandidateSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  kind: z.enum(['workspace', 'project']),
  schemes: z.array(z.string().min(1).max(256)).max(200),
  metadataError: z.string().min(1).max(2_048).optional(),
})
export type AppleCandidate = z.infer<typeof appleCandidateSchema>

export const appleDestinationSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  platform: z.string().min(1).max(128),
  supported: z.boolean(),
  booted: z.boolean().optional(),
})
export type AppleDestination = z.infer<typeof appleDestinationSchema>

export const appleSelectionSchema = z.object({
  candidateId: z.string().min(1).max(512),
  schemeId: z.string().min(1).max(256),
  configuration: z.string().min(1).max(128),
  destinationId: z.string().min(1).max(512),
  revision: z.number().int().positive(),
})
export type AppleSelection = z.infer<typeof appleSelectionSchema>

export const appleDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning', 'note']),
  message: z.string().max(8_192),
  file: z.string().max(4_096).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
})
export type AppleDiagnostic = z.infer<typeof appleDiagnosticSchema>

export const appleTestSummarySchema = z.object({
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
})
export type AppleTestSummary = z.infer<typeof appleTestSummarySchema>

export const appleOutcomeSchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  reason: z.string().max(8_192).optional(),
  exitCode: z.number().int().nullable(),
  diagnostics: z.array(appleDiagnosticSchema).max(500),
  testSummary: appleTestSummarySchema.nullable(),
  logArtifactId: z.string().min(1),
  resultBundleArtifactId: z.string().min(1).optional(),
  appSessionId: z.string().min(1).optional(),
  outputTruncated: z.boolean(),
})
export type AppleOutcome = z.infer<typeof appleOutcomeSchema>

export const appleOperationSchema = z.object({
  id: z.string().min(1),
  action: z.enum(APPLE_ACTIONS),
  status: z.enum(APPLE_OPERATION_STATUSES),
  target: appleSelectionSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  outcome: appleOutcomeSchema.nullable(),
})
export type AppleOperation = z.infer<typeof appleOperationSchema>

export const appleProjectStateSchema = z.object({
  pluginEnabled: z.boolean(),
  enrolled: z.boolean(),
  supportedHost: z.boolean(),
  toolchain: z
    .object({ developerDir: z.string().min(1), version: z.string().min(1).max(512) })
    .nullable(),
  candidates: z.array(appleCandidateSchema).max(100),
  destinations: z.array(appleDestinationSchema).max(200),
  metadataRequiresExecution: z.boolean(),
  selection: appleSelectionSchema.nullable(),
  operations: z.array(appleOperationSchema).max(50),
  setupMessage: z.string().max(2_048).nullable(),
})
export type AppleProjectState = z.infer<typeof appleProjectStateSchema>

/** Cheap project-level probe used to decide whether Apple setup belongs in a workspace menu. */
export interface AppleProjectDetection {
  detected: boolean
  enrolled: boolean
  supportedHost: boolean
}

export const appleConfigureInputSchema = z.object({
  candidateId: z.string().min(1).max(512),
  schemeId: z.string().min(1).max(256),
  configuration: z.string().min(1).max(128),
  destinationId: z.string().min(1).max(512),
  expectedRevision: z.number().int().nonnegative(),
})
export type AppleConfigureInput = z.infer<typeof appleConfigureInputSchema>

export const appleExecuteInputSchema = z.object({
  action: z.enum(APPLE_ACTIONS),
  expectedRevision: z.number().int().positive(),
  requestId: z.string().min(1).max(256),
  testFilter: z.string().min(1).max(512).optional(),
})
export type AppleExecuteInput = z.infer<typeof appleExecuteInputSchema>

export const appleOperationInputSchema = z.object({
  operationId: z.string().min(1).max(256),
  action: z.enum(['status', 'logs', 'cancel']),
  logCursor: z.number().int().nonnegative().optional(),
})
export type AppleOperationInput = z.infer<typeof appleOperationInputSchema>

export interface AppleOperationLogPage {
  operation: AppleOperation
  text: string
  nextCursor: number
  truncated: boolean
}
