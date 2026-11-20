'use strict'
// Loopback-to-loopback TCP forward for the e2e stub `ssh` (./ssh). OpenSSH's
// `-O forward -L 127.0.0.1:L:127.0.0.1:R` makes the master listen on L and
// carry each connection to R on the remote; with the "remote" being this
// machine, that is a plain proxy. Writes its pid to `readyFile` once listening.
const net = require('node:net')
const fs = require('node:fs')

const [localPort, remotePort, readyFile] = process.argv.slice(2)
const server = net.createServer((client) => {
  const upstream = net.connect(Number(remotePort), '127.0.0.1')
  client.pipe(upstream).pipe(client)
  const end = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', end)
  upstream.on('error', end)
})
server.listen(Number(localPort), '127.0.0.1', () => {
  fs.writeFileSync(readyFile, String(process.pid))
})
