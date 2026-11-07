import type * as monaco from 'monaco-editor'
import type * as axe from 'axe-core'
import type { ScenarioBridge } from './mock-scenario.ts'

declare global {
  interface Window {
    /** The actual lazy Monaco bundle export, shared with monaco-global.ts. */
    __copseMonaco?: typeof monaco
    __copseE2e?: ScenarioBridge
    /** Test-helper-only observation identity and exact acknowledged ledger prefix. */
    __copseE2eErrorToastState?: {
      owner: ScenarioBridge | undefined
      generation: string
      acknowledged: string[]
    }
    __closeConfirmAnswers?: boolean[]
    __pageJumps?: number[]
    __multiWindowIpc?: { changes: string[]; statusPushes: number }
    __toolDisclosureTrace?: { transitions: string[] }
    /** axe-core, injected by helpers/axe.ts for the accessibility lane. */
    axe?: typeof axe
  }
}
