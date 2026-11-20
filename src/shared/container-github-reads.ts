/**
 * GitHub reads in a container run (`docs/plans/thread-in-container.md`, A24).
 * The user turns them on for one run in the run dialog; they are off unless
 * they do. Even then a run gets them only when nothing in it can carry what it
 * reads off the machine: it installs nothing, and the desktop calls its model
 * (an ACP agent's own origins are a tunnel its shell children share).
 *
 * Shared so the dialog's preview and the arming record say the same thing.
 */
export interface ContainerGitHubReadsChoice {
  /** The user turned GitHub reads on for this run. */
  requested: boolean
  /** The run installs dependencies before the agent starts. */
  installs: boolean
  /** The desktop calls the run's model (host inference), rather than an agent in the guest. */
  hostInference: boolean
}

/** Whether the run gets the GitHub read capability. */
export function containerGitHubReadsGranted(choice: ContainerGitHubReadsChoice): boolean {
  return choice.requested && !choice.installs && choice.hostInference
}

/** The "GitHub: …" line of the run's arming record. */
export function containerGitHubReadsArmingLine(choice: ContainerGitHubReadsChoice): string {
  if (!choice.requested) return 'GitHub: off, not turned on for this run'
  if (choice.installs) return 'GitHub: off, because the run installs dependencies'
  if (!choice.hostInference)
    return 'GitHub: off, because the run reaches its model through its own network origins'
  return 'GitHub: read-only through your desktop GitHub sign-in, turned on for this run; writes refused'
}
