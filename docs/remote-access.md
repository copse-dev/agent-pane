# Remote access: a trusted name for your Mac

**Status: invite-only beta.** Phase 1: a Mac can get a publicly trusted name for its
[Mobile Companion](plans/mobile-web-experience.md), so a phone on the same network opens it with
no certificate to install. Phase 2: the Mac can also be reached from outside its network through
the Copse relay, with phones added at `copse.me` ([below](#from-anywhere-the-relay-and-copseme)).
Phase 2 is off by default and works once the relay (`relay.copse.dev`) and the `copse.me` shell
are live.

## What it does

Settings → Experimental → Mobile Companion → **Trusted address** takes an invite code. Redeeming
it registers this Mac with the Copse names service (`https://api.copse.dev`), which assigns a
random twelve-character label. From then on Copse:

- keeps `lan.<label>.u.copse.me` pointed at the private IPv4 address the Mobile Companion is
  bound to, sending it again only when that address changes;
- holds a certificate for `*.<label>.u.copse.me`, issued by Let's Encrypt through the names service,
  and renews it before it lapses (certificates last about six days);
- serves the Mobile Companion as `https://lan.<label>.u.copse.me:42773`, beside its existing local
  address `https://<LAN IP>:42773`.

Because the certificate is publicly trusted, the phone's browser verifies the connection itself.
Pairing over the name grants control on the desktop approval alone; the local-root acknowledgement
the LAN-IP path needs does not apply (this supersedes decision 11 of the LAN plan for that path).

## From anywhere: the relay and copse.me

Trusted address → **Reach this Mac from anywhere through copse.me** turns it on; it stays off
until chosen, and Remove name turns it off again. While it is on, Mobile Companion is running and
the name is active with a valid certificate, Copse holds one outbound TLS connection to
`relay.copse.dev`, and phones added at `copse.me` reach the Mac as `web.<label>.u.copse.me`.

### The tunnel

1. Copse opens TLS to the relay, verified against the relay's own publicly trusted certificate.
2. The relay sends a random challenge; Copse signs `copse-tunnel-v1`, the label, the challenge and
   a timestamp with the device key, and the relay verifies it against the key the names service
   holds for the label (five minutes of clock skew).
3. Copse then serves HTTP/2 on the connection with the relay as the client. Each browser
   connection is one `CONNECT` stream for `web.<label>.u.copse.me:443` that carries the address
   the relay saw (`copse-client-ip`) and, as its body, the browser's TLS bytes from the
   ClientHello on. Copse refuses any other stream.
4. Copse completes each browser's TLS with its own `*.<label>.u.copse.me` certificate, whose key
   the relay and the names service never see, and serves the Mobile Companion over it.

Copse pings the relay every 25 seconds and closes a tunnel that misses a ping; it reconnects
after a drop or a refusal from one second, doubling to five minutes with jitter. A newer tunnel
for a label replaces an older one at the relay. Settings shows the tunnel's state and why the last
attempt ended. The formats are `packages/remote-protocol/src/tunnel.ts`; the client is
`src/main/services/remote-names/relay-tunnel.ts`, and relayed connections are served by
`src/main/services/mobile/relay-ingress.ts`.

### Who can reach the Mac, and who can act on it

Two credentials, held apart:

- **Reach** is the relay's gate. It admits a browser only from a source address that a
  `copse.me` account added to this Mac refreshed in the last few minutes. An account is added
  with a grant: **Add this Mac at copse.me** shows a QR for `https://copse.me/add#g=<grant>`, a
  label grant signed by the device key, valid for ten minutes and redeemed once by the names API.
  The grant sits in the URL fragment, so it never reaches a server log.
- **Control** stays with the Mac. A relayed request must name exactly `web.<label>.u.copse.me`
  in `Host` (and its origin in `Origin`); there is no private-peer check, because the peer is the
  relay. Every route past pairing needs a device token, and pairing needs the desktop's approval:
  the pairing banner says the phone came through copse.me from outside this network. Failed-token
  limits and pairing results are keyed to the address the relay reported.

The usual journey, at the desk: get a name, turn the relay on, choose Add this Mac at copse.me,
scan the QR, sign in at `copse.me` with a passkey and add the Mac. The shell frames the Mac's page;
pair the phone there and approve it on the desktop. Away from the desk, open `copse.me`.

Device tokens belong to an origin: a phone paired at the local address or at `lan.` pairs once
more under `web.`, and a phone that clears the site's data pairs again.

### Framing and what crosses into the shell

Responses under a trusted name (`lan.` or `web.`) send `frame-ancestors https://copse.me` and no
`X-Frame-Options`, so only the shell may frame them; the bare-IP address still refuses all
framing. When the shell frames the page, the page posts one message to `https://copse.me`:
`{type: 'copse-status', v: 1, state, counts: {attention, running}}`. It carries no thread names,
transcripts, diffs or file names, and the page never reads messages from the shell. The shell
reads the message's arrival as proof that the frame reached the Mac.

### What the relay sees

| The relay sees                                                                  | Never visible to the relay                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| The label, the tunnel's signature, and the Mac's public IP and connection times | The device key and the TLS key                  |
| Each phone's public IP, when it connects, and how many bytes pass each way      | Anything inside a browser's TLS                 |
| The server name in each browser's ClientHello (`web.<label>.u.copse.me`)        | Device tokens, threads, messages, pairing codes |

The `copse.me` shell keeps an account's passkey, the labels it added and their reach refreshes;
it never holds a device token or session content. The Mac never sends anything to the shell's
servers; the status message stays in the phone's browser.

### Limits and known gaps

- The Mac must be awake with Copse open; the relay cannot wake it.
- Inside the shell, the frame tries `https://lan.<label>.u.copse.me:42773/` first, and falls back
  to `web.` through the relay if the page has not reported within four seconds. Chrome may first
  ask to allow access to the local network; declining sends the shell straight to the relay.
- Content-free push (`POST /v1/attention`, "Copse needs your attention") exists on the service;
  Copse does not send it yet.
- `COPSE_RELAY` (`host[:port]`) in the environment Copse starts with points the tunnel at another
  relay deployment, beside `COPSE_NAMES_API_URL`. Like it, it is not a Settings field. A wrong
  relay cannot read relayed traffic, since browsers' TLS ends on the Mac, but it could hold the
  tunnel and drop connections.

## What the names service sees, and what it never sees

| The service receives                                                      | Never leaves the Mac                              |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| The device's public key, and the invite it redeemed                       | The device's private key (sealed in the keychain) |
| The Mac's private LAN address (RFC 1918 only; the service refuses others) | The TLS private key for the certificate           |
| Certificate signing requests: a fresh public key and the label's wildcard | Threads, messages, files, pairing tokens          |
| Request times and the public IP each request came from                    | Anything a phone sends to or reads from the Mac   |

Phones talk to the Mac directly over the local network; nothing they exchange passes through the
service. The service answers Let's Encrypt's DNS-01 challenge itself, so the Mac never handles ACME
account keys or DNS credentials.

## How the Mac authenticates

The Mac generates one ECDSA P-256 device key at its first registration, keeps the private half
sealed by the OS keyring cipher, and is known to the service by the key's RFC 7638 thumbprint.
Every request carries `copse-key`, `copse-timestamp`, `copse-nonce` and a signature over
`copse-request-v1`, the method, the path and query, the timestamp, the nonce and the SHA-256 of
the body. The service accepts five minutes of clock skew and refuses a nonce it has seen, so a
retry is always signed again. The formats live in
[`packages/remote-protocol`](../packages/remote-protocol/README.md); the client is
`src/main/services/remote-names/`.

Copse also checks what comes back: it serves only `lan.<label>.u.copse.me` for the label it was
given, and installs a certificate only when the chain names that label's wildcard, matches the key
the Mac just generated and is currently valid.

## Lifecycle and limits

- **Renewal** happens inside the service's ARI renewal window, at a random point so Macs do not
  renew in lockstep, or at two thirds of the lifetime when the service gives no window. A Mac that
  sleeps through the window renews within an hour of waking.
- **Six certificate orders per label per day.** Copse counts orders locally, before sending them,
  and backs off on errors (from one minute, doubling, up to six hours, and at least as long as
  `Retry-After`).
- **Sixty address updates per label per hour.** Copse sends one only when the bound address
  changes.
- **Dormancy.** A label not renewed for 30 days goes dormant and stops resolving; after 90 days it
  is retired and never reused. Renewal continues while Copse is open, even with the Mobile
  Companion turned off.
- **Remove name** deletes the device's records from the service at once and forgets the device key,
  the registration and the certificate on the Mac. A later registration gets a new key and label.

State lives in `~/.copse/names/` (0700): `device.json` (the sealed device key, the registration,
the last address the service accepted, recent order times and certificate dates), and
`tls-key.pem` / `tls-chain.pem` (0600). It is kept apart from `config.json`, which renderer
settings writes can reach.

## Networks whose DNS drops the name

Routers with DNS-rebind protection (dnsmasq's `stop-dns-rebind`, Pi-hole, OpenWrt and many ISP
routers) discard public answers that point at private addresses, so `lan.<label>.u.copse.me` does
not resolve there. Copse resolves the name with this Mac's resolver after each address change and
says so in Settings when the answer is missing or wrong, leading with the local address and its
QR instead. Fixes, in order: allow `u.copse.me` in the router's rebind settings, or use the local
address, which still needs the Copse Local Root on the phone. A phone using its own DNS (for
example a VPN or private DNS) may resolve the name even when the Mac cannot, and the reverse.

## Pointing a Mac at another deployment

`COPSE_NAMES_API_URL` in the environment Copse starts with replaces `https://api.copse.dev` for a
**new** registration (a staging or self-hosted deployment of the service). An existing registration
keeps the service it registered with. It is deliberately not a Settings field: a signed request is
replayable for its five-minute window, so the destination of signed requests should not be
writable from the renderer. The e2e suite points it at a loopback stand-in.

## Trust in the names service

The service is a new party Copse trusts, scoped to one label per Mac. See
[the threat model](threat-model.md#threat-scenarios) (scenario 11). In short, a compromised or
mistaken service could:

- issue a certificate for `*.<label>.u.copse.me` with a key it holds, and point
  `lan.<label>.u.copse.me` at another **private** address. Together, and with a device of its own
  on the same local network, that could impersonate the Mac to a paired phone. Every certificate
  for the name is logged in Certificate Transparency, so misissuance is publicly observable;
- stop renewing or resolving the name, which leaves the local address working;
- learn when the Mac is online and which private address it uses.

It cannot read or alter anything between a phone and the Mac when its records are honest, and it
never holds a key that decrypts Mobile Companion traffic.

The relay and the `copse.me` shell are further parties, covered by scenario 12 of the threat
model: the relay can deny service, see connection metadata and hand strangers' connections to the
Mac's page, which still needs a device token or the desktop's approval; the shell can show a fake
page around the frame, but holds nothing that acts on the Mac.
