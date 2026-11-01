/** Keep workspace-dependent IPC behind the workspace selected by this window. */
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

// Controls addressed to a live close request, run or terminal session. A
// switch that fails or is superseded must not delay or discard "Keep working",
// Stop or Ctrl-C. Creating a terminal still waits: it opens in the workspace.
const ADDRESSED_CONTROLS: ReadonlySet<string> = new Set([
  'close-confirm:respond',
  'agent:abort',
  'container:stop-run',
  'terminal:write',
  'terminal:resize',
  'terminal:destroy',
  'terminal:set-meta',
  'terminal:set-active',
])

export function createWorkspaceNavigation(invoke: Invoke): Invoke {
  let navigation: Promise<unknown> | null = null
  let generation = 0
  let transition: Promise<unknown> | null = null

  return (channel, ...args): Promise<unknown> => {
    if (channel === 'workspace:set') {
      generation += 1
      const requestedGeneration = generation
      const previous = transition
      // Dispatch the first selection immediately and coalesce subsequent clicks
      // within this task. Main guards its root commit against supersession, so
      // a slow SSH connection cannot hold up a later local selection.
      const next = previous
        ? Promise.resolve().then(() => {
            if (requestedGeneration !== generation) {
              throw new Error('Workspace selection superseded before activation')
            }
            return invoke(channel, ...args)
          })
        : invoke(channel, ...args)
      transition = next
      // Keep a rejected transition as the barrier until a recovery selection.
      // Falling through to the old root after an open failure is unsafe.
      void next.then(
        () => {
          if (transition === next) transition = null
        },
        () => undefined,
      )
      return next
    }
    if (channel === 'main-window:set-navigation') {
      const next = invoke(channel, ...args)
      navigation = next
      void next.then(
        () => {
          if (navigation === next) navigation = null
        },
        () => undefined,
      )
      return next
    }
    // These APIs name their project explicitly or do not use the workspace.
    // In particular, transcript reads must not wait for workspace services.
    if (
      (transition === null && navigation === null) ||
      channel.startsWith('threads:') ||
      channel.startsWith('storage:') ||
      channel.startsWith('settings:') ||
      channel.startsWith('main-window:') ||
      channel.startsWith('perf:') ||
      // The activation may itself be waiting for an authentication answer.
      // Replies name a pending request, never the ambient workspace.
      channel === 'ssh-prompt:respond' ||
      channel === 'approval:respond' ||
      channel === 'ask:respond' ||
      ADDRESSED_CONTROLS.has(channel)
    ) {
      return invoke(channel, ...args)
    }
    const selected = transition
    const requestedGeneration = generation
    return Promise.resolve(selected).then(async () => {
      // Project stores resolve navigation separately from the filesystem root.
      // Include serialized navigation writes submitted while the root opened.
      while (navigation !== null) await navigation
      // A request made for a superseded selection must never run in its successor.
      if (requestedGeneration !== generation) {
        throw new Error('Workspace selection changed before the request could run')
      }
      return invoke(channel, ...args)
    })
  }
}
