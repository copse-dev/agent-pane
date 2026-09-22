import { z } from 'zod'
import { isSafeCredentialBaseUrl } from '../credential-url.ts'
import type { ClassifierProfile, ClassifierQuestion, ClassifierRequest } from './types.ts'

const text = z.string().max(65_536)
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
    'Reserved identifier',
  )

// Preflight precedes Zod's recursive JSON parser: cycles/deep nesting must fail
// without overflowing the stack. This budget also bounds renderer IPC input.
function boundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  const visited = new WeakSet<object>()
  let nodes = 0
  let characters = 0
  while (pending.length) {
    const item = pending.pop()
    if (!item || ++nodes > 20_000 || item.depth > 32) return false
    const current = item.value
    if (typeof current === 'string') characters += current.length
    else if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false
    } else if (current !== null && typeof current === 'object') {
      if (visited.has(current)) return false
      visited.add(current)
      const prototype: unknown = Object.getPrototypeOf(current)
      if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null)
        return false
      for (const [key, child] of Object.entries(current)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false
        characters += key.length
        pending.push({ value: child, depth: item.depth + 1 })
      }
    } else if (current !== null && typeof current !== 'boolean') return false
    if (characters > 1_048_576 || pending.length > 20_000) return false
  }
  return true
}
const connection = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('http'),
      protocol: z.enum(['systemone', 'featherless']),
      baseUrl: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .refine((value) => {
          if (!isSafeCredentialBaseUrl(value)) return false
          const url = new URL(value)
          return !url.search && !url.hash
        }, 'Use HTTPS (or loopback HTTP), without credentials, query, or fragment'),
      auth: z.enum(['none', 'bearer']),
      apiKeyEnv: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
        .optional(),
    }),
    z.strictObject({
      type: z.literal('semif'),
      executable: z
        .string()
        .max(4096)
        .refine(
          (value) =>
            value === 'semif-score' ||
            /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]*[\\/]semif-score(?:\.exe)?$/.test(value),
          'Use semif-score or its absolute executable path',
        ),
      backend: z.enum(['torch', 'mlx', 'llamacpp']),
      revision: z.string().trim().min(1).max(512),
      mode: z.enum(['direct', 'serial', 'shared']),
      gguf: z.string().min(1).max(4096).optional(),
      device: z.enum(['auto', 'cuda', 'mps']).optional(),
      maxTokens: z.number().int().min(1).max(131_072).optional(),
    }),
  ])
  .transform((value): ClassifierProfile['connection'] => {
    if (value.type === 'http') {
      const { apiKeyEnv, ...required } = value
      return { ...required, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) }
    }
    const { gguf, device, maxTokens, ...required } = value
    return {
      ...required,
      ...(gguf === undefined ? {} : { gguf }),
      ...(device === undefined ? {} : { device }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  })

function absolutePath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value) && !/[\0\r\n]/.test(value)
}

export const classifierProfileSchema: z.ZodType<ClassifierProfile> = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]{1,53}$/),
    label: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(512),
    timeoutMs: z.number().int().min(100).max(600_000),
    connection,
  })
  .superRefine((value, context) => {
    if (value.connection.type !== 'semif') return
    if (
      !absolutePath(value.model) &&
      (!/^[0-9a-f]{40}$/.test(value.connection.revision) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value.model))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['connection', 'revision'],
        message:
          'Use an absolute local model path or a Hub model ID with its full 40-character commit revision',
      })
    }
    if (value.connection.backend === 'llamacpp') {
      if (!value.connection.gguf || !absolutePath(value.connection.gguf))
        context.addIssue({
          code: 'custom',
          path: ['connection', 'gguf'],
          message: 'llamacpp requires an absolute local GGUF file path',
        })
    } else if (value.connection.gguf !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['connection', 'gguf'],
        message: 'GGUF is supported only by the llamacpp backend',
      })
    }
  })

const question = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('choice'),
      instructions: text,
      options: z
        .record(identifier, text.nullable())
        .refine(
          (value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255,
          'Provide 2–255 choices',
        ),
    }),
    z.strictObject({
      type: z.literal('boolean'),
      instructions: text,
      criteria: z.strictObject({ true: text.optional(), false: text.optional() }).optional(),
    }),
    z.strictObject({
      type: z.literal('score'),
      instructions: text,
      levels: z.array(text).min(2).max(50),
    }),
  ])
  .transform((value): ClassifierQuestion => {
    if (value.type !== 'boolean') return value
    const { criteria, ...required } = value
    if (criteria === undefined) return required
    return {
      ...required,
      criteria: {
        ...(criteria.true === undefined ? {} : { true: criteria.true }),
        ...(criteria.false === undefined ? {} : { false: criteria.false }),
      },
    }
  })

export const classifierRequestSchema: z.ZodType<ClassifierRequest> = z.preprocess(
  (value) => (boundedJson(value) ? value : undefined),
  z.strictObject({
    state: z.union([z.string(), z.record(identifier, z.json()), z.array(z.json())]),
    questions: z
      .record(identifier, question)
      .refine(
        (value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 256,
        'Provide 1–256 questions',
      ),
  }),
)
