import type * as monaco from 'monaco-editor'
import type { ScenarioBridge } from './mock-scenario.ts'

declare global {
  interface Window {
    /** The actual lazy Monaco bundle export, shared with monaco-global.ts. */
    __copseMonaco?: typeof monaco
    __copseE2e?: ScenarioBridge
    __copsePinnedText?: { observer: MutationObserver; pinned: Map<Text, string> }
    __closeConfirmAnswers?: boolean[]
    __pageJumps?: number[]
    __toolDisclosureTrace?: { transitions: string[] }
  }
}
