# @copse/remote-protocol

The wire protocol between a Copse Mac and the Copse names API (`https://api.copse.dev`): device
keys, signed requests, request and response bodies, label grants and the relay tunnel handshake.
It depends only on `zod` and WebCrypto, so the same files run in the Electron main process, in
Node and in the service.

## Do not change the formats

The live service verifies exactly these strings and schemas. The files were copied
byte-identical from `copse-dev/remote-service` `protocol/src/`, which still carries its own copy
until it moves onto this package. Until then:

- a change here must land in both places, with the service deployed first;
- the six protocol files are excluded from formatting (`.prettierignore`) so a reformat cannot
  make the two copies diverge.

`protocol.test.ts` pins the canonical request string, the nonce and thumbprint patterns and the
schemas, so an accidental format change fails here before it fails against the service.

## What's in it

- **`encoding.ts`**: base64url without padding (the only binary encoding on the wire) and
  SHA-256.
- **`keys.ts`**: ECDSA P-256 device keys as public JWKs, named by their RFC 7638 thumbprint;
  IEEE P1363 signatures.
- **`signing.ts`**: the `copse-key`, `copse-timestamp`, `copse-nonce` and `copse-signature`
  headers over `copse-request-v1\nMETHOD\npath?query\ntimestamp\nnonce\nbase64url(sha256(body))`.
  The service allows five minutes of clock skew and refuses a reused nonce, so a retry signs
  again.
- **`messages.ts`**: bodies for `/v1/register`, `/v1/address`, `/v1/certificate` and
  `/v1/device`, plus the shell endpoints.
- **`grant.ts`** and **`tunnel.ts`**: label grants and the relay handshake for phase 2. Nothing
  in the app uses them yet.

The app's client lives in `src/main/services/remote-names/`; see
[`docs/remote-access.md`](../../docs/remote-access.md).
