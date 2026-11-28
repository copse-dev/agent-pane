import type * as monaco from 'monaco-editor'
import type * as axe from 'axe-core'
import type { ScenarioBridge } from './mock-scenario.ts'

declare global {
  interface Window {
    /** The actual lazy Monaco bundle export, shared with monaco-global.ts. */
    __copseMonaco?: typeof monaco
    __copseE2e?: ScenarioBridge
    __closeConfirmAnswers?: boolean[]
    /** What the last `startSshWorker` call answered, once it has. */
    __sshWorkerStart?: unknown
    __pageJumps?: number[]
    __multiWindowIpc?: { changes: string[]; statusPushes: number }
    __toolDisclosureTrace?: { transitions: string[] }
    /** axe-core, injected by helpers/axe.ts for the accessibility lane. */
    axe?: typeof axe
  }
}
