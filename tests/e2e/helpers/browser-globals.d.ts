import type * as monaco from 'monaco-editor'
import type { ScenarioBridge } from './mock-scenario.ts'

declare global {
  interface Window {
    /** The actual lazy Monaco bundle export, shared with monaco-global.ts. */
    __copseMonaco?: typeof monaco
    __copseE2e?: ScenarioBridge
    __closeConfirmAnswers?: boolean[]
    __pageJumps?: number[]
    __multiWindowIpc?: { changes: string[]; statusPushes: number }
    __toolDisclosureTrace?: { transitions: string[] }
  }
}
