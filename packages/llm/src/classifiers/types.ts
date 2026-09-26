/** Classifier connections are independent of chat-model selection. */
export type ClassifierState = string | { [key: string]: JsonValue } | JsonValue[]
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface HttpClassifierConnection {
  type: 'http'
  protocol: 'systemone' | 'featherless'
  baseUrl: string
  auth: 'none' | 'bearer'
  apiKeyEnv?: string
}

export interface SemIfClassifierConnection {
  type: 'semif'
  executable: string
  backend: 'torch' | 'mlx' | 'llamacpp'
  revision: string
  mode: 'direct' | 'serial' | 'shared'
  gguf?: string
  device?: 'auto' | 'cuda' | 'mps'
  maxTokens?: number
}

export interface ClassifierProfile {
  id: string
  label: string
  model: string
  timeoutMs: number
  connection: HttpClassifierConnection | SemIfClassifierConnection
}

export type ClassifierQuestion =
  | { type: 'choice'; instructions: string; options: Record<string, string | null> }
  | { type: 'boolean'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'score'; instructions: string; levels: string[] }

export interface ClassifierRequest {
  state: ClassifierState
  questions: Record<string, ClassifierQuestion>
}

export type ClassifierAnswer =
  | {
      type: 'choice'
      choice: string
      probabilities: Record<string, number>
      confidence?: number
      derived?: boolean
    }
  | { type: 'boolean'; probability: number; derived?: boolean }
  | {
      type: 'score'
      score: number
      levels: string[]
      probabilities: Record<string, number>
      confidence?: number
    }

export interface ClassifierResult {
  profileId: string
  adapter: string
  requestedModel: string
  model: string
  answers: Record<string, ClassifierAnswer>
  elapsedMs: number
  requestId?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  metadata?: Record<string, JsonValue>
}

export interface ClassifierCallOptions {
  apiKey?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface ClassifierProfileStatus {
  profile: ClassifierProfile
  hasKey: boolean
  encrypted: boolean | null
}

export interface ClassifierClient {
  list(): Promise<ClassifierProfileStatus[]>
  save(profile: ClassifierProfile): Promise<ClassifierProfileStatus[]>
  remove(id: string): Promise<ClassifierProfileStatus[]>
  test(id: string): Promise<ClassifierResult>
  /** The saved connection that screens shell commands and terminal reads; `null` means the safety model does. */
  screening(): Promise<string | null>
  /** Route safety screening to a saved connection, or back to the safety model with `null`. */
  setScreening(id: string | null): Promise<string | null>
}
