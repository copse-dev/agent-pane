import { createServer, createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'

/** A synthetic host service, with a positive host connection before probing the guest. */
export async function startDesktopHostCanary(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const marker = randomUUID()
  const server = createServer((socket) => {
    socket.end(marker)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Host canary service did not bind loopback')
  }
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  try {
    const observed = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: address.port })
      let text = ''
      socket.setTimeout(2000, () => {
        socket.destroy(new Error('Host positive control timed out'))
      })
      socket.on('error', reject)
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        text += chunk
      })
      socket.on('end', () => {
        socket.destroy()
        resolve(text)
      })
    })
    if (observed !== marker) throw new Error('Host service positive control failed')
    return { port: address.port, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Only the synthetic canary path and port cross the boundary; its contents never do. */
export function desktopContainmentCommand(canary: string, hostPort: number): string {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)
    throw new Error('Invalid canary port')
  const script = `const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict');assert.throws(()=>fs.readFileSync(${JSON.stringify(canary)}),{code:'ENOENT'});const path='/tmp/desktop-containment-control';fs.writeFileSync(path,'guest-owned');assert.equal(fs.readFileSync(path,'utf8'),'guest-owned');const socket=net.createConnection({host:'127.0.0.1',port:${String(hostPort)}});socket.setTimeout(2000,()=>socket.destroy(new Error('Network timeout is not a passing denial')));socket.once('connect',()=>{socket.destroy();throw new Error('Host service was reachable')});socket.once('error',error=>{assert.equal(error.code,'ECONNREFUSED');console.log('desktop-containment:passed')})`
  return "node -e '" + script.replaceAll("'", "'\\''") + "'"
}
