/**
 * The quit the updater starts when the user picks "Restart now".
 *
 * Electron's `quitAndInstall` closes every window before `before-quit`, so the
 * app has to know a quit is under way before calling it. Otherwise a window
 * with a turn running detaches instead of closing, the app never quits, and
 * the update waits for some later quit. Each flag here is one piece of that
 * knowledge (the window is quitting, the close needs no confirmation, the run
 * ends in an update relaunch). They are set only for this quit: if the updater
 * fails, each flag this quit set is cleared again, so a later quit the user
 * chooses is not taken for an update.
 */

export interface QuitFlag {
  isSet(): boolean
  set(): void
  clear(): void
}

export class InstallQuit {
  private readonly flags: readonly QuitFlag[]
  private setByThisQuit: QuitFlag[] = []

  constructor(flags: readonly QuitFlag[]) {
    this.flags = flags
  }

  /** Set the flags, then start the updater's quit. A throw undoes the flags. */
  start(quitAndInstall: () => void): void {
    this.setByThisQuit = this.flags.filter((flag) => !flag.isSet())
    for (const flag of this.setByThisQuit) flag.set()
    try {
      quitAndInstall()
    } catch (error) {
      this.abandon()
      throw error
    }
  }

  /** The updater failed after starting: clear the flags this quit set. */
  abandon(): void {
    for (const flag of this.setByThisQuit) flag.clear()
    this.setByThisQuit = []
  }
}
