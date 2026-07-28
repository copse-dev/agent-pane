/**
 * Standalone pack-tool worker. It is spawned only through Copse's active
 * OS sandbox and communicates with Electron main over bounded NDJSON on stdio.
 * Keep this entrypoint free of Electron imports.
 */
import { pathToFileURL } from 'node:url'
import {
  PACK_TOOL_PROTOCOL_MAX_LINE_BYTES,
  zPackBrowserTab,
  zPackToolHostRequest,
  type PackBrowserCall,
  type PackToolWorkerMessage,
} from './pack-tool-protocol.ts'
import {
  activatePackTools,
  parsePackBrowserTab,
  type ActivatedPackTools,
  type PackBrowserApi,
  type PackModelSessionApi,
} from './pack-tool-sdk.ts'
import { errorMessage } from '@shared/errors.ts'
import { parseJsonUnknown } from '@shared/unknown-value.ts'

let activated: ActivatedPackTools | null = null
let buffer = ''
const activeInvocations = new Map<number, AbortController>()
let nextSessionRequestId = 1
let nextBrowserRequestId = 1
const pendingSessionRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
const pendingBrowserRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function writeMessage(message: PackToolWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function writeResponse(id: number, ok: boolean, result?: unknown, error?: string): void {
  try {
    writeMessage({
      type: 'response',
      id,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error: error.slice(0, 8_192) } : {}),
    })
  } catch (err) {
    writeMessage({
      type: 'response',
      id,
      ok: false,
      error: `Pack tool returned a non-serializable result: ${errorMessage(err)}`,
    })
  }
}

function callSession(
  invocationId: number,
  op: 'get' | 'set' | 'delete',
  state?: unknown,
): Promise<unknown> {
  const id = nextSessionRequestId++
  return new Promise<unknown>((resolve, reject) => {
    pendingSessionRequests.set(id, { resolve, reject })
    try {
      writeMessage({
        type: 'session-call',
        id,
        invocationId,
        op,
        ...(state !== undefined ? { state } : {}),
      })
    } catch (err) {
      pendingSessionRequests.delete(id)
      reject(new Error(`Pack session request is not serializable: ${errorMessage(err)}`))
    }
  })
}

function sessionApi(invocationId: number): PackModelSessionApi {
  return Object.freeze({
    get: () => callSession(invocationId, 'get'),
    async set(state: unknown) {
      await callSession(invocationId, 'set', state)
    },
    async delete() {
      await callSession(invocationId, 'delete')
    },
  })
}

type PackBrowserCallBody = PackBrowserCall extends infer Call
  ? Call extends PackBrowserCall
    ? Omit<Call, 'type' | 'id' | 'invocationId'>
    : never
  : never

function callBrowser(invocationId: number, call: PackBrowserCallBody): Promise<unknown> {
  const id = nextBrowserRequestId++
  return new Promise<unknown>((resolve, reject) => {
    pendingBrowserRequests.set(id, { resolve, reject })
    try {
      writeMessage({ type: 'browser-call', id, invocationId, ...call })
    } catch (err) {
      pendingBrowserRequests.delete(id)
      reject(new Error(`Pack browser request is not serializable: ${errorMessage(err)}`))
    }
  })
}

