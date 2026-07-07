// Heuristic estimator for how much low-bit quantization degrades a model's
// full-precision benchmark score. Public leaderboards mostly report fp16/bf16
// numbers, but users run 4-bit GGUF/AWQ locally — so this lets us seed an
// *estimated* quantized score from the widely-published full-precision one when
// no direct quantized measurement exists. Estimates are always flagged
// (see EstimatedScore.estimated) and never presented as measured.
//
// The curve is anchored to public perplexity / KL-divergence and benchmark
// degradation ranges (llama.cpp K-quant tables; the few paired fp16-vs-GGUF
// leaderboard entries) and is deliberately simple and monotonic:
//   - fewer bits per weight → more damage (steep below ~4 bpw)
//   - larger models         → less damage (they quantize more gracefully)
// The constants are TUNABLE: a calibration pass can refit A/B/α from paired
// (full, quantized) data points — e.g. Aider's fp16 vs `ollama/*` GGUF entries —
// rather than the hand-anchored values here.

export interface QuantContext {
  /**
   * Effective bits per weight. Rough guide: Q8≈8, Q6_K≈6.6, Q5_K_M≈5.5,
   * Q4_K_M≈4.5, Q3_K_M≈3.4, Q2_K≈2.6.
   */
  bitsPerWeight: number
  /** Total parameters in billions (total, not active, for MoE). */
  paramsB: number
  /**
   * Optional task sensitivity: code/reasoning degrade a little more than
   * knowledge MCQs. 1 = neutral; ~1.3 for code/math, ~0.8 for MMLU-style. Kept
   * optional so callers can ignore it until it's calibrated.
   */
  taskSensitivity?: number
}

// drop = A * exp(-B * bpw), anchored so a 30B model loses ≈1.2% at Q4_K_M and
// ≈13% at Q2_K, and is near-lossless (<0.1%) at Q8.
const A = 3.35
const B = 1.25
const REF_PARAMS_B = 30
const SIZE_EXP = 0.4
const MAX_DROP = 0.6

function baseDrop(bitsPerWeight: number): number {
  if (!(bitsPerWeight > 0)) return MAX_DROP
  return Math.min(MAX_DROP, A * Math.exp(-B * bitsPerWeight))
}

// Larger models quantize better; smaller ones worse. Clamped so a tiny or huge
// model can't produce an absurd factor.
function sizeFactor(paramsB: number): number {
  if (!(paramsB > 0)) return 3
  return Math.min(3, Math.max(0.5, Math.pow(REF_PARAMS_B / paramsB, SIZE_EXP)))
}

/**
 * Estimated relative benchmark drop in [0, {@link MAX_DROP}] from quantizing an
 * fp16 model down to `bitsPerWeight`. Pure and monotonic — see module header.
 */
export function estimateQuantPenalty(ctx: QuantContext): number {
  const raw = baseDrop(ctx.bitsPerWeight) * sizeFactor(ctx.paramsB) * (ctx.taskSensitivity ?? 1)
  return Math.min(MAX_DROP, Math.max(0, raw))
}

export interface EstimatedScore {
  value: number
  /** Always true — marks this as derived, not measured. */
  estimated: true
  /** Human-readable derivation, for the "why" tooltip and provenance. */
  basis: string
}

/**
 * Estimate a quantized benchmark score from a full-precision one. Clamped to
 * [0, fullScore] (quantization never *improves* a score). The result carries a
 * provenance string so it can be stored and shown as an estimate.
 */
export function estimateQuantizedScore(fullScore: number, ctx: QuantContext): EstimatedScore {
  const penalty = estimateQuantPenalty(ctx)
  const value = Math.max(0, Math.min(fullScore, fullScore * (1 - penalty)))
  return {
    value: Number(value.toFixed(2)),
    estimated: true,
    basis: `full-precision −${(penalty * 100).toFixed(1)}% est. quant penalty (${String(ctx.bitsPerWeight)}bpw, ${String(ctx.paramsB)}B)`,
  }
}
