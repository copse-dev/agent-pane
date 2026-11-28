import { contextBridge, ipcRenderer } from 'electron'
import type { ProtectedPromptSeed, ProtectedPromptSubmission } from '@shared/types'

contextBridge.exposeInMainWorld('protectedPrompt', {
  onSeed(handler: (seed: ProtectedPromptSeed) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, seed: ProtectedPromptSeed): void => {
      handler(seed)
    }
    ipcRenderer.on('protected-prompt:seed', listener)
    return () => {
      ipcRenderer.off('protected-prompt:seed', listener)
    }
  },
  submit(submission: ProtectedPromptSubmission): Promise<void> {
    return ipcRenderer.invoke('protected-prompt:submit', submission)
  },
  cancel(draft: ProtectedPromptSubmission): Promise<void> {
    return ipcRenderer.invoke('protected-prompt:cancel', draft)
  },
  onInterrupt(handler: () => ProtectedPromptSubmission): () => void {
    const listener = (): void => {
      void ipcRenderer.invoke('protected-prompt:interrupted', handler()).catch(() => undefined)
    }
    ipcRenderer.on('protected-prompt:interrupt', listener)
    return () => {
      ipcRenderer.off('protected-prompt:interrupt', listener)
    }
  },
})
