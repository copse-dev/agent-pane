import { summarizeClassifierUse, type ThreadClassifierUse } from '@shared/usage/classifier-use.ts'
import { readThreadDecisionLog } from './decision-log-store.ts'

/** What the classifiers did for one thread, read from its decision log. */
export async function getThreadClassifierUse(
  projectId: string,
  threadId: string,
): Promise<ThreadClassifierUse> {
  return summarizeClassifierUse(await readThreadDecisionLog(projectId, threadId))
}
