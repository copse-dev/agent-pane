'use strict'

/**
 * Outbound network guard for Node code: Electron's main process under e2e
 * (installed by bootstrap.cjs before the app loads) and unit test processes
 * (installed by scripts/lib/unit-network-guard.mts).
 *
 * It patches the Node dependency boundaries every outbound byte crosses —
 * `net.Socket#connect` (http, https, tls, undici/fetch, raw net), `dns`
 * lookups and resolvers, and `dgram` sends — so nothing in product code
 * changes. Loopback (localhost, 127/8, ::1, the unspecified address) and
 * Unix/pipe sockets pass. Anything else is appended to a JSONL ledger with
 * the process and a trimmed stack; in `enforce` mode it is also refused with
 * an ECONNREFUSED/ENOTFOUND error before any packet leaves the process.
 *
 * Chromium traffic (renderer, webviews, Electron `net`) does not use these
 * modules: wdio.conf.ts routes it through the guard proxy in
 * tests/e2e/helpers/network-guard.ts, which writes to the same ledger.
 */

const fs = require('node:fs')
const net = require('node:net')
const dns = require('node:dns')
const dgram = require('node:dgram')

const GUARD_TAG = '[e2e-network-guard]'

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** True for addresses and names that never leave this machine. */
function isLoopbackHost(rawHost) {
  if (rawHost === undefined || rawHost === null || rawHost === '') return true
  const host = stripBrackets(String(rawHost).trim().toLowerCase()).replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  const family = net.isIP(host)
  if (family === 4) return host.startsWith('127.') || host === '0.0.0.0'
  if (family === 6) {
    if (host === '::1' || host === '::') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    return mapped !== null && isLoopbackHost(mapped[1])
  }
  return false
}

/** mDNS (Bonjour) queries: 224.0.0.251 or ff02::fb on port 5353. */
function isMulticastDns(host, port) {
  const address = stripBrackets(String(host).toLowerCase()).split('%')[0]
  return Number(port) === 5353 && (address === '224.0.0.251' || address === 'ff02::fb')
}

function trimmedStack() {
  const lines = (new Error().stack ?? '').split('\n').slice(1)
  return lines
    .map((line) => line.trim())
    .filter((line) => !line.includes('network-guard.cjs') && !line.includes('node:internal'))
    .slice(0, 10)
}

/**
 * @param {{
 *   mode: 'log' | 'enforce',
 *   ledgerPath: string,
 *   processLabel: string,
 *   unresolvableSuffixes?: string[],
 *   fetchStub?: (url: URL, method: string, headers: Headers) => Response | undefined,
 *   silentMulticast?: boolean,
 *   onAttempt?: (record: Record<string, unknown>) => void,
 * }} options
 */
