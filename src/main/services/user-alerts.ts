import type { RendererPromptTarget } from './renderer-prompt-target.ts'
import { getSetting } from './storage/settings.ts'

export type UserAlertKind = 'interaction' | 'thread-finished'

export interface UserAlertPreferences {
  interaction: boolean
  threadFinished: boolean
  systemNotification: boolean
  sound: boolean
  bounce: boolean
}

export interface UserAlertEffects {
  notification(title: string, body: string): void
  sound(): void
  bounce(kind: UserAlertKind): () => void
}

/**
 * Raise one alert. `threadId` names the thread the alert is about, when there
 * is one: clicking the system notification opens it, and a needs-input alert
 * counts it on the Dock/taskbar badge until the returned stop runs.
 *
 * `promptTarget` is the renderer the prompt was actually sent to, when a caller
 * routes prompts per request (`renderer-prompt-target.ts`). A prompt sent to a
 * pop-out lives only there, so a click must bring that window forward rather
 * than open the thread in the sender's own window, where the prompt is absent.
 */
export type UserAlertSender = (
  kind: UserAlertKind,
  body: string,
  threadId?: string,
  promptTarget?: RendererPromptTarget,
) => () => void

const noop = (): void => {}

export function readUserAlertPreferences(): UserAlertPreferences {
  return {
    interaction: getSetting<boolean>('alertOnInteraction', true),
    threadFinished: getSetting<boolean>('alertOnThreadFinished', true),
    systemNotification: getSetting<boolean>('alertSystemNotification', true),
    sound: getSetting<boolean>('alertSound', true),
    bounce: getSetting<boolean>('alertBounce', true),
  }
}

/** Apply the independently configurable channels for one alert event. */
export function dispatchUserAlert(
  preferences: UserAlertPreferences,
  kind: UserAlertKind,
  body: string,
  effects: UserAlertEffects,
): () => void {
  const eventEnabled = kind === 'interaction' ? preferences.interaction : preferences.threadFinished
  if (!eventEnabled) return noop

  const title = kind === 'interaction' ? 'Copse needs your input' : 'Thread finished'
  if (preferences.systemNotification) effects.notification(title, body)
  if (preferences.sound) effects.sound()
  return preferences.bounce ? effects.bounce(kind) : noop
}
