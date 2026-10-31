import type { Project } from '@shared/types'

/**
 * Integrated terminals on an SSH project ask “Open remote terminal?” every time
 * one spawns, and that approval cannot be remembered (docs/shell-permissions.md,
 * “SSH workspaces”). That is right for a shell the user opened. It is wrong for
 * one Copse opened for them: with the Shells pane showing, starting a new thread
 * or moving one into its worktree adds a tab for it, and on SSH that tab's spawn
 * dropped the approval into the middle of an agent's first-run setup.
 *
 * Such automatic tabs on an SSH project therefore wait for the user: the tab
 * shows a connect hint and spawns, still behind the same approval, only on a
 * click or keypress in it. Tabs the user asked for spawn as before.
 */

/** The host label a tab's shell would run on, or null for a local shell. */
export function remoteTerminalHostLabel(
  projects: readonly Project[],
  projectId: string | null,
  executionTarget: 'local' | undefined,
): string | null {
  if (executionTarget === 'local' || !projectId) return null
  const project = projects.find((candidate) => candidate.id === projectId)
  if (!project?.sshHost) return null
  // SSH project names are `label:path`; fall back to the host id.
  const colon = project.name.indexOf(':')
  return colon > 0 ? project.name.slice(0, colon) : project.sshHost
}

/** Whether a new tab should wait for the user before spawning its shell. */
export function deferTerminalSpawn(input: {
  automatic: boolean
  hostLabel: string | null
}): boolean {
  return input.automatic && input.hostLabel !== null
}

/** The lines a waiting remote tab shows; short, so a narrow pane cannot split a word. */
export function remoteTerminalConnectHint(hostLabel: string): string[] {
  return [`Remote shell on ${hostLabel}.`, 'Click or press a key to connect.']
}
