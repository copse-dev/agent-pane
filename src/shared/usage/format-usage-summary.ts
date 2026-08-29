import type { UsagePeriodSummary } from './aggregate-usage.ts'

export function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00'
  if (amount < 0.01) return '<$0.01'
  return `~$${amount.toFixed(2)}`
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatPeriodHeadline(summary: UsagePeriodSummary): string {
  const localCount = summary.localModels.length
  const cloudCount = summary.cloudModels.length
  const parts: string[] = [formatUsd(summary.totalCostUsd)]
  if (cloudCount) parts.push(`${String(cloudCount)} cloud model${cloudCount === 1 ? '' : 's'}`)
  if (localCount) parts.push(`${String(localCount)} local model${localCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
