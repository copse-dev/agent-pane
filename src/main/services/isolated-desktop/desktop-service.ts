import { recoverIsolatedDesktops } from './desktop-recovery.ts'
import { randomUUID } from 'node:crypto'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import { DesktopSession, type DesktopInput, type DesktopTransport } from './desktop-session.ts'
import { AppleDesktopTransport } from './apple-desktop-transport.ts'
import { resolveContainerProvider } from '../providers/container-provider.ts'
import { requestApproval } from '../approval.ts'
import { resolveToolPermission } from '../security/tool-permissions.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { isIsolatedDesktopGuest } from './guest-provider.ts'

const sessions = new Map<string, DesktopSession>()
const ownerKey = (owner: ThreadExecutionOwner): string =>
  JSON.stringify([owner.projectId, owner.threadId])

/**
 * Start a thread-owned desktop. `signal` cancels only consent and startup: once
 * this returns, the grant outlives the call and the turn that made it, so a
 * controller may end its turn while the guest works and resume control later.
 * Only stop, the user's Stop, thread cleanup, blocking the tool, the 15-minute
 * expiry, guest failure and shutdown revoke it.
 */
export async function startIsolatedDesktop(
  owner: ThreadExecutionOwner,
  model: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  if (
    isIsolatedDesktopGuest() ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    isActiveSshWorkspace()
  )
    throw new Error(
      'An isolated Copse desktop requires a local Apple silicon Mac; no host or Docker fallback is available',
    )
  await recoverIsolatedDesktops()
  signal.throwIfAborted()
  const key = ownerKey(owner)
  if (sessions.has(key))
    throw new Error('Stop this thread’s existing isolated desktop before starting another')
  if (sessions.size >= 2) throw new Error('At most two isolated desktops may run at once')
  // Resolve once before consent; the guest cannot select credentials, endpoints or a different model.
  const plan = await resolveContainerProvider(model, { threadId: owner.threadId })
  if (plan.mode !== 'host-inference')
    throw new Error(
      'Choose an API or supported ChatGPT model; agent sign-ins are not copied into the desktop',
    )
  const inference = plan.hostInference
  const { approved } = await requestApproval(
    {
      title: 'Allow isolated Copse control?',
      type: 'shell',
      body:
        'Model: ' +
        model +
        '\nBudget: 100,000 tokens / 15 minutes; normal model charges.\n' +
        'Control Linux Copse in a disposable Apple container VM.\n' +
        'Agent can click, type, screenshot and approve child dialogs.\n' +
        'No host folders, credentials, display or network are shared.\n' +
        'The VM stays up between turns. Stop or archiving the thread deletes it.',
      subject: 'isolated_copse',
      scope: 'external',
      allowRemember: false,
    },
    signal,
  )
  signal.throwIfAborted()
  if (!approved) throw new Error('Isolated desktop control was not approved')
  if (resolveToolPermission('isolated_copse')?.policy === 'block')
    throw new Error('Isolated desktop control is blocked')
  // Consent can wait while another request starts; admission is rechecked after it settles.
  const name = 'copse-desktop-probe-' + randomUUID()
  const session = await admitIsolatedDesktop(
    owner,
    new AppleDesktopTransport(name, (maximum) => inference(maximum, name)),
    signal,
  )
  return (
    'Started isolated desktop ' +
    session.id +
    ' (' +
    session.title +
    '). All input is confined to its VM. Model: ' +
    model +
    '. It stays up after this turn ends, until stop, the user’s Stop or 15 minutes; ' +
    'stop it when you are done.'
  )
}

/**
 * Admit and boot one approved session for `owner`. `signal` is the starting
 * call's: an abandoned start must not finish creating authority after its
 * caller left, but once startup succeeds nothing about that call, its HTTP
 * response or its turn ends the grant.
 */
export async function admitIsolatedDesktop(
  owner: ThreadExecutionOwner,
  transport: DesktopTransport,
  signal: AbortSignal,
): Promise<{ id: string; title: string }> {
  const key = ownerKey(owner)
  if (sessions.has(key) || sessions.size >= 2)
    throw new Error('An isolated desktop started while approval was pending')
  const session = new DesktopSession(
    owner,
    transport,
    (error) => {
      console.error('[isolated-desktop] VM cleanup failed; retry Stop:', error)
    },
    () => {
      // Stop, expiry and transport failure also release admission, but only after deletion.
      if (sessions.get(key) === session) sessions.delete(key)
    },
  )
  sessions.set(key, session)
  const cancelStartup = (): void => {
    void session.stop().catch((error: unknown) => {
      console.error('[isolated-desktop] Cancelled startup cleanup failed:', error)
    })
  }
  signal.addEventListener('abort', cancelStartup, { once: true })
  try {
    signal.throwIfAborted()
    const title = await session.start()
    signal.throwIfAborted()
    return { id: session.id, title }
  } catch (error) {
    // Retain failed cleanup so Stop and shutdown can retry it.
    await session.stop()
    throw error
  } finally {
    signal.removeEventListener('abort', cancelStartup)
  }
}

export async function controlIsolatedDesktop(
  owner: ThreadExecutionOwner,
  request: DesktopInput,
): Promise<Buffer | undefined> {
  const key = ownerKey(owner)
  const session = sessions.get(key)
  if (!session) throw new Error('This thread has no isolated desktop; start one first')
  if (request.action !== 'stop' && resolveToolPermission('isolated_copse')?.policy === 'block') {
    await stopIsolatedDesktop(owner)
    throw new Error('Isolated desktop control is blocked')
  }
  if (request.action === 'stop') {
    await stopIsolatedDesktop(owner)
    return
  }
  return session.execute(owner, request)
}

/**
 * Whether `owner` holds a desktop, including one whose deletion failed and awaits
 * a retried stop. The grant outlives turns, so an idle thread can still hold one.
 */
export function hasIsolatedDesktop(owner: ThreadExecutionOwner): boolean {
  return sessions.has(ownerKey(owner))
}

export async function stopIsolatedDesktop(owner: ThreadExecutionOwner): Promise<void> {
  const key = ownerKey(owner)
  const session = sessions.get(key)
  if (!session) return
  await session.stop()
}

/**
 * The user's Stop for a thread revokes its desktop too, in whichever turn it
 * comes: the grant outlives the turn that started it, so the turn's own abort
 * cannot carry this.
 */
export async function stopIsolatedDesktopsForThread(threadId: string): Promise<void> {
  const owned = [...sessions.values()].filter((session) => session.owner.threadId === threadId)
  const results = await Promise.allSettled(owned.map((session) => session.stop()))
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length) throw new AggregateError(failures, 'Failed to delete isolated desktop VMs')
}

export async function stopAllIsolatedDesktops(): Promise<void> {
  const results = await Promise.allSettled(
    [...sessions.keys()].map(async (key) => {
      const session = sessions.get(key)
      if (!session) return
      await session.stop()
    }),
  )
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length) throw new AggregateError(failures, 'Failed to delete isolated desktop VMs')
}
