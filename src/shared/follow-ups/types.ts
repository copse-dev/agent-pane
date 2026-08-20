export type FollowUpVariant = 'default' | 'changes'

/** A clickable follow-up bubble shown above the input bar. */
export interface FollowUpSuggestion {
  id: string
  label: string
  prompt: string
  variant?: FollowUpVariant
  /** Present when variant is "changes" — rendered as green/red counts. */
  additions?: number
  deletions?: number
}

export interface FollowUpContext {
  userMessage: string
  assistantMessage: string
  toolNames: string[]
}

export interface PrWorkspaceContext {
  branch: string | null
  hasOpenPr: boolean
  hasMergeConflicts: boolean
  hasCiFailures: boolean
  changeStats: { additions: number; deletions: number } | null
}
