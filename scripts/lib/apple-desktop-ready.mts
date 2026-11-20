import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const targetSchema = z.array(
  z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() }),
)
const observationSchema = z.object({
  ready: z.boolean(),
  width: z.number(),
  height: z.number(),
  composer: z.boolean(),
  onboarding: z.boolean(),
  welcome: z.boolean(),
})
const replySchema = z.object({
  id: z.literal(1),
  result: z.object({ result: z.object({ value: observationSchema }) }),
})

// Runs only in the guest renderer. Assert a usable screen rather than a mapped X window.
export const APPLE_DESKTOP_READY_EXPRESSION = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
  const visible = selector => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const composer = visible('.prompt-input');
  const onboarding = visible('#onboarding-dialog[open]');
  const welcome = visible('#welcome.visible .welcome-card');
  resolve({ ready: document.readyState === 'complete' && innerWidth === 1280 && innerHeight === 800 && (composer || onboarding || welcome), width: innerWidth, height: innerHeight, composer, onboarding, welcome });
})))`

function observe(url: string): Promise<z.infer<typeof observationSchema>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Guest renderer observation timed out'))
    }, 2000)
    const finish = (): void => {
      clearTimeout(timer)
      socket.close()
    }
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: APPLE_DESKTOP_READY_EXPRESSION,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      )
    })
    socket.addEventListener('error', () => {
      finish()
      reject(new Error('Guest renderer observation failed'))
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > 64 * 1024) {
        finish()
        reject(new Error('Invalid guest renderer observation'))
        return
      }
      const result = safeJsonParse(event.data, decodeWithSchema(replySchema))
      if (!result) {
        finish()
        reject(new Error('Malformed guest renderer observation'))
        return
      }
      finish()
      resolve(result.result.result.value)
    })
  })
}

/** Debugging endpoint stays on guest loopback, with no published port or host connection. */
export async function waitForAppleDesktopReady(deadline: number): Promise<void> {
  let detail = 'No renderer target'
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/list', {
        signal: AbortSignal.timeout(1000),
      })
      const targets = safeJsonParse(await response.text(), decodeWithSchema(targetSchema))
      const target = targets?.find(
        (candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl,
      )
      const address = target?.webSocketDebuggerUrl
      if (address) {
        const url = new URL(address)
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9222')
          throw new Error('Unexpected guest debugging endpoint')
        const result = await observe(url.href)
        if (result.ready) return
        detail = JSON.stringify(result)
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Copse renderer did not become ready: ${detail}`)
}
