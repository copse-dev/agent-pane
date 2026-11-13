import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { mountConversation } from './conversation.ts'
import { mountInputBar, type MountInputBarOptions } from './input-bar.ts'

/** Both the desktop window and paired browser mount this chat surface. */
export function mountChatSurface(
  conversation: HTMLElement,
  input: HTMLElement,
  store: AppStore,
  api: ApiClient,
  options: MountInputBarOptions = {},
): ReturnType<typeof mountInputBar> {
  const composer = mountInputBar(input, store, api, options)
  const unmountConversation = mountConversation(conversation, store, api, {
    host: options.transport ? 'remote' : 'desktop',
  })
  return {
    ...composer,
    unmount(): void {
      composer.unmount()
      unmountConversation()
    },
  }
}
