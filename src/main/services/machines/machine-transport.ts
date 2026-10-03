import { request } from 'node:https'
import { TLSSocket } from 'node:tls'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { machineEndpointSchema } from '@shared/machines.ts'

export const machineInvitationSchema = machineEndpointSchema.extend({
  version: z.literal(1),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
})
export function decodeMachineInvitation(code: string): z.infer<typeof machineInvitationSchema> {
  if (!code.startsWith('copse-machine1-') || code.length > 2048)
    throw new Error('Paste the invitation from Settings → Machines on the other computer.')
  const parsed = safeJsonParse(
    Buffer.from(code.slice(15), 'base64url').toString('utf8'),
    decodeWithSchema(machineInvitationSchema),
  )
  if (!parsed) throw new Error('Invalid machine invitation.')
  return parsed
}

export class MachineConnectionError extends Error {
  readonly status: number
  constructor(message: string, status = 503) {
    super(message)
    this.status = status
  }
}

/** Credentials and request data are sent only after verifying the paired certificate. */
export function machineRequest(
  endpoint: z.infer<typeof machineEndpointSchema>,
  path: '/pair' | '/models',
  body: object,
  options: { token?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: endpoint.address,
        port: endpoint.port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        agent: false,
        signal: options.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 4 * 1024 * 1024)
            response.destroy(new Error('Machine response exceeded its limit.'))
          else chunks.push(chunk)
        })
        response.once('error', () => {
          reject(
            new MachineConnectionError(
              'Connection interrupted. Try the call again when the machine is available.',
            ),
          )
        })
        response.once('end', () => {
          if (response.statusCode !== 200) {
            reject(
              new MachineConnectionError(
                response.statusCode === 401
                  ? 'Pairing was revoked. Connect this machine again.'
                  : 'The machine could not complete this request. Check its shared model.',
                response.statusCode,
              ),
            )
            return
          }
          const result = safeJsonParse(
            Buffer.concat(chunks).toString('utf8'),
            decodeWithSchema(z.record(z.string(), z.unknown())),
          )
          if (!result) reject(new MachineConnectionError('Invalid machine response.'))
          else resolve(result)
        })
      },
    )
    const timeout = setTimeout(
      () => req.destroy(new Error('Machine timed out.')),
      options.timeoutMs ?? 5000,
    )
    req.once('close', () => {
      clearTimeout(timeout)
    })
    req.once('error', (error) => {
      reject(
        error instanceof MachineConnectionError
          ? error
          : new MachineConnectionError('Machine unavailable. It will reconnect automatically.'),
      )
    })
    req.once('socket', (socket) => {
      if (!(socket instanceof TLSSocket)) {
        req.destroy(new MachineConnectionError('Encrypted connection required.'))
        return
      }
      socket.once('secureConnect', () => {
        if (socket.getPeerCertificate().fingerprint256 !== endpoint.fingerprint) {
          req.destroy(
            new MachineConnectionError('Machine identity changed. Remove it and pair again.', 401),
          )
          return
        }
        req.end(JSON.stringify(body))
      })
    })
  })
}
