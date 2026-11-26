import type { AgentProfile } from '@shared/agent-profiles.ts'
import type { PickerValueGroup } from './model-picker.ts'

/**
 * Sentinel id for the named-profile row in the composer's model picker. Like
 * the effort row it is Copse's own, applied to the chat, so the footer picker
 * routes it to the thread rather than to an ACP agent's option store.
 */
export const PROFILE_GROUP_ID = '__agent_profile__'

/** The "no profile" choice, stored on the thread as no value at all. */
const NONE_VALUE = ''

/**
 * The saved profiles as a picker row, listed above the effort row because a
 * profile sets the model and effort itself. `null` when there are none, so the
 * picker shows no row with nothing behind it. A thread whose profile was
 * deleted reads as having none.
 */
export function profileValueGroup(
  profiles: readonly AgentProfile[],
  currentId: string | undefined,
  modelLabel: (model: string) => string,
): PickerValueGroup | null {
  if (profiles.length === 0) return null
  const current = profiles.find((profile) => profile.id === currentId)
  return {
    id: PROFILE_GROUP_ID,
    label: 'Profile',
    currentValue: current?.id ?? NONE_VALUE,
    choices: [
      { value: NONE_VALUE, label: 'None', description: 'No profile instructions' },
      // Say which model a pick moves the chat to, before its instructions.
      ...profiles.map((profile) => ({
        value: profile.id,
        label: profile.name,
        description: [
          profile.model ? modelLabel(profile.model) : 'Keeps the chat’s model',
          ...(profile.instructions?.trim() ? [oneLine(profile.instructions, 80)] : []),
        ].join(' · '),
      })),
    ],
  }
}

/** The thread-facing value for a pick: `undefined` clears the profile. */
export function profileIdFromGroupValue(value: string): string | undefined {
  return value === NONE_VALUE ? undefined : value
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
