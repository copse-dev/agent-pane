/** Wire types for Settings → Classifiers' local-server detection and installer. */

export type LocalClassifierPhase =
  /** Nothing in the cache and nothing listening. */
  | 'not-installed'
  | 'installing'
  /** Set up in the cache, not running. */
  | 'installed'
  /** Copse started it and it is loading its model. */
  | 'starting'
  /** Copse started it and it is accepting connections. */
  | 'running'
  /** Something else started it and it is accepting connections. */
  | 'external'

export interface LocalClassifierStatus {
  /** Catalog key: `kev`, `winnow`. */
  id: string
  label: string
  /** The `CLASSIFIER_PRESETS` id that connects to this server. */
  presetId: string
  baseUrl: string
  phase: LocalClassifierPhase
  /** Rough download for the confirmation prompt, in decimal gigabytes. */
  downloadGb: number
  /** Where the setup code comes from, for the confirmation prompt. */
  source: string
  /** Programs the install runs. */
  needs: string[]
  /** The subset of `needs` that is not on PATH. */
  missing: string[]
  /** A saved connection already points at this server. */
  saved: boolean
  /** The last output line while installing or starting. */
  progress?: string
  /** Why the last install or start failed. Cleared when the next one begins. */
  error?: string
}

/** A hosted classifier whose provider key is already in the environment. */
export interface HostedClassifierHint {
  presetId: string
  label: string
  envVar: string
}

export interface LocalClassifierOverview {
  servers: LocalClassifierStatus[]
  hosted: HostedClassifierHint[]
}

export interface LocalClassifierClient {
  status(): Promise<LocalClassifierOverview>
  /** Download, set up, start and save a connection for a catalog server. Returns at once; poll `status`. */
  install(id: string): Promise<LocalClassifierOverview>
  start(id: string): Promise<LocalClassifierOverview>
  /** Stop a server Copse started, or cancel its install. */
  stop(id: string): Promise<LocalClassifierOverview>
  /** Save a connection for a catalog server that is already running. Returns the saved profiles' ids. */
  connect(id: string): Promise<LocalClassifierOverview>
}
