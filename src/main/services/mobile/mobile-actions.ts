import { z } from 'zod'
import { stopMobileRun } from '../agent-service.ts'
import { recordDecision } from '../security/decision-log-store.ts'
import { mobileProjects, mobileThread } from './mobile-activity.ts'
import { submitMobileChat } from './mobile-chat.ts'
import { mobileDecisions, mobileDecisionSource, type MobilePrincipal } from './mobile-decisions.ts'

const id = z.string().regex(/^[\w-]{1,128}$/)
const envelope = {
  requestId: z.uuid(),
  sessionId: z.uuid(),
  issuedAt: z.number().int().nonnegative(),
  projectId: id,
}
export const mobileActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...envelope,
    action: z.literal('approval'),
    threadId: id,
    decisionId: z.uuid(),
    approved: z.boolean(),
  }),
  z.strictObject({
    ...envelope,
    action: z.literal('answer'),
    threadId: id,
    decisionId: z.uuid(),
    answers: z.array(z.string().max(8000)).min(1).max(10),
  }),
  z.strictObject({ ...envelope, action: z.literal('stop'), threadId: id, runId: z.uuid() }),
  z.strictObject({
    ...envelope,
    action: z.literal('message'),
    threadId: id.nullable(),
    text: z.string().trim().min(1).max(32_000),
  }),
])
export type MobileAction = z.infer<typeof mobileActionSchema>
export interface MobileActionResult {
  status: number
  body: { error?: string; threadId?: string; queued?: boolean; ok?: boolean }
}

/** Exact allow-list; every addition must also update the boundary contract test. */
export const MOBILE_WRITE_DISPATCH = Object.freeze({
  approval: mobileDecisions.respond.bind(mobileDecisions),
  answer: mobileDecisions.respond.bind(mobileDecisions),
  stop: stopMobileRun,
  message: submitMobileChat,
})

export async function performMobileAction(
  action: MobileAction,
  device: MobilePrincipal,
  stillAuthorized: () => boolean,
): Promise<MobileActionResult> {
  const exists =
    action.threadId === null
      ? mobileProjects().some((project) => project.id === action.projectId)
      : await mobileThread(action.projectId, action.threadId)
  if (!exists) return { status: 404, body: { error: 'Project or thread unavailable.' } }
  if (!stillAuthorized())
    return { status: 403, body: { error: 'Phone control was disabled on the desktop.' } }
  if (action.action === 'message') {
    const result = await MOBILE_WRITE_DISPATCH.message({
      projectId: action.projectId,
      threadId: action.threadId,
      text: action.text,
    })
    if (!result.ok) return { status: 409, body: { error: result.error } }
    recordDecision({
      projectId: action.projectId,
      threadId: result.threadId,
      kind: 'mobile-chat',
      actor: 'mobile-device',
      verdict: 'approved',
      subject: result.queued ? 'Queued follow-up message' : 'Submitted chat message',
      source: mobileDecisionSource(device),
    })
    return { status: 200, body: result }
  }
  const accepted =
    action.action === 'stop'
      ? MOBILE_WRITE_DISPATCH.stop(action.threadId, action.runId)
      : MOBILE_WRITE_DISPATCH[action.action](
          action.projectId,
          action.threadId,
          action.decisionId,
          action.action === 'approval'
            ? { kind: 'approval', approved: action.approved }
            : { kind: 'question', answers: action.answers },
          device,
        )
  if (!accepted)
    return {
      status: 409,
      body: { error: 'This run or prompt has already changed. Refresh and try again.' },
    }
  if (action.action === 'stop')
    recordDecision({
      projectId: action.projectId,
      threadId: action.threadId,
      kind: 'mobile-stop',
      actor: 'mobile-device',
      verdict: 'approved',
      subject: 'Stopped run',
      source: mobileDecisionSource(device),
    })
  return { status: 200, body: { ok: true } }
}

/** Repeated network deliveries never submit a message twice; old sessions cannot replay on restart. */
export class MobileActionRequests {
  private readonly requests = new Map<
    string,
    { fingerprint: string; at: number; result: Promise<MobileActionResult> }
  >()
  readonly sessionId: string
  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  run(
    action: MobileAction,
    device: MobilePrincipal,
    execute: () => Promise<MobileActionResult>,
  ): Promise<MobileActionResult> {
    const now = Date.now()
    if (action.sessionId !== this.sessionId || Math.abs(now - action.issuedAt) > 120_000)
      return Promise.resolve({
        status: 409,
        body: { error: 'This action expired. Refresh and try again.' },
      })
    for (const [key, entry] of this.requests)
      if (now - entry.at > 240_000) this.requests.delete(key)
    const key = `${device.id}:${action.requestId}`
    const fingerprint = JSON.stringify(action)
    const existing = this.requests.get(key)
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({ status: 409, body: { error: 'Request ID already used.' } })
    if (this.requests.size >= 1000)
      return Promise.resolve({
        status: 429,
        body: { error: 'Too many actions. Wait a moment and try again.' },
      })
    const result = execute().catch(() => ({
      status: 500,
      body: { error: 'Action failed. Check the thread before trying again.' },
    }))
    this.requests.set(key, { fingerprint, at: now, result })
    return result
  }
}
