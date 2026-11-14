import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { $, browser, expect } from '@wdio/globals'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import { parseDecisionLog } from '../../src/shared/threads/decision-log.ts'
import type { Thread } from '@shared/types'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { readFixtureJsonObject } from './helpers/fixture-json.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForTranscriptScrollSettled } from './helpers/scroll-to-bottom.ts'

const projectId = 'e2e-mobile-control'
const otherProjectId = 'e2e-mobile-control-other'
const token = randomBytes(32).toString('hex')
const readToken = randomBytes(32).toString('hex')
const addresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter(
    (entry) =>
      entry.family === 'IPv4' &&
      !entry.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  )
  .map((entry) => entry.address)
let origin = ''

async function availableAddress(): Promise<string | undefined> {
  // A daily Copse may already own the stable port on one interface. Probe only
  // availability; never stop it or send test actions to an unrelated profile.
  for (const address of addresses) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => {
        resolve(false)
      })
      probe.listen(42773, address, () => {
        probe.close(() => {
          resolve(true)
        })
      })
    })
    if (available) return address
  }
  return undefined
}

const root = join(copseDataRoot(), 'lan')
const responseSchema = z.object({
  id: z.uuid().optional(),
  code: z.string().optional(),
  state: z.string().optional(),
  token: z.string().optional(),
  access: z.enum(['read', 'control']).optional(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  ok: z.boolean().optional(),
  queued: z.boolean().optional(),
  error: z.string().optional(),
  runId: z.string().nullable().optional(),
  decisions: z.array(z.object({ id: z.string(), kind: z.string() })).optional(),
  plan: z
    .object({
      planId: z.string(),
      title: z.string(),
      status: z.enum(['draft', 'approved', 'superseded']),
      revision: z.number().int().positive(),
      contentHash: z.string(),
      authorityHash: z.string(),
      body: z.string(),
    })
    .nullable()
    .optional(),
})

function request(path: string, body?: object, bearer = token): z.infer<typeof responseSchema> {
  const args = [
    '--silent',
    '--show-error',
    '--noproxy',
    '*',
    '--max-time',
    '70',
    '--cacert',
    join(root, 'ca.crt'),
    '-H',
    `Authorization: Bearer ${bearer}`,
    '-H',
    `Origin: ${origin}`,
  ]
  if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-')
  const output = execFileSync('/usr/bin/curl', [...args, `${origin}${path}`], {
    encoding: 'utf8',
    ...(body ? { input: JSON.stringify(body) } : {}),
  })
  const parsed = safeJsonParse(output, decodeWithSchema(responseSchema))
  assert.ok(parsed, 'API returned valid JSON')
  return parsed
}

function action(sessionId: string, payload: object): Record<string, unknown> {
  return { sessionId, issuedAt: Date.now(), requestId: randomUUID(), projectId, ...payload }
}

function persistedProviderHistory(threadId: string): string {
  const stored = readFixtureJsonObject(
    join(copseDataRoot(), 'workspace', projectId, threadId, 'agent-history.json'),
  )
  const messages = stored['messages']
  assert.ok(Array.isArray(messages), 'provider history persisted a message array')
  return JSON.stringify(messages)
}

/** Whether the desktop transcript is scrolled to its live end. */
function transcriptAtBottom(): Promise<boolean> {
  return browser.execute(() => {
    const list = document.querySelector('.messages-list')
    return list !== null && list.scrollHeight - list.clientHeight - list.scrollTop <= 1
  })
}

describe('Mobile Companion control over verified local HTTPS', function () {
  this.timeout(180_000)
  before(async () => {
    const address = await availableAddress()
    assert.ok(
      address,
      'The LAN runtime eval requires an unused private IPv4 interface on port 42773',
    )
    origin = `https://${address}:42773`
    resetUserData()
    const workspaceRoot = seedStableWorkspace()
    seedEmptyProject(workspaceRoot, projectId, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      autoRunSandboxCommands: false,
    })
    const otherRoot = join(workspaceRoot, 'other-mobile-project')
    mkdirSync(otherRoot, { recursive: true })
    const seeded = readFixtureJsonObject(join(copseDataRoot(), 'config.json'))
    writeSeedConfig({
      ...seeded,
      projects: [
        { id: otherProjectId, path: otherRoot, name: 'other workspace' },
        { id: projectId, path: workspaceRoot, name: 'workspace' },
      ],
      activeProjectId: otherProjectId,
      [`threads:${otherProjectId}`]: [],
      [`threads:${projectId}`]: [],
    })
    // Fixture at the persisted-device boundary: no test-only product authority flag.
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileSync(join(root, 'service.json'), JSON.stringify({ enabled: true, address }), {
      mode: 0o600,
    })
    writeFileSync(
      join(root, 'devices.json'),
      JSON.stringify([
        {
          id: randomUUID(),
          label: 'Runtime test phone',
          tokenHash: createHash('sha256').update(token).digest('hex'),
          createdAt: Date.now(),
          access: 'control',
        },
        {
          id: randomUUID(),
          label: 'Read only test phone',
          tokenHash: createHash('sha256').update(readToken).digest('hex'),
          createdAt: Date.now(),
          access: 'read',
        },
      ]),
      { mode: 0o600 },
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    assert.equal(
      await browser.execute(() =>
        document
          .querySelector('.project-row.active')
          ?.closest('.project-entry')
          ?.getAttribute('data-project-id'),
      ),
      otherProjectId,
    )
  })
  after(() => {
    resetUserData()
  })

  it('starts once, queues a follow-up, answers the desktop prompt, and rejects stale actions', async () => {
    const first = 'Start this chat from my phone and ask which tests to run.'
    const followup = 'Report the final result to my phone.'
    const deletedFollowup = 'This deleted phone follow-up must never reach inference.'
    const scenario = await installMockScenario(
      {
        title: 'Phone runtime control',
        turns: [
          {
            user: first,
            responses: [
              {
                toolCalls: [
                  {
                    name: 'ask_user',
                    args: {
                      questions: [
                        { question: 'Which tests should I run?', options: ['Focused tests'] },
                      ],
                    },
                  },
                ],
              },
              {
                text: 'The focused tests passed.',
                expectToolResults: [{ name: 'ask_user', includes: 'Focused tests' }],
              },
            ],
          },
          {
            user: followup,
            responses: [{ text: 'Your phone started this chat and queued this follow-up.' }],
          },
        ],
      },
      null,
    )
    let sessionId = ''
    await browser.waitUntil(
      () => {
        try {
          sessionId = request('/api/activity').sessionId ?? ''
          return Boolean(sessionId)
        } catch {
          return false
        }
      },
      { timeout: 30_000, interval: 500 },
    )
    const start = action(sessionId, { action: 'message', threadId: null, text: first })
    assert.match(request('/api/action', start, readToken).error ?? '', /Enable control/)
    const started = request('/api/action', start)
    assert.equal(started.ok, true, started.error ?? 'Mobile message start failed')
    assert.ok(started.threadId)
    assert.equal(
      await browser.execute(() =>
        document
          .querySelector('.project-row.active')
          ?.closest('.project-entry')
          ?.getAttribute('data-project-id'),
      ),
      projectId,
      'new phone chat switched projects and reused Main reserved identity',
    )
    const threadId = started.threadId
    assert.deepEqual(
      request('/api/action', start),
      started,
      'duplicate delivery returns the same chat',
    )
    await $('#ask-user-dialog').waitForDisplayed({ timeout: 30_000 })
    const waiting = request(`/api/thread/${projectId}/${threadId}`)
    const question = waiting.decisions?.find((decision) => decision.kind === 'question')
    assert.ok(question)
    assert.ok(waiting.runId)
    await browser.execute((text) => {
      const stop = window.api.mobile.onChat((command) => {
        if (command.text !== text) return
        sessionStorage.setItem('e2e-deleted-mobile-grant', command.id)
        sessionStorage.setItem('e2e-deleted-mobile-message', command.messageId)
        stop()
      })
    }, deletedFollowup)
    const toDelete = request(
      '/api/action',
      action(sessionId, { action: 'message', threadId, text: deletedFollowup }),
    )
    assert.equal(toDelete.queued, true, toDelete.error ?? 'Mobile message queue failed')
    await expect($('.footer-queue')).toHaveText('1 queued')
    await browser.waitUntil(
      async () =>
        browser.execute(
          async ({ pid, tid, text }) => {
            const thread = (await window.api.threads.loadProject(pid)).find(
              (candidate) => candidate.id === tid,
            )
            return thread?.pendingMessages?.some((item) => item.payload.content === text) ?? false
          },
          { pid: projectId, tid: threadId, text: deletedFollowup },
        ),
      { timeout: 10_000 },
    )
    const deletedAdmission = await browser.execute(
      async ({ pid, tid, text }) => {
        const grant = sessionStorage.getItem('e2e-deleted-mobile-grant')
        const messageId = sessionStorage.getItem('e2e-deleted-mobile-message')
        if (!grant || !messageId) throw new Error('Phone command identities were not captured')
        const message = (await window.api.threads.loadMessages(pid, tid)).find(
          (candidate) => candidate.id === messageId && candidate.role === 'user',
        )
        if (!message || message.content !== text)
          throw new Error('Queued phone display was not durably persisted')
        return {
          grant,
          messageId,
          display: {
            messageId,
            snapshot: {
              content: message.content,
              ...(message.attachments !== undefined
                ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
                : {}),
            },
          },
        }
      },
      { pid: projectId, tid: threadId, text: deletedFollowup },
    )
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('.queued-delete')
      if (!button) throw new Error('Queued phone message has no delete control')
      button.click()
    })
    await browser.waitUntil(
      async () => (await $('.conversation-queued').getProperty('hidden')) === true,
      { timeout: 5_000 },
    )

    const queued = request(
      '/api/action',
      action(sessionId, { action: 'message', threadId, text: followup }),
    )
    assert.equal(queued.queued, true, queued.error ?? 'Mobile message queue failed')
    await expect($('.footer-queue')).toHaveText('1 queued')
    // Completion of the phone submission itself re-enables the composer;
    // the stable workspace provides no incidental checkout/status update.
    await $('.submit-btn').waitForEnabled()
    await saveAppScreenshot('mobile-controls-queued-desktop.png')
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'answer',
          threadId,
          decisionId: question.id,
          answers: ['Focused tests'],
        }),
      ).ok,
      true,
    )
    await $('#ask-user-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    assert.match(
      request(
        '/api/action',
        action(sessionId, {
          action: 'answer',
          threadId,
          decisionId: question.id,
          answers: ['Other'],
        }),
      ).error ?? '',
      /already changed/,
    )
    await waitForAgentIdle(60_000)
    await expectAssistantReply('Your phone started this chat and queued this follow-up.')
    await scenario.assertComplete()
    // The follow-up was admitted while the first run was still waiting. Its
    // provider request and final checkpoint must retain the answer/tool result
    // and assistant completion appended after admission, not replace the
    // sidecar with the earlier frozen prefix.
    const queuedHistory = persistedProviderHistory(threadId)
    assert.match(queuedHistory, /Focused tests/)
    assert.match(queuedHistory, /The focused tests passed\./)
    assert.match(queuedHistory, /Your phone started this chat and queued this follow-up\./)
    // Replay the original otherwise-valid display only after every legitimate
    // turn is idle. This isolates durable retirement/revocation from the
    // dispatcher's busy guard and from display-schema rejection.
    const replay = await browser.execute(
      async ({ pid, tid, text, admission }) => {
        const result = await window.api.agent.run(
          pid,
          tid,
          JSON.stringify({ content: text }),
          undefined,
          admission.display,
          admission.grant,
        )
        const messages = await window.api.threads.loadMessages(pid, tid)
        const thread = (await window.api.threads.loadProject(pid)).find(
          (candidate) => candidate.id === tid,
        )
        return {
          result,
          hasMessage: messages.some(
            (message) => message.id === admission.messageId || message.content === text,
          ),
          hasPending:
            thread?.pendingMessages?.some(
              (item) => item.messageId === admission.messageId || item.payload.content === text,
            ) ?? false,
        }
      },
      { pid: projectId, tid: threadId, text: deletedFollowup, admission: deletedAdmission },
    )
    assert.deepEqual(replay, { result: 'cancelled', hasMessage: false, hasPending: false })

    // Simulate renderer XSS racing a new phone chat: intercept Main's reserved
    // UUID and try the ordinary, canonical fork IPC before the phone grant is
    // consumed. Main must keep the new identity reserved through protected
    // dispatch, so the fork is rejected and the exact phone prompt still runs.
    await browser.execute(
      async ({ pid, sourceThreadId }) => {
        const source = (await window.api.threads.loadProject(pid)).find(
          (thread) => thread.id === sourceThreadId,
        )
        if (!source) throw new Error('Fork attack source thread is unavailable')
        source.messages = await window.api.threads.loadMessages(pid, sourceThreadId)
        let unsubscribe = (): void => {}
        unsubscribe = window.api.mobile.onChat((command) => {
          if (!command.createThread) return
          unsubscribe()
          const messages = source.messages.map((message) => {
            const copied = structuredClone(message)
            copied.id = crypto.randomUUID()
            delete copied.hookCards
            delete copied.review
            delete copied.reviewReport
            return copied
          })
          const now = Date.now()
          const target: Thread = {
            id: command.threadId,
            title: `${source.title} (fork)`,
            status: 'idle',
            messages,
            usage: { inputTokens: 0, outputTokens: 0 },
            ...(source.model !== undefined ? { model: source.model } : {}),
            ...(source.todos !== undefined
              ? { todos: source.todos.map((todo) => ({ ...todo })) }
              : {}),
            ...(source.workingBrief !== undefined ? { workingBrief: source.workingBrief } : {}),
            ...(source.worktree === undefined && source.gitBranch !== undefined
              ? { gitBranch: source.gitBranch }
              : {}),
            createdAt: now,
            updatedAt: now,
          }
          void window.api.threads
            .fork(pid, sourceThreadId, target)
            .catch((error: unknown) =>
              window.__copseE2e?.pushErrorToast(`Fork attack failed: ${String(error)}`),
            )
        })
      },
      { pid: projectId, sourceThreadId: threadId },
    )
    const forgedPrompt = 'Run this phone prompt with the renderer-selected fork context.'
    const attackScenario = await installMockScenario(
      {
        title: 'Reserved phone target',
        turns: [
          {
            user: forgedPrompt,
            responses: [{ text: 'The phone target ignored the renderer fork.' }],
          },
        ],
      },
      null,
    )
    const attacked = request(
      '/api/action',
      action(sessionId, { action: 'message', threadId: null, text: forgedPrompt }),
    )
    assert.equal(attacked.ok, true, attacked.error ?? 'Fork-race phone message was not admitted')
    assert.ok(attacked.threadId)
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The phone target ignored the renderer fork.')
    await attackScenario.assertComplete()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.__copseE2e?.getErrorToasts() ?? [])).some((message) =>
          message.startsWith('Fork attack failed:'),
        ),
      { timeout: 10_000, timeoutMsg: 'Renderer fork attempt was not rejected' },
    )
    const attackedHistory = persistedProviderHistory(attacked.threadId)
    assert.match(attackedHistory, /renderer-selected fork context/)
    assert.match(attackedHistory, /phone target ignored the renderer fork/i)
    assert.doesNotMatch(attackedHistory, /Focused tests/)

    const initialPlanBody =
      '# Goal\n\nKeep planned phone sends working safely.\n\n# Constraints\n\nUse only phone-reviewed plan authority.\n\n# Scope\n\nMobile prompt admission.\n\n# Definition of done\n\n- The exact reviewed plan reaches inference.'
    const revisedPlanBody =
      '# Goal\n\nUse only the exact plan revision shown on the phone.\n\n# Constraints\n\nReject stale phone reviews.\n\n# Scope\n\nMobile prompt admission.\n\n# Definition of done\n\n- A stale revision cannot start inference.'
    const initialPlan = await browser.execute(
      ({ pid, tid, body }) =>
        window.api.plans.change(pid, tid, {
          action: 'create',
          title: 'Phone-reviewed plan',
          body,
        }),
      { pid: projectId, tid: threadId, body: initialPlanBody },
    )
    assert.ok(initialPlan)
    const phoneView = request(`/api/thread/${projectId}/${threadId}`)
    assert.equal(phoneView.plan?.body, initialPlanBody)
    await browser.execute(
      ({ pid, tid, planId, revision }) =>
        window.api.plans.change(pid, tid, {
          action: 'comment',
          planId,
          revision,
          body: 'Keep this additional planning constraint.',
          anchor: { start: 0, end: 6 },
        }),
      {
        pid: projectId,
        tid: threadId,
        planId: initialPlan.meta.planId,
        revision: initialPlan.meta.currentRevision,
      },
    )
    assert.ok(phoneView.plan)
    assert.match(
      request(
        '/api/action',
        action(sessionId, {
          action: 'message',
          threadId,
          text: 'Do not admit a plan comment I have not reviewed.',
          planReview: {
            planId: phoneView.plan.planId,
            revision: phoneView.plan.revision,
            contentHash: phoneView.plan.contentHash,
            authorityHash: phoneView.plan.authorityHash,
          },
        }),
      ).error ?? '',
      /plan changed/i,
    )
    const commentedView = request(`/api/thread/${projectId}/${threadId}`).plan
    assert.ok(commentedView)
    assert.equal(commentedView.revision, phoneView.plan.revision)
    assert.equal(commentedView.contentHash, phoneView.plan.contentHash)
    assert.notEqual(commentedView.authorityHash, phoneView.plan.authorityHash)
    const revisedPlan = await browser.execute(
      ({ pid, tid, planId, revision, body }) =>
        window.api.plans.change(pid, tid, {
          action: 'revise',
          planId,
          revision,
          title: 'Phone-reviewed plan',
          body,
        }),
      {
        pid: projectId,
        tid: threadId,
        planId: initialPlan.meta.planId,
        revision: initialPlan.meta.currentRevision,
        body: revisedPlanBody,
      },
    )
    assert.ok(revisedPlan)
    const plannedPrompt = 'Continue this planned thread from my phone.'
    assert.match(
      request(
        '/api/action',
        action(sessionId, {
          action: 'message',
          threadId,
          text: plannedPrompt,
          planReview: {
            planId: phoneView.plan.planId,
            revision: phoneView.plan.revision,
            contentHash: phoneView.plan.contentHash,
            authorityHash: phoneView.plan.authorityHash,
          },
        }),
      ).error ?? '',
      /plan changed/i,
    )
    const reviewed = request(`/api/thread/${projectId}/${threadId}`).plan
    assert.equal(reviewed?.body, revisedPlanBody)
    assert.ok(reviewed)
    const plannedScenario = await installMockScenario(
      {
        title: 'Phone-reviewed planned thread',
        turns: [
          {
            user: plannedPrompt,
            responses: [{ text: 'The exact phone-reviewed plan was retained.' }],
          },
        ],
      },
      threadId,
    )
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'message',
          threadId,
          text: plannedPrompt,
          planReview: {
            planId: reviewed.planId,
            revision: reviewed.revision,
            contentHash: reviewed.contentHash,
            authorityHash: reviewed.authorityHash,
          },
        }),
      ).ok,
      true,
    )
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The exact phone-reviewed plan was retained.')
    await plannedScenario.assertComplete()
    await browser.execute(
      ({ pid, tid, planId, revision }) =>
        window.api.plans.change(pid, tid, { action: 'abandon', planId, revision }),
      {
        pid: projectId,
        tid: threadId,
        planId: revisedPlan.meta.planId,
        revision: revisedPlan.meta.currentRevision,
      },
    )
    assert.match(
      request('/api/action', action(sessionId, { action: 'stop', threadId, runId: waiting.runId }))
        .error ?? '',
      /already changed/,
    )
    await saveAppScreenshot('mobile-controls-finished-desktop.png')

    const approvalPrompt = 'Check whether reading the Copse profile is allowed.'
    const approvalScenario = await installMockScenario({
      title: 'Phone approval',
      turns: [
        {
          user: approvalPrompt,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: 'ls -la ~/.copse' } }] },
            {
              text: 'The phone declined the profile read.',
              expectToolResults: [{ name: 'run_shell' }],
            },
          ],
        },
      ],
    })
    assert.equal(
      request(
        '/api/action',
        action(sessionId, { action: 'message', threadId, text: approvalPrompt }),
      ).ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ timeout: 30_000 })
    const approval = request(`/api/thread/${projectId}/${threadId}`).decisions?.find(
      (decision) => decision.kind === 'approval',
    )
    assert.ok(approval)
    assert.match(
      request(
        '/api/action',
        action(sessionId, {
          action: 'approval',
          threadId,
          decisionId: approval.id,
          approved: true,
          remember: true,
        }),
      ).error ?? '',
      /Invalid action/,
    )
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'approval',
          threadId,
          decisionId: approval.id,
          approved: false,
        }),
      ).ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The phone declined the profile read.')
    await approvalScenario.assertComplete()

    const allowPrompt = 'Run the harmless command I approve from my phone.'
    const allowScenario = await installMockScenario({
      title: 'Approve once from phone',
      turns: [
        {
          user: allowPrompt,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: "printf 'phone-approved'" } }] },
            {
              text: 'The approved command completed.',
              expectToolResults: [{ name: 'run_shell', includes: 'phone-approved' }],
            },
          ],
        },
      ],
    })
    assert.equal(
      request('/api/action', action(sessionId, { action: 'message', threadId, text: allowPrompt }))
        .ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ timeout: 30_000 })
    const once = request(`/api/thread/${projectId}/${threadId}`).decisions?.find(
      (decision) => decision.kind === 'approval',
    )
    assert.ok(once)
    assert.equal(
      request(
        '/api/action',
        action(sessionId, { action: 'approval', threadId, decisionId: once.id, approved: true }),
      ).ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The approved command completed.')
    await allowScenario.assertComplete()
    const decisions = parseDecisionLog(
      readFileSync(join(copseDataRoot(), 'workspace', projectId, threadId, 'events.jsonl'), 'utf8'),
    )
    const phoneApprovals = decisions.filter(
      (decision) => decision.actor === 'mobile-device' && decision.kind === 'shell',
    )
    assert.deepEqual(
      phoneApprovals.map((decision) => decision.verdict),
      ['denied', 'approved'],
    )
    assert.ok(
      phoneApprovals.every(
        (decision) =>
          decision.remembered === false && decision.source?.includes('Runtime test phone'),
      ),
    )

    const stopScenario = await installMockScenario({
      title: 'Stop from phone',
      turns: [
        {
          user: 'Wait for my phone to stop this run.',
          allowAbort: true,
          responses: [{ waitFor: 'phone-stop', text: 'This must be interrupted.' }],
        },
      ],
    })
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'message',
          threadId,
          text: 'Wait for my phone to stop this run.',
        }),
      ).ok,
      true,
    )
    await stopScenario.waitForHold('phone-stop')
    const running = request(`/api/thread/${projectId}/${threadId}`)
    assert.ok(running.runId)
    assert.notEqual(running.runId, waiting.runId)
    assert.match(
      request('/api/action', action(sessionId, { action: 'stop', threadId, runId: waiting.runId }))
        .error ?? '',
      /already changed/,
    )
    assert.equal(
      request('/api/action', action(sessionId, { action: 'stop', threadId, runId: running.runId }))
        .ok,
      true,
    )
    await waitForAgentIdle(30_000)
    await stopScenario.assertComplete()
    // A phone Stop must leave the pinned desktop transcript at its live end.
    // Check that before the capture below re-scrolls, or it would mask a Stop
    // that drops the reader off the bottom.
    await browser.waitUntil(transcriptAtBottom, {
      timeout: 5_000,
      timeoutMsg: 'Stop left the pinned desktop transcript off the bottom',
    })
    await saveAppScreenshot('mobile-controls-stopped-desktop.png', undefined, async () => {
      // Stopping removes activity UI; frame the settled end after the capture resize.
      await browser.execute(() => {
        const list = document.querySelector('.messages-list')
        if (!(list instanceof HTMLElement)) throw new Error('Transcript missing')
        list.scrollTop = list.scrollHeight
      })
      await waitForTranscriptScrollSettled(false)
    })
    const beforeReload = persistedProviderHistory(threadId)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    assert.equal(persistedProviderHistory(threadId), beforeReload)
    assert.match(beforeReload, /The focused tests passed\./)
  })

  it('pairs through shared auth, retains phone credentials on restart, revokes them and cancels pending consent on stop', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="experimental"]').click()
    let enabled = $('input[name="mobileCompanionEnabled"]')
    await enabled.scrollIntoView({ block: 'center' })
    const pairing = request('/api/pair/request', { label: 'Shared auth phone' })
    const pairingId = pairing.id
    assert.ok(pairingId)
    assert.ok(pairing.code)
    let banner = $('.mobile-companion-pairing-banner')
    await banner.waitForDisplayed()
    assert.equal(await banner.$('.mobile-companion-pairing-code').getText(), pairing.code)
    assert.equal(await banner.$('button=Allow control').isEnabled(), false)
    await saveElementScreenshot('.mobile-companion-pairing-banner', 'mobile-auth-pairing.png', {
      beforeCapture: async () => {
        await browser.execute(() => {
          const code = document.querySelector('.mobile-companion-pairing-code')
          if (code) code.textContent = '123456'
        })
      },
    })
    await banner.$('button=Read only').click()
    await banner.waitForDisplayed({ reverse: true })
    let pairedToken = ''
    await browser.waitUntil(() => {
      const result = request(`/api/pair/result?id=${pairingId}`)
      pairedToken = result.token ?? ''
      return result.state === 'approved' && Boolean(pairedToken)
    })
    assert.match(request(`/api/pair/result?id=${pairingId}`).error ?? '', /expired/)
    assert.equal(request('/api/activity', undefined, pairedToken).access, 'read')
    assert.match(request('/api/action', {}, pairedToken).error ?? '', /Enable control/)
    // The real service publishes the newly issued credential after durable storage.
    await expect($('.mobile-companion-device-list')).toHaveText(
      expect.stringContaining('Shared auth phone'),
    )
    await browser.reloadSession()
    enabled = $('input[name="mobileCompanionEnabled"]')
    banner = $('.mobile-companion-pairing-banner')
    await $('.prompt-input').waitForExist({ timeout: 30000 })
    await browser.waitUntil(
      () => {
        try {
          return request('/api/activity', undefined, pairedToken).access === 'read'
        } catch {
          return false
        }
      },
      { timeout: 30000 },
    )
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="experimental"]').click()
    await enabled.scrollIntoView({ block: 'center' })
    // Select by visible label, then operate the real device row's revoke control.
    const label = $('strong=Shared auth phone')
    await label.waitForDisplayed()
    await label.parentElement().parentElement().$('.mobile-companion-device-revoke').click()
    await browser.waitUntil(() => Boolean(request('/api/activity', undefined, pairedToken).error))
    assert.match(request('/api/activity', undefined, pairedToken).error ?? '', /Pair this phone/)
    const pending = request('/api/pair/request', { label: 'Cancelled auth phone' })
    assert.ok(pending.id)
    await banner.waitForDisplayed()
    await enabled.click()
    await banner.waitForDisplayed({ reverse: true })
    assert.equal(await enabled.isSelected(), false)
    await saveElementScreenshot(
      'fieldset:has(input[name="mobileCompanionEnabled"])',
      'mobile-auth-pairing-stopped.png',
      {
        beforeCapture: async () => {
          await browser.execute(() => {
            const select = document.querySelector<HTMLSelectElement>(
              'select[name="mobileCompanionAddress"]',
            )
            const option = select?.selectedOptions.item(0)
            if (option) option.textContent = 'Test network — 192.168.1.41'
          })
        },
      },
    )
    await $('select[name="mobileCompanionAddress"]').selectByAttribute(
      'value',
      new URL(origin).hostname,
    )
    await enabled.click()
    await browser.waitUntil(
      () => {
        try {
          return Boolean(request('/api/activity').sessionId)
        } catch {
          return false
        }
      },
      { timeout: 30000 },
    )
    assert.match(request(`/api/pair/result?id=${pending.id}`).error ?? '', /expired/)
    assert.equal(await label.isExisting(), false)
    assert.equal(
      (await $('.mobile-companion-device-list').getText()).includes('Cancelled auth phone'),
      false,
    )
  })
})