function install(options) {
  if (globalThis.__copseNetworkGuardInstalled) return
  globalThis.__copseNetworkGuardInstalled = true
  const enforce = options.mode === 'enforce'

  const record = (kind, host, port, detail) => {
    const entry = {
      at: new Date().toISOString(),
      source: 'node',
      process: options.processLabel,
      pid: process.pid,
      kind,
      host: String(host),
      port: port === undefined || port === null ? null : Number(port),
      blocked: enforce,
      ...(detail ? { detail } : {}),
      stack: trimmedStack(),
    }
    try {
      fs.appendFileSync(options.ledgerPath, `${JSON.stringify(entry)}\n`)
    } catch {
      // The ledger lives in a disposable scratch dir; a missing one only loses evidence.
    }
    options.onAttempt?.(entry)
  }

  const refusal = (kind, host, port, code) => {
    const target = port === undefined || port === null ? String(host) : `${host}:${port}`
    const error = new Error(
      `${GUARD_TAG} ${kind} to ${target} refused: tests may only reach loopback ` +
        '(docs/testing-strategy.md#outbound-network-guard)',
    )
    error.code = code
    error.hostname = String(host)
    return error
  }

  // --- net / tls / http(s) / undici: every TCP client ends in Socket#connect.
  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let first = args[0]
    // net.connect() hands the socket its already-normalized [options, cb] array.
    if (Array.isArray(first)) first = first[0]
    let host
    let port
    if (first !== null && typeof first === 'object') {
      if (typeof first.path === 'string' && first.path !== '') {
        return originalConnect.apply(this, args)
      }
      host = first.host ?? first.hostname
      port = first.port
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      // connect(path[, cb]) — a Unix socket or Windows pipe.
      return originalConnect.apply(this, args)
    } else {
      port = first
      host = typeof args[1] === 'string' ? args[1] : undefined
    }
    if (isLoopbackHost(host)) return originalConnect.apply(this, args)
    record('connect', host, port)
    if (!enforce) return originalConnect.apply(this, args)
    const error = refusal('connect', host, port, 'ECONNREFUSED')
    process.nextTick(() => this.destroy(error))
    return this
  }

  const fetchMethod = (input, init) =>
    String(
      init?.method ?? (input instanceof globalThis.Request ? input.method : 'GET'),
    ).toUpperCase()
  const fetchHeaders = (input, init) =>
    new globalThis.Headers(
      init?.headers ?? (input instanceof globalThis.Request ? input.headers : undefined),
    )

  // --- fetch (undici): checked at the call so the record carries the caller's
  // stack; undici opens its socket later, off that stack.
  const originalFetch = globalThis.fetch
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      let url
      try {
        url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      } catch {
        return originalFetch.call(this, input, init)
      }
      if (!/^(https?|wss?):$/.test(url.protocol) || isLoopbackHost(url.hostname)) {
        return originalFetch.call(this, input, init)
      }
      const stub = options.fetchStub?.(url, fetchMethod(input, init), fetchHeaders(input, init))
      if (stub) return Promise.resolve(stub)
      const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)
      record(
        'fetch',
        url.hostname,
        port,
        `${fetchMethod(input, init)} ${url.origin}${url.pathname}`,
      )
      if (!enforce) return originalFetch.call(this, input, init)
      const cause = refusal('fetch', url.hostname, port, 'ECONNREFUSED')
      return Promise.reject(new TypeError('fetch failed', { cause }))
    }
  }

  // --- dns: direct lookups and resolver queries also leak names off the host.
  // A lookup of an IP literal never leaves the process (listen() on a LAN address does one).
  const passes = (hostname) => isLoopbackHost(hostname) || net.isIP(String(hostname)) !== 0
  // Names the e2e stand-ins issue (the fake names API's `lan.<label>.u.copse.me`) have no
  // real record; answer as unresolved instead of asking a public resolver.
  const unresolvable = (hostname) =>
    (options.unresolvableSuffixes ?? []).some((suffix) =>
      String(hostname).toLowerCase().replace(/\.$/, '').endsWith(suffix),
    )
  const unresolved = (hostname) => {
    const error = new Error(`${GUARD_TAG} ${hostname} is an e2e stand-in name with no DNS record`)
    error.code = 'ENOTFOUND'
    error.hostname = String(hostname)
    return error
  }
  const wrapCallbackLookup = (original, kind) =>
    function guardedLookup(hostname, ...rest) {
      if (passes(hostname)) return original.call(this, hostname, ...rest)
      if (unresolvable(hostname)) {
        const callback = rest.findLast((value) => typeof value === 'function')
        const error = unresolved(hostname)
        if (callback) process.nextTick(() => callback(error))
        return undefined
      }
      record(kind, hostname, null)
      if (!enforce) return original.call(this, hostname, ...rest)
      const callback = rest.findLast((value) => typeof value === 'function')
      const error = refusal(kind, hostname, null, 'ENOTFOUND')
      if (callback) process.nextTick(() => callback(error))
      return undefined
    }
  const wrapPromiseLookup = (original, kind) =>
    function guardedPromiseLookup(hostname, ...rest) {
      if (passes(hostname)) return original.call(this, hostname, ...rest)
      if (unresolvable(hostname)) {
        return Promise.reject(unresolved(hostname))
      }
      record(kind, hostname, null)
      if (!enforce) return original.call(this, hostname, ...rest)
      return Promise.reject(refusal(kind, hostname, null, 'ENOTFOUND'))
    }
  const resolverMethods = [
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
  ]
  const patch = (target, name, wrap, kind) => {
    if (typeof target?.[name] === 'function') target[name] = wrap(target[name], kind)
  }
  patch(dns, 'lookup', wrapCallbackLookup, 'dns.lookup')
  patch(dns, 'lookupService', wrapCallbackLookup, 'dns.lookupService')
  patch(dns.promises, 'lookup', wrapPromiseLookup, 'dns.lookup')
  patch(dns.promises, 'lookupService', wrapPromiseLookup, 'dns.lookupService')
  for (const name of resolverMethods) {
    patch(dns, name, wrapCallbackLookup, `dns.${name}`)
    patch(dns.Resolver?.prototype, name, wrapCallbackLookup, `dns.${name}`)
    patch(dns.promises, name, wrapPromiseLookup, `dns.${name}`)
    patch(dns.promises.Resolver?.prototype, name, wrapPromiseLookup, `dns.${name}`)
  }

  // --- dgram: UDP (mDNS, STUN, raw DNS) bypasses both of the above.
  const originalSend = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function guardedSend(...args) {
    // send(msg[, offset, length], port[, address][, callback]); a connected socket omits both.
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined
    const params = callback ? args.slice(0, -1) : args
    const address = typeof params.at(-1) === 'string' ? params.at(-1) : undefined
    const port = typeof params.at(-1) === 'number' ? params.at(-1) : params.at(-2)
    let remote
    try {
      remote = this.remoteAddress()
    } catch {
      remote = undefined
    }
    const host = address ?? remote?.address
    if (host === undefined || isLoopbackHost(host)) return originalSend.apply(this, args)
    if (options.silentMulticast && isMulticastDns(host, port)) {
      // An empty LAN: the query goes nowhere and nobody answers.
      if (callback) process.nextTick(() => callback(null, 0))
      return undefined
    }
    record('udp', host, typeof port === 'number' ? port : remote?.port)
    if (!enforce) return originalSend.apply(this, args)
    const error = refusal('udp', host, port, 'ECONNREFUSED')
    if (callback) process.nextTick(() => callback(error))
    else process.nextTick(() => this.emit('error', error))
    return undefined
  }
  const originalUdpConnect = dgram.Socket.prototype.connect
  dgram.Socket.prototype.connect = function guardedUdpConnect(port, address, ...rest) {
    const host = typeof address === 'string' ? address : undefined
    if (host !== undefined && !isLoopbackHost(host)) record('udp.connect', host, port)
    return originalUdpConnect.call(this, port, address, ...rest)
  }

  // `import { lookup } from 'node:dns'` binds at link time; publish the patches there too.
  require('node:module').syncBuiltinESMExports()
}

/**
 * e2e provider keys are fake, so every provider rejects them. Answer the
 * key-validation probes (`GET …/models`, OpenRouter's `GET /api/v1/key`, sent
 * with a key) with the 401 the real services return, without leaving the host.
 */
function fakeKeyRejection(url, method, headers) {
  if (method !== 'GET') return undefined
  if (!headers.has('authorization') && !headers.has('x-api-key')) return undefined
  if (!/\/models$/.test(url.pathname) && url.pathname !== '/api/v1/key') return undefined
  return new globalThis.Response(
    JSON.stringify({ error: { message: `${GUARD_TAG} e2e stand-in: this provider key is fake` } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )
}

module.exports = { install, isLoopbackHost, fakeKeyRejection, GUARD_TAG }
