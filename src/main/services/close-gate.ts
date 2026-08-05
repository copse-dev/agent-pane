/**
 * The decision half of the "don't close while the agent is working" guard: who
 * may close, when to ask, and what to do with the answer. Kept free of Electron
 * so it can be exercised directly — the wiring (`ipcMain`, window events,
 * `app.quit()`) lives in `close-confirm.ts`.
 */

export interface CloseGateDeps {
  /** Ask whoever can answer whether the app may close. */
  requestConfirmation: () => Promise<boolean>
}

export interface CloseGate {
  /** True once a close has been approved; further closes pass straight through. */
  isApproved(): boolean
  /** Let closes through unasked — after a confirmation, or for a signal quit. */
  approve(): void
  /**
   * Gate one close attempt. Returns `true` when the caller must abandon this
   * attempt (the event was prevented and the question is being asked); `false`
   * when the close may proceed right now. `reissue` runs only if the user says
   * yes — the original close event is long gone by then, so the caller has to
   * start it again.
   */
  defer(event: { preventDefault: () => void }, reissue: () => void): boolean
}

export function createCloseGate(deps: CloseGateDeps): CloseGate {
  let approved = false
  let inFlight: Promise<boolean> | null = null

  // Hammering Cmd+Q (or a close that races a quit) must not stack dialogs —
  // every attempt waits on the same answer.
  const confirm = (): Promise<boolean> => {
    inFlight ??= deps.requestConfirmation().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    isApproved: (): boolean => approved,
    approve: (): void => {
      approved = true
    },
    defer: (event, reissue): boolean => {
      if (approved) return false
      event.preventDefault()
      void confirm().then((confirmed) => {
        if (!confirmed) return
        approved = true
        reissue()
      })
      return true
    },
  }
}
