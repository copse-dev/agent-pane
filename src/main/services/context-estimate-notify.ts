export type ContextEstimateRefreshSink = () => void

let sink: ContextEstimateRefreshSink | null = null

export function setContextEstimateRefreshSink(next: ContextEstimateRefreshSink | null): void {
  sink = next
}

/** Ask the composer to re-run the pre-send context estimate (skills/tools changed). */
export function notifyRefreshContextEstimate(): void {
  sink?.()
}
