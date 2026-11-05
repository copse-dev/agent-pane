/** Developer fixture: drives only the renderer on guest loopback, with no host port. */
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const targetsSchema = z.array(
  z.object({
    type: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
  }),
)
const replySchema = z.object({
  id: z.literal(1),
  result: z.object({ result: z.object({ value: z.unknown() }) }),
})

export async function smokeAppleDesktopGui(containment = false): Promise<void> {
  const approval = { commandApproved: false }
  const targets = safeJsonParse(
    await (
      await fetch('http://127.0.0.1:9222/json/list', {
        signal: AbortSignal.timeout(2000),
      })
    ).text(),
    decodeWithSchema(targetsSchema),
  )
  const address = targets?.find((target) => target.type === 'page')?.webSocketDebuggerUrl
  if (!address) throw new Error('Guest renderer is unavailable')
  const endpoint = new URL(address)
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9222')
    throw new Error('Unexpected guest debugging endpoint')
  const evaluate = (expression: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint.href)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('Guest GUI observation timed out'))
      }, 5000)
      const finish = (): void => {
        clearTimeout(timer)
        socket.close()
      }
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })
      socket.addEventListener('error', () => {
        finish()
        reject(new Error('Guest GUI connection failed'))
      })
      socket.addEventListener('message', (event) => {
        finish()
        const reply =
          typeof event.data === 'string'
            ? safeJsonParse(event.data, decodeWithSchema(replySchema))
            : undefined
        if (!reply) reject(new Error('Invalid guest GUI observation'))
        else resolve(reply.result.result.value)
      })
    })
  const until = async (expression: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (containment) {
        const approved = await evaluate(`(() => {
          const dialog = document.querySelector('#approval-dialog[open]');
          if (!dialog) return false;
          const title = dialog.querySelector('.approval-heading')?.textContent ?? '';
          if (title.includes('Install software to connect your coding agents')) {
            dialog.querySelector('.approval-reject').click();
            return false;
          }
          const body = dialog.querySelector('.approval-body')?.textContent ?? '';
          if (body.includes('desktop-host-canary-') && body.includes('node -e')) {
            dialog.querySelector('.approval-approve').click();
            return true;
          }
          return false;
        })()`)
        if (approved === true) approval.commandApproved = true
      }
      if ((await evaluate(expression)) === true) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const detail = await evaluate('document.body.innerText.slice(-5000)')
    throw new Error('Child GUI did not reach expected state: ' + String(detail))
  }
  await evaluate("document.querySelector('#onboarding-skip')?.click(); true")
  await until("Boolean(document.querySelector('#welcome.visible .welcome-new-btn'))")
  await evaluate("document.querySelector('.welcome-new-btn').click(); true")
  await until("Boolean(document.querySelector('#new-project-dialog[open]'))")
  await evaluate(`(() => {
    const name = document.querySelector('.new-project-name');
    const parent = document.querySelector('.new-project-parent');
    name.value = 'desktop-gui-smoke';
    parent.value = '/tmp';
    name.dispatchEvent(new Event('input', {bubbles:true}));
    parent.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#new-project-dialog .ui-btn-primary').click();
    return true;
  })()`)
  await until("Boolean(document.querySelector('.prompt-input'))")
  await evaluate(`(() => {
    const composer = document.querySelector('.prompt-input');
    composer.focus();
    composer.textContent = 'Isolated desktop GUI smoke 😀';
    composer.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('.submit-btn').click();
    return true;
  })()`)
  await until(
    "Array.from(document.querySelectorAll('.msg-assistant .message-text')).some(node => node.textContent.includes('Approved mock response 😀'))",
  )
  // First-run agent discovery may offer an optional package install. Keep this
  // fixed model smoke independent of downloading or installing those agents.
  await evaluate(`(() => {
    const dialog = document.querySelector('#approval-dialog[open]');
    if (dialog?.querySelector('.approval-heading')?.textContent
        ?.includes('Install software to connect your coding agents')) {
      dialog.querySelector('.approval-reject').click();
    }
    return true;
  })()`)
  await until("!document.querySelector('#approval-dialog[open]')")
  await until(
    "!Array.from(document.querySelectorAll('.stop-btn')).some(node => node.getClientRects().length > 0)",
  )
  if (containment && !approval.commandApproved)
    throw new Error('The child command did not require and receive approval')
}
