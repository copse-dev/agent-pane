# Copse saved-secret vault helper

Supported signed macOS releases automatically enroll new and legacy profiles.
Normal startup silently opens saved API/SSH/VNC credentials. Settings → Storage
can require Touch ID/macOS authentication at startup. Recovery-key export,
restoration and changing that setting always require fresh native authentication.
An unlocked session survives sleep and screen lock until quit.

## Native boundary

Apple CryptoKit HPKE (`P256_SHA256_AES_GCM_256`) protects the profile data key
with a Secure Enclave P-256 key. `.privateKeyUsage` is always set;
`.userPresence` is added when startup authentication is required. The private
scalar is non-exportable. JavaScript still holds the unlocked profile data key.

One login Keychain item (`Copse Device Vault Profiles`, account = profile ID plus
key ID) owns the active opaque key representation, device envelope and policy.
Changing policy creates and verifies a new device key, then atomically replaces
that item. Native state selects the active envelope, even if the app presents an
older manifest. Main verifies the unchanged data key before repairing its metadata
mirror after interruption. Existing always-authenticated vaults retain their
policy and are adopted from the older per-device Keychain item after successful
unlock. Saved records and recovery keys do not change when the policy changes.

The main process and helper exchange bounded requests over inherited socket fd 3.
Main verifies the helper's pinned Developer ID and live signature. Native checks
use the kernel audit token. Silent access requires the exact signed release app,
a hardened runtime, restrictive main-process entitlements and the signed
`CopseVaultSilentAccess` marker, with full resource verification. Packaging pairs
that marker with fuses disabling RunAsNode, Node options and the Node inspector,
and requiring the integrity-checked app archive. Packaged debugger launch options
are rejected before vault initialization. Workers use a separate Node interpreter
and identity. A development caller requires explicit approval and fresh native
authentication; startup never automatically enrolls a development profile.

Export authentication is independent of the startup policy and is performed in
a fresh helper process/context. Native verifies the original manifest HMAC before
revealing a recovery key or installing a recovered key. Wrong recovery keys cannot
poison the device state or prevent a later correct retry. Key reveal/import stays
in native UI; clipboard copying is manual and may be retained by other software.

Mutable buffers are cleared where practical; Swift/JavaScript immutable strings
cannot be guaranteed erased. Quit clears the session and managed consumers. It
cannot revoke credentials already supplied to external processes or protect an
already compromised authorized application.

## Build

On a Mac with Xcode command-line tools and the product Developer ID identity:

```sh
pnpm run prepare:vault --identity 'Developer ID Application: … (VRQQV62MK3)'
pnpm run prepare:node
pnpm run build:release
```

`prepare:vault` compiles `main.swift` plus `policy.swift`, signs the helper as
`dev.copse.vault`, and prepares the synthetic probe. Binaries/signing credentials
are not committed. Ordinary builds reuse a matching signed helper. Development
builds omit a missing/stale helper; release builds fail until it is prepared.
The helper is copied unchanged outside app.asar and excluded from app re-signing.
`prepare:node` verifies official checksums for the `.nvmrc` Node version; packaging
signs the separate worker runtime and retains only the target architecture.

## Validation

The earlier signed persistent HPKE round trip passed on the development Mac on
2026-09-11. Direct permanent Security-framework keys failed with `-34018`; that
mechanism is not used. The current native source type-checks without signing.

Automated coverage includes native operation policy, Swift verification of
JavaScript manifest MACs (old manifests and both authentication settings), wrong
recovery keys, actual fuse modification/readback on a disposable Electron binary,
automatic migration, source preservation on failure, native/app metadata repair,
settings controls and unavailable-helper Electron IPC. These checks do not invoke
Keychain authentication or execute the native vault helper.

Before release, use a throwaway profile and synthetic credentials to verify:

- Signed packaged caller acceptance; unsigned, altered and generic-runtime callers
  must never obtain silent access. Check native addons and every Node worker.
- New and existing profiles enroll automatically without an extra Copse prompt.
  Unreadable legacy secrets or another active writer leave the original intact.
- Standard cold startup is silent; opt-in startup authentication prompts. Cancel
  leaves the app locked without a retry loop. Explicit Unlock can retry.
- Export always authenticates, in both modes and while already unlocked. Cancel
  every native stage and verify that no recovery key is exposed before auth.
- Toggle both ways and interrupt between native commit and manifest update. Old
  profile copies must use the current native policy. Recovery keys stay valid.
- Quit clears access. Sleep and screen lock retain the session without restarting.
  Profile-volume loss quits. Test reboot, helper update and each architecture.
- Restore on a replacement Mac; wrong keys leave existing native/profile state
  intact and a later correct retry works. Never capture recovery values in logs.

These interactive and packaged acceptance checks remain pending. The user asked
for no further fingerprint/password approvals, so no helper re-signing or native
authentication is attempted during unattended work.
