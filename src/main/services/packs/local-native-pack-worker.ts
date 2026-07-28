/**
 * Standalone local-native pack worker. It is spawned only through Copse's active
 * OS sandbox and communicates with Electron main over bounded NDJSON on stdio.
 * Keep this entrypoint free of Electron imports.
 */
import { pathToFileURL } from 'node:url'
import type { LocalNativeCapability } from './local-native-pack.ts'
import {
  LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES,
  zLocalNativeHostRequest,
  type LocalNativeWorkerMessage,
} from './local-native-pack-protocol.ts'
import {
  activateLocalNativePack,
  type ActivatedLocalNativePack,
} from './local-native-pack-runtime.ts'
import { errorMessage } from '@shared/errors.ts'
import { parseJsonUnknown } from '@shared/unknown-value.ts'

let activated: ActivatedLocalNativePack | null = null
let buffer = ''
let nextHostCallId = 1
const pendingHostCalls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
const activeInvocations = new Map<number, AbortController>()

function writeMessage(message: LocalNativeWorkerMessage): void {
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
      error: `Local native pack returned a non-serializable result: ${errorMessage(err)}`,
    })
  }
}

function callHost(
  capability: LocalNativeCapability,
  method: string,
  args: unknown,
): Promise<unknown> {
  const id = nextHostCallId++
  return new Promise((resolve, reject) => {
    pendingHostCalls.set(id, { resolve, reject })
    try {
      writeMessage({ type: 'host-call', id, capability, method, args })
    } catch (err) {
      pendingHostCalls.delete(id)
      reject(new Error(`Local native host call is not serializable: ${errorMessage(err)}`))
    }
  })
}

async function dispatch(line: string): Promise<void> {
  let request
  try {
    request = zLocalNativeHostRequest.parse(parseJsonUnknown(line))
  } catch {
    return
  }

  switch (request.op) {
    case 'initialize': {
      if (activated) {
        writeResponse(request.id, false, undefined, 'Local native pack is already initialized.')
        return
      }
      try {
        const moduleValue: unknown = await import(pathToFileURL(request.entrypoint).href)
        activated = await activateLocalNativePack(
          moduleValue,
          request.packId,
          {
            entrypoint: request.entrypoint,
            sdkVersion: request.sdkVersion,
            capabilities: request.capabilities,
            origins: [],
            rendererSlots: [],
          },
          callHost,
        )
        writeResponse(request.id, true, activated.registrations)
      } catch (err) {
        writeResponse(request.id, false, undefined, errorMessage(err))
      }
      return
    }
    case 'invoke': {
      if (!activated) {
        writeResponse(request.id, false, undefined, 'Local native pack is not initialized.')
        return
      }
      const controller = new AbortController()
      activeInvocations.set(request.id, controller)
      try {
        const result = await activated.invoke(
          request.kind,
          request.registrationId,
          request.input,
          controller.signal,
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
    case 'host-call-result': {
      const pending = pendingHostCalls.get(request.hostCallId)
      if (!pending) return
      pendingHostCalls.delete(request.hostCallId)
      if (request.ok) pending.resolve(request.result)
      else pending.reject(new Error(request.error ?? 'Local native host call failed.'))
      return
    }
    case 'shutdown': {
      for (const controller of activeInvocations.values()) controller.abort()
      for (const pending of pendingHostCalls.values()) {
        pending.reject(new Error('Local native pack host shut down.'))
      }
      pendingHostCalls.clear()
      writeResponse(request.id, true)
      setImmediate(() => process.exit(0))
      return
    }
  }
}

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  if (Buffer.byteLength(buffer, 'utf-8') > LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES * 2) {
    process.stderr.write('Local native pack protocol buffer exceeded its limit.\n')
    process.exit(1)
  }
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (Buffer.byteLength(line, 'utf-8') <= LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES) {
      void dispatch(line)
    }
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
