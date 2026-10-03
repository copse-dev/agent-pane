export const GIT_THREAD_LINK_SETTING = 'gitThreadLinksEnabled'
export const DEFAULT_GIT_THREAD_LINK_ENABLED = false

export function isThreadLinkId(id: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
}

export function parseThreadDeepLink(url: string): string | null {
  const match = /^copse:\/\/thread\/([a-f0-9-]+)$/i.exec(url)
  const id = match?.[1]
  return id && isThreadLinkId(id) ? id : null
}

export function appendThreadLink(message: string, threadId: string | null): string {
  if (!threadId || !isThreadLinkId(threadId) || /^Copse-Thread:/m.test(message)) return message
  const body = message.trimEnd()
  const trailer = `Copse-Thread: https://copse.dev/open/#thread=${threadId}`
  return `${body}${body ? '\n\n' : ''}${trailer}\n`
}
