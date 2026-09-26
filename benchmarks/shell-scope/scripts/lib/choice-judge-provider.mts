import { z } from 'zod'
import { evaluateAcpText, type AcpJudgeOptions } from './acp-text-judge.mts'
import { safeJsonParse, decodeWithSchema } from './safe-json.mts'
import {
  choiceResponseSchema,
  decodeChoice,
  failedChoice,
  type ChoicePayload,
  type ChoiceJudgment,
} from './choice-judge.mts'

export function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Endpoint must not contain credentials, query parameters, or a fragment')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Use HTTPS or loopback HTTP for model endpoints')
  return url.href
}
export interface HttpOptions {
  protocol: 'systemone' | 'chat'
  endpoint: string
  model: string
  apiKey?: string
  timeoutMs: number
}
export function systemOneChoice(
  text: string,
  labels: readonly string[],
  latencyMs: number,
): ChoiceJudgment {
  const envelope = safeJsonParse(
    text,
    decodeWithSchema(
      z.object({
        model: z.string().min(1),
        answers: z.object({
          resolution: z.object({
            type: z.literal('choice'),
            choice: z.string(),
            probabilities: z.record(z.string(), z.number()),
          }),
        }),
        usage: z.record(z.string(), z.number().nonnegative()).optional(),
      }),
    ),
  )
  if (!envelope) return failedChoice('Invalid System One judgment', false, latencyMs)
  const answer = envelope.answers.resolution
  const parsed = choiceResponseSchema(labels).safeParse({
    verdict: answer.choice,
    probabilities: answer.probabilities,
    model: envelope.model,
    usage: envelope.usage ?? null,
    error: null,
    fatal: false,
  })
  if (!parsed.success) return failedChoice('Invalid System One judgment', false, latencyMs)
  return { ...parsed.data, latencyMs }
}
export async function evaluateChoiceHttp(
  payload: ChoicePayload,
  prompt: string,
  options: HttpOptions,
  request: typeof fetch = fetch,
): Promise<ChoiceJudgment> {
  const endpoint = validateEndpoint(options.endpoint)
  const labels = Object.keys(payload.questions.resolution.criteria)
  const started = performance.now()
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (options.apiKey) headers['Authorization'] = 'Bearer ' + options.apiKey
    const body =
      options.protocol === 'systemone'
        ? { model: options.model, ...payload }
        : { model: options.model, messages: [{ role: 'user', content: prompt }], max_tokens: 128 }
    const response = await request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'error',
    })
    const elapsed = (): number => performance.now() - started
    if (!response.ok) return failedChoice('HTTP ' + String(response.status), true, elapsed())
    const bodyText = await response.text()
    if (bodyText.length > 65_536)
      return failedChoice('Response exceeded output limit', false, elapsed())
    if (options.protocol === 'systemone') return systemOneChoice(bodyText, labels, elapsed())
    const parsed = safeJsonParse(
      bodyText,
      decodeWithSchema(
        z.object({
          model: z.string().optional(),
          choices: z
            .array(
              z.object({ finish_reason: z.string(), message: z.object({ content: z.string() }) }),
            )
            .length(1),
          usage: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    )
    const choice = parsed?.choices[0]
    if (!parsed || !choice || choice.finish_reason !== 'stop')
      return failedChoice('Invalid or incomplete chat response', false, elapsed())
    const verdict = decodeChoice(choice.message.content, labels)
    if (!verdict) return failedChoice('Invalid chat judgment', false, elapsed())
    const usage = Object.fromEntries(
      Object.entries(parsed.usage ?? {}).flatMap(([key, value]) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[key, value]] : [],
      ),
    )
    return {
      verdict,
      probabilities: null,
      model: parsed.model ?? options.model,
      usage: Object.keys(usage).length ? usage : null,
      latencyMs: elapsed(),
      error: null,
      fatal: false,
      details: {
        modelEvidence: parsed.model ? 'Provider response' : 'Requested model; unconfirmed',
      },
    }
  } catch {
    return failedChoice(
      'Transport error or timeout; response body omitted',
      true,
      performance.now() - started,
    )
  }
}
export async function evaluateChoiceAcp(
  prompt: string,
  labels: readonly string[],
  options: AcpJudgeOptions,
): Promise<ChoiceJudgment> {
  const response = await evaluateAcpText(prompt, options)
  if (response.error)
    return { ...failedChoice(response.error, true, response.latencyMs), model: response.model }
  const verdict = decodeChoice(response.text, labels)
  return {
    verdict,
    probabilities: null,
    model: response.model,
    usage: response.usage,
    latencyMs: response.latencyMs,
    error: verdict ? null : 'Invalid ACP judgment',
    fatal: false,
    ...(response.acp
      ? {
          setupMs: response.acp.setupMs,
          ...(response.acp.promptMs === null ? {} : { promptMs: response.acp.promptMs }),
          details: {
            agentName: response.acp.agentName,
            agentVersion: response.acp.agentVersion,
            modelEvidence: response.acp.modelEvidence,
          },
        }
      : {}),
  }
}
