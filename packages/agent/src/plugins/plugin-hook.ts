import { z } from 'zod'
import { HOOK_EVENT_NAMES } from '../hooks/canonical-events.ts'

/** A worker hook is declared independently of the existing command-hook dialects. */
export const zPluginHookRegistration = z.strictObject({
  id: z.string().min(1).max(128),
  event: z.enum(HOOK_EVENT_NAMES),
})

export const zPluginHookRegistrations = z
  .array(zPluginHookRegistration)
  .max(1_000)
  .refine((hooks) => new Set(hooks.map((hook) => hook.id)).size === hooks.length, {
    message: 'Plugin hook ids must be unique.',
  })

export type PluginHookRegistration = z.infer<typeof zPluginHookRegistration>

/** A worker may register exactly the hook ids/events selected in its manifest. */
export function validatePluginHookRegistrations(
  declared: readonly PluginHookRegistration[],
  registered: readonly PluginHookRegistration[],
): void {
  const expected = new Map(zPluginHookRegistrations.parse(declared).map((h) => [h.id, h.event]))
  const actual = zPluginHookRegistrations.parse(registered)
  if (expected.size !== actual.length || actual.some((h) => expected.get(h.id) !== h.event)) {
    throw new Error('Plugin registered hooks not declared by its runtime behavior.')
  }
}
