export interface PromptAttachmentHandlers {
  attachFile(file: { path: string; content: string }): void
  attachTextBlock(content: string): void
  attachImage(dataUrl: string, mimeType: string): void
}

let handlers: PromptAttachmentHandlers | null = null

export function registerPromptAttachments(h: PromptAttachmentHandlers): () => void {
  handlers = h
  return () => {
    if (handlers === h) handlers = null
  }
}

export function getPromptAttachmentHandlers(): PromptAttachmentHandlers | null {
  return handlers
}
