import { memberOf } from './member-of.ts'
import { RELEASE_CHANNELS, getReleaseChannel, type ReleaseChannel } from './release-channel.mts'

export const isReleaseChannel = memberOf(RELEASE_CHANNELS)

export interface UpdateChannelChoice {
  channel: ReleaseChannel
  /** True when nothing valid was saved: the caller remembers `channel`. */
  remember: boolean
}

/**
 * The update channel in effect: the one saved in Settings → About, or, before
 * anything is saved, the installed build's own. Remembering that first answer
 * keeps a beta tester on beta after a stable release reaches them through the
 * beta feed. Throws for a version neither channel supports.
 */
export function chosenUpdateChannel(saved: unknown, installedVersion: string): UpdateChannelChoice {
  if (typeof saved === 'string' && isReleaseChannel(saved)) {
    return { channel: saved, remember: false }
  }
  return { channel: getReleaseChannel(installedVersion), remember: true }
}
