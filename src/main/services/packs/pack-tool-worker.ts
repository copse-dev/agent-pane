/**
 * Standalone pack-tool worker. It is spawned only through Copse's active
 * OS sandbox and communicates with Electron main over bounded NDJSON on stdio.
 * Keep this entrypoint free of Electron imports.
 */
import { pathToFileURL } from 'node:url'
import {
  PACK_TOOL_PROTOCOL_MAX_LINE_BYTES,
  zPackToolHostRequest,
  type PackToolWorkerMessage,
} from './pack-tool-protocol.ts'
import { activatePackTools, type ActivatedPackTools } from './pack-tool-sdk.ts'
import { errorMessage } from '@shared/errors.ts'
import { parseJsonUnknown } from '@shared/unknown-value.ts'

let activated: ActivatedPackTools | null = null
let buffer = ''
const activeInvocations = new Map<number, AbortController>()

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
        const result = await activated.invoke(
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
    case 'shutdown': {
      for (const controller of activeInvocations.values()) controller.abort()
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
