import type { IpcMainInvokeEvent } from 'electron'
import type { SkillsSourcesResult } from '@shared/types/skills.ts'
import { skillRootsSchema } from '../services/skills/skill-roots-schema.ts'
import { assertMainFrameSender, IpcValidationError } from './ipc-guards.ts'

interface SkillRootsDependencies {
  setSetting: (key: string, value: unknown) => Promise<void>
  initSkillsRegistry: () => Promise<void>
  listSkillSources: () => SkillsSourcesResult
}

/** Keep authorization ahead of both persistence and discovery. */
export function createSkillRootsHandler(
  win: Parameters<typeof assertMainFrameSender>[1],
  dependencies: SkillRootsDependencies,
): (
  event: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  value: unknown,
) => Promise<SkillsSourcesResult> {
  return async (event, value) => {
    assertMainFrameSender(event, win)
    const roots = skillRootsSchema.safeParse(value)
    if (!roots.success)
      throw new IpcValidationError(
        'Extra skill folders must be at most 64 absolute paths, one per line',
      )
    await dependencies.setSetting('skillPluginPaths', roots.data)
    await dependencies.initSkillsRegistry()
    return dependencies.listSkillSources()
  }
}
