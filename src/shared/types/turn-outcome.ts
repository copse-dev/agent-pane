import type { HeadlessStopReason } from '@copse/agent/headless-contract.ts'

/** Bounded provider/transport detail captured when a turn fails. */
export interface TurnErrorDetail {
  message: string
  name?: string
  code?: string | number
  /** Distinct nested-cause or structured-data detail, when the error carried it. */
  details?: string
}

/** Durable terminal record attached to the assistant message that concluded a turn. */
export interface TurnOutcome {
  status: 'completed' | 'failed' | 'cancelled'
  stopReason: HeadlessStopReason
  /** Provider/agent stop reason before canonical normalization. */
  rawStopReason?: string
  source: 'provider' | 'host' | 'user' | 'hook'
  executor: 'local' | 'acp' | 'remote' | 'plugin'
  /** Provider slug for built-in models; external agent/plugin id otherwise. */
  provider: string
  /** Concrete route selected for this turn. */
  model: string
  /** Last meaningful provider event observed before termination. */
  lastEvent?: 'text' | 'reasoning' | 'tool'
  recovery?: {
    reason: 'ended_after_tools'
    attempted: boolean
    recovered: boolean
  }
  error?: TurnErrorDetail
  endedAt: number
}
