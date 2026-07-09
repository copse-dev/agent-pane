import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSs,
  parseLsof,
  parseNetstat,
  splitAddrPort,
  dedupePorts,
  scanCandidates,
} from './port-scan.ts'

describe('splitAddrPort', () => {
  it('parses IPv4 host:port', () => {
    assert.deepEqual(splitAddrPort('127.0.0.1:5173'), { address: '127.0.0.1', port: 5173 })
  })

  it('takes the last colon and strips brackets for IPv6', () => {
    assert.deepEqual(splitAddrPort('[::1]:3000'), { address: '::1', port: 3000 })
    assert.deepEqual(splitAddrPort('[::]:22'), { address: '::', port: 22 })
  })

  it('handles a wildcard address', () => {
    assert.deepEqual(splitAddrPort('*:8080'), { address: '*', port: 8080 })
  })

  it('rejects a non-numeric or out-of-range port', () => {
    assert.equal(splitAddrPort('0.0.0.0:*'), null)
    assert.equal(splitAddrPort('localhost:http'), null)
    assert.equal(splitAddrPort('nocolon'), null)
    assert.equal(splitAddrPort('1.2.3.4:70000'), null)
  })
})

describe('parseSs', () => {
  it('extracts port, pid and command from ss -tlnpH output', () => {
    const out = [
      'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=12345,fd=23))',
      'LISTEN 0      128             [::]:22            [::]:*     users:(("sshd",pid=800,fd=3))',
      'LISTEN 0      511        127.0.0.1:6379       0.0.0.0:*    users:(("redis-server",pid=999,fd=6))',
    ].join('\n')
    assert.deepEqual(parseSs(out), [
      { port: 3000, pid: 12345, command: 'node', address: '0.0.0.0' },
      { port: 22, pid: 800, command: 'sshd', address: '::' },
      { port: 6379, pid: 999, command: 'redis-server', address: '127.0.0.1' },
    ])
  })

  it('yields a null pid when process info is absent', () => {
    const out = 'LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*'
    assert.deepEqual(parseSs(out), [
      { port: 5432, pid: null, command: '', address: '0.0.0.0' },
    ])
  })

  it('ignores blank and non-LISTEN lines', () => {
    assert.deepEqual(parseSs('\n  \nESTAB 0 0 127.0.0.1:1 127.0.0.1:2\n'), [])
  })
})

describe('parseLsof', () => {
  it('groups n-lines under the preceding p/c and emits one port each', () => {
    const out = ['p12345', 'cnode', 'n*:3000', 'n[::1]:3000', 'p999', 'credis-server', 'n127.0.0.1:6379'].join(
      '\n',
    )
    assert.deepEqual(parseLsof(out), [
      { port: 3000, pid: 12345, command: 'node', address: '*' },
      { port: 3000, pid: 12345, command: 'node', address: '::1' },
      { port: 6379, pid: 999, command: 'redis-server', address: '127.0.0.1' },
    ])
  })
})

describe('parseNetstat', () => {
  it('extracts port and trailing pid from LISTENING rows', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345',
      '  TCP    [::]:22                [::]:0                 LISTENING       800',
      '  TCP    127.0.0.1:6379         0.0.0.0:0              ESTABLISHED     999',
    ].join('\n')
    assert.deepEqual(parseNetstat(out), [
      { port: 3000, pid: 12345, command: '', address: '0.0.0.0' },
      { port: 22, pid: 800, command: '', address: '::' },
    ])
  })
})

describe('scanCandidates', () => {
  it('falls back across tools on Linux (ss may be absent, lsof present)', () => {
    assert.deepEqual(
      scanCandidates('linux').map((p) => p.file),
      ['ss', 'lsof', 'netstat'],
    )
  })

  it('uses lsof first on macOS and netstat only on Windows', () => {
    assert.deepEqual(
      scanCandidates('darwin').map((p) => p.file),
      ['lsof', 'netstat'],
    )
    assert.deepEqual(
      scanCandidates('win32').map((p) => p.file),
      ['netstat'],
    )
  })
})

describe('dedupePorts', () => {
  it('collapses the same port+pid bound on IPv4 and IPv6', () => {
    const deduped = dedupePorts([
      { port: 3000, pid: 12345, command: 'node', address: '*' },
      { port: 3000, pid: 12345, command: 'node', address: '::1' },
      { port: 3000, pid: 777, command: 'other', address: '0.0.0.0' },
    ])
    assert.deepEqual(deduped, [
      { port: 3000, pid: 12345, command: 'node', address: '*' },
      { port: 3000, pid: 777, command: 'other', address: '0.0.0.0' },
    ])
  })
})
