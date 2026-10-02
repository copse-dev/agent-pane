/** Public connection metadata. OAuth tokens are never part of this IPC shape. */
export interface ChatGptPlanAccount {
  clientId: string
  label: string
  connected: boolean
  planEnabled: boolean
}

export interface ChatGptPlanStatus {
  accounts: ChatGptPlanAccount[]
  activeClientId: string | null
}

export interface ChatGptPlanModel {
  slug: string
  displayName: string
}

export interface ChatGptPlanClient {
  status: () => Promise<ChatGptPlanStatus>
  signIn: (clientId?: string) => Promise<ChatGptPlanStatus>
  refreshAccount: (clientId: string) => Promise<ChatGptPlanStatus>
  cancelSignIn: () => Promise<void>
  selectAccount: (clientId: string) => Promise<ChatGptPlanStatus>
  signOut: (clientId: string) => Promise<{ status: ChatGptPlanStatus; revoked: boolean }>
  models: () => Promise<{ clientId: string | null; models: ChatGptPlanModel[] }>
}
