import { isRecord } from '@shared/unknown-value.ts'
import { storageDelete, storageGet, storageSet } from './storage.ts'

// #4048 removed the Claude plan worth-it verdict and stopped writing the
// `planWindowHistory` ledger, but left the stored value in place. This removes
// it once, and only when it still has the shape the old collector wrote, so a
// key some other writer has since reused (or a hand edit) is never deleted.

const PLAN_WINDOW_HISTORY_KEY = 'planWindowHistory'
const CLEANUP_DONE_KEY = 'planWindowHistoryCleanupDone'

/**
 * The removed collector always persisted exactly `{ samples, completed }`:
 * samples carried a numeric `at` and string `provider`, completed windows a
 * string `windowId` and numeric `completedAt`. Anything else is left alone.
 */
function hasRetiredHistoryShape(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'completed' || keys[1] !== 'samples') return false
  const { samples, completed } = value
  if (!Array.isArray(samples) || !Array.isArray(completed)) return false
  const isSample = (entry: unknown): boolean =>
    isRecord(entry) && typeof entry['at'] === 'number' && typeof entry['provider'] === 'string'
  const isCompleted = (entry: unknown): boolean =>
    isRecord(entry) &&
    typeof entry['windowId'] === 'string' &&
    typeof entry['completedAt'] === 'number'
  return samples.every(isSample) && completed.every(isCompleted)
}

/**
 * Delete the orphaned plan-window history once per profile. The marker is
 * written whether or not anything was removed: a value that did not match the
 * old shape on the first pass is not ours to delete later either. A failure
 * leaves the marker unset so the next launch retries.
 */
export function removeOrphanedPlanWindowHistory(): void {
  if (storageGet(CLEANUP_DONE_KEY) === true) return
  try {
    if (hasRetiredHistoryShape(storageGet(PLAN_WINDOW_HISTORY_KEY))) {
      storageDelete(PLAN_WINDOW_HISTORY_KEY)
    }
    storageSet(CLEANUP_DONE_KEY, true)
  } catch (error) {
    console.warn('[storage] could not remove the retired plan window history:', error)
  }
}
