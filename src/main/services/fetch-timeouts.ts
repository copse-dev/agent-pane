/**
 * Named timeouts (ms) for outbound HTTP calls, so fetch sites stay consistent
 * and intent is explicit rather than scattered magic numbers.
 */
export const FETCH_TIMEOUTS = {
  /** Quick liveness/list calls to a local model server. */
  modelList: 4_000,
  /** Cloud API key validation round-trips. */
  apiKeyValidation: 8_000,
  /** Local safety-classification chat completion. */
  safetyClassification: 8_000,
  /** LM Studio model-download status poll. */
  downloadStatus: 8_000,
  /** LM Studio model-download kickoff (slow). */
  downloadStart: 30_000,
} as const
