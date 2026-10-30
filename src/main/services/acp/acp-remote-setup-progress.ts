import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Progress for the slow, otherwise silent part of starting an ACP agent on an
 * SSH host: connecting, looking for the agent on the remote PATH, installing
 * a missing adapter, and spawning it. Each probe can take seconds and an
 * install can take minutes, and until the agent's first token the transcript
 * showed only a generic "Reasoning…" (docs/plans/acp-over-ssh.md).
 *
 * Like `acp-remote-install-approval.ts`, this is a dependency-free seam:
 * `acp-ssh-transport.ts` is bundled into the ACP workers, so it cannot reach
 * the turn's output stream directly. The turn binds a reporter around its run
 * and the transport reports into whatever reporter its async context carries.
 * Outside a turn (capability probes, workers) reports go nowhere.
 */

/**
 * `setup` marks one-time host work (an adapter install) so the label can say
 * so; `start` is the per-turn cost of reaching the agent.
 */
export interface RemoteAcpSetupProgress {
  phase: 'start' | 'setup'
  label: string
}

type Reporter = (progress: RemoteAcpSetupProgress) => void

const reporterStore = new AsyncLocalStorage<Reporter>()

/** Run `fn` with `report` receiving any remote setup progress it causes. */
export function withRemoteAcpSetupProgress<T>(report: Reporter, fn: () => Promise<T>): Promise<T> {
  return reporterStore.run(report, fn)
}

/** Report a remote setup stage to the current turn, if one is listening. */
export function reportRemoteAcpSetupProgress(progress: RemoteAcpSetupProgress): void {
  reporterStore.getStore()?.(progress)
}
