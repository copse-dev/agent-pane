# Remote access: a trusted name for your Mac

**Status: phase 1, invite-only beta.** A Mac can get a publicly trusted name for its
[Mobile Companion](plans/mobile-web-experience.md), so a phone on the same network opens it with
no certificate to install. Reaching the Mac from outside its network (a relay, and pairing through
`copse.me`) is phase 2 and not built.

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
