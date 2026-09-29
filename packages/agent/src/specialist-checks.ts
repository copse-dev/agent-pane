import { z } from 'zod'

export const RUN_SPECIALIST_CHECK_TOOL_NAME = 'run_specialist_check'
export const GATHER_SPECIALIST_EVIDENCE_TOOL_NAME = 'gather_evidence'
export const DEFAULT_MAX_SPECIALIST_CHECKS = 3

export const specialistCheckRequestSchema = z.object({
  checkId: z.string().min(1),
  question: z.string().min(1).max(1_000),
  startingPaths: z.array(z.string().min(1)).max(12).default([]),
})
export type SpecialistCheckRequest = z.infer<typeof specialistCheckRequestSchema>

const specialistEvidenceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  observation: z.string().min(1),
})

export const specialistCheckResultSchema = z.object({
  status: z.enum(['supported', 'unsupported', 'inconclusive']),
  claim: z.string().default(''),
  evidence: z.array(specialistEvidenceSchema).default([]),
  causalChain: z.array(z.string()).default([]),
  counterEvidence: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
})
export type SpecialistCheckResult = z.infer<typeof specialistCheckResultSchema>

export interface SpecialistCheckDefinition {
  id: string
  title: string
  focus: 'security' | 'privacy' | 'performance' | 'correctness'
  model: string
  systemPrompt: string
  maxSteps: number
  maxContextTokens: number
  maxExplorerCalls: number
  maxRunsPerReview: number
}

export const HIGH_RISK_IMPACT_CHECK_ID = 'high-risk-impact'

export const SPECIALIST_CHECK_DEFINITIONS: readonly SpecialistCheckDefinition[] = [
  {
    id: HIGH_RISK_IMPACT_CHECK_ID,
    title: 'High-risk impact investigation',
    focus: 'security',
    model: 'claude-sonnet-5-5',
    systemPrompt: `You are a focused code-investigation specialist.

Investigate only the assigned high-risk question. Use the read-only repository tools to verify exact code. You may ask gather_evidence for bounded repository exploration, but verify important claims against source files yourself.

Return a concise evidence report followed by exactly one line in this format:
SPECIALIST_JSON: {"status":"supported|unsupported|inconclusive","claim":"...","evidence":[{"path":"...","line":1,"observation":"..."}],"causalChain":["..."],"counterEvidence":["..."],"missingEvidence":["..."],"confidence":0.0}

Report unsupported when the proposed risk is contradicted. Report inconclusive when required evidence is unavailable. Do not invent a finding.`,
    maxSteps: 6,
    maxContextTokens: 16_000,
    maxExplorerCalls: 4,
    maxRunsPerReview: 3,
  },
]

export function specialistCheckDefinition(id: string): SpecialistCheckDefinition | null {
  return SPECIALIST_CHECK_DEFINITIONS.find((definition) => definition.id === id) ?? null
}

export interface SpecialistCheckBudget {
  tryReserve(
    request: SpecialistCheckRequest,
    definition: SpecialistCheckDefinition,
  ): { allowed: true } | { allowed: false; reason: string }
  remaining(): number
}

function requestFingerprint(request: SpecialistCheckRequest): string {
  const question = request.question.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
  const paths = [...request.startingPaths]
    .map((path) => path.trim())
    .sort()
    .join('\n')
  return `${request.checkId}\n${question}\n${paths}`
}

export function createSpecialistCheckBudget(
  maximum = DEFAULT_MAX_SPECIALIST_CHECKS,
): SpecialistCheckBudget {
  const limit = Math.max(0, Math.floor(maximum))
  let spent = 0
  const perCheck = new Map<string, number>()
  const seen = new Set<string>()
  return {
    tryReserve(request, definition): { allowed: true } | { allowed: false; reason: string } {
      if (spent >= limit) {
        return { allowed: false, reason: `Specialist-check limit reached (${String(limit)}).` }
      }
      const fingerprint = requestFingerprint(request)
      if (seen.has(fingerprint)) {
        return { allowed: false, reason: 'This specialist question was already investigated.' }
      }
      const checkRuns = perCheck.get(definition.id) ?? 0
      if (checkRuns >= definition.maxRunsPerReview) {
        return {
          allowed: false,
          reason: `Per-check limit reached for ${definition.id} (${String(definition.maxRunsPerReview)}).`,
        }
      }
      spent += 1
      perCheck.set(definition.id, checkRuns + 1)
      seen.add(fingerprint)
      return { allowed: true }
    },
    remaining: () => Math.max(0, limit - spent),
  }
}

const SPECIALIST_JSON_PREFIX = 'SPECIALIST_JSON:'

export function parseSpecialistCheckResult(raw: string): SpecialistCheckResult {
  const jsonLine = raw
    .trim()
    .split('\n')
    .toReversed()
    .find((line) => line.trim().startsWith(SPECIALIST_JSON_PREFIX))
  if (!jsonLine) return inconclusiveResult('The specialist did not return structured evidence.')
  try {
    return specialistCheckResultSchema.parse(
      JSON.parse(jsonLine.trim().slice(SPECIALIST_JSON_PREFIX.length).trim()) as unknown,
    )
  } catch {
    return inconclusiveResult('The specialist returned malformed structured evidence.')
  }
}

function inconclusiveResult(reason: string): SpecialistCheckResult {
  return {
    status: 'inconclusive',
    claim: '',
    evidence: [],
    causalChain: [],
    counterEvidence: [],
    missingEvidence: [reason],
    confidence: 0,
  }
}

export function buildSpecialistTask(request: SpecialistCheckRequest): string {
  const paths = request.startingPaths.length
    ? `\nStarting paths:\n${request.startingPaths.map((path) => `- ${path}`).join('\n')}`
    : ''
  return `Focused question: ${request.question}${paths}\n\nGather and verify evidence for this question only, then return SPECIALIST_JSON.`
}
