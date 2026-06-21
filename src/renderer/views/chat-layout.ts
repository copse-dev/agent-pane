/** Pin #input-bar to the bottom of #pane-chat and inset #conversation so it cannot overlap. */
export function bindChatComposerLayout(): () => void {
  const pane = document.getElementById('pane-chat')
  const input = document.getElementById('input-bar')
  const conversation = document.getElementById('conversation')
  if (!pane || !input || !conversation) return () => {}

  const sync = (): void => {
    const height = Math.max(Math.ceil(input.getBoundingClientRect().height), 72)
    pane.style.setProperty('--chat-composer-height', `${height}px`)
  }

  sync()
  requestAnimationFrame(sync)

  const observer = new ResizeObserver(sync)
  observer.observe(input)

  window.addEventListener('resize', sync, { passive: true })

  return () => {
    observer.disconnect()
    window.removeEventListener('resize', sync)
  }
}