function browserApi(invocationId: number): PackBrowserApi {
  return Object.freeze({
    async open(url: string, options?: { newTab?: boolean }) {
      const result = await callBrowser(invocationId, {
        op: 'open',
        url,
        ...(options?.newTab !== undefined ? { newTab: options.newTab } : {}),
      })
      return parsePackBrowserTab(result)
    },
    async navigate(tabId: string, url: string) {
      const result = await callBrowser(invocationId, { op: 'navigate', tabId, url })
      return parsePackBrowserTab(result)
    },
    async tabs() {
      const result = await callBrowser(invocationId, { op: 'tabs' })
      return zPackBrowserTab.array().parse(result)
    },
    async snapshot(tabId: string) {
      const result = await callBrowser(invocationId, { op: 'snapshot', tabId })
      if (typeof result !== 'string') throw new Error('Pack browser snapshot was not text.')
      return result
    },
    async click(tabId: string, ref: string) {
      await callBrowser(invocationId, { op: 'click', tabId, ref })
    },
    async type(tabId: string, ref: string, text: string) {
      await callBrowser(invocationId, { op: 'type', tabId, ref, text })
    },
    async upload(
      tabId: string,
      ref: string,
      files: readonly import('./pack-tool-protocol.ts').PackBrowserUploadFile[],
    ) {
      await callBrowser(invocationId, { op: 'upload', tabId, ref, files: [...files] })
    },
  })
}

async function dispatch(line: string): Promise<void> {
  let request
  try {
    request = zPackToolHostRequest.parse(parseJsonUnknown(line))
  } catch {
    return
  }

  switch (request.op) {
    case 'initialize': {
      if (activated) {
        writeResponse(request.id, false, undefined, 'Pack tools are already initialized.')
        return
      }
      try {
        const moduleValue: unknown = await import(pathToFileURL(request.entrypoint).href)
        activated = await activatePackTools(moduleValue, request.packId, request.apiVersion)
        writeResponse(request.id, true, activated.registrations)
      } catch (err) {
        writeResponse(request.id, false, undefined, errorMessage(err))
      }
      return
    }
    case 'invoke': {
      if (!activated) {
        writeResponse(request.id, false, undefined, 'Pack tools are not initialized.')
        return
      }
      const controller = new AbortController()
      activeInvocations.set(request.id, controller)
      try {
        const result =
          request.kind === 'tool'
            ? await activated.invokeTool(request.registrationId, request.input, controller.signal)
            : await activated.invokeModel(
                request.registrationId,
                request.input,
                controller.signal,
                sessionApi(request.id),
                browserApi(request.id),
              )
        writeResponse(request.id, true, result)
      } catch (err) {
        writeResponse(request.id, false, undefined, errorMessage(err))
      } finally {
        activeInvocations.delete(request.id)
      }
      return
    }
    case 'cancel': {
      activeInvocations.get(request.targetRequestId)?.abort()
      writeResponse(request.id, true)
      return
    }
    case 'session-result': {
      const pending = pendingSessionRequests.get(request.sessionRequestId)
      if (!pending) return
      pendingSessionRequests.delete(request.sessionRequestId)
      if (request.ok) pending.resolve(request.result)
      else pending.reject(new Error(request.error ?? 'Pack session request failed.'))
      return
    }
    case 'browser-result': {
      const pending = pendingBrowserRequests.get(request.browserRequestId)
      if (!pending) return
      pendingBrowserRequests.delete(request.browserRequestId)
      if (request.ok) pending.resolve(request.result)
      else pending.reject(new Error(request.error ?? 'Pack browser request failed.'))
      return
    }
    case 'shutdown': {
      for (const controller of activeInvocations.values()) controller.abort()
      for (const pending of pendingSessionRequests.values()) {
        pending.reject(new Error('Pack runtime shut down.'))
      }
      pendingSessionRequests.clear()
      for (const pending of pendingBrowserRequests.values()) {
        pending.reject(new Error('Pack runtime shut down.'))
      }
      pendingBrowserRequests.clear()
      writeResponse(request.id, true)
      setImmediate(() => process.exit(0))
      return
    }
  }
}

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  if (Buffer.byteLength(buffer, 'utf-8') > PACK_TOOL_PROTOCOL_MAX_LINE_BYTES * 2) {
    process.stderr.write('Pack tool protocol buffer exceeded its limit.\n')
    process.exit(1)
  }
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (Buffer.byteLength(line, 'utf-8') <= PACK_TOOL_PROTOCOL_MAX_LINE_BYTES) {
      void dispatch(line)
    }
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
