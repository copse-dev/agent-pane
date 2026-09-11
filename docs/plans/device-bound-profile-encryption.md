# On-device secret encryption and optional recovery backup

Status: implemented in the working branch; native release acceptance pending. Scoped from
[#2652](https://github.com/copse-dev/agent-pane/pull/2652) on 2026-09-11.
Code baseline: `origin/main` at `f5f1764c2`. The implementation adds the native
helper, encrypted stores, optional recovery export/import, migration and settings.
Hardware acceptance is still pending; this document does not certify production readiness.

## Implementation decisions and validation record

- The selected primitive is Apple CryptoKit HPKE, P-256 / HKDF-SHA256 / AES-GCM-256.
  Direct permanent Security-framework keys failed with `-34018` (missing entitlement).
  The helper instead persists CryptoKit's opaque hardware-encrypted Secure Enclave
  key representation in an ordinary login Keychain item under its stable signing
  identity. This is not an export of the private scalar or profile data key.
- A signed synthetic probe passed both an ephemeral operation and persistent
  fresh-process HPKE unwrap using that representation. Its test Keychain item was
  removed. Live helper status and signature validation were exercised without
  authentication. The interactive application flows are not established by these probes.
- Each non-status native request requires helper-owned authorization of the live
  caller and profile, followed by user presence on the actual private-key operation.
  This applies to packaged and development callers; there is no durable development
  allowlist or reliance on Electron's signature to authorize mutable JavaScript.
- Lock invalidates the cipher immediately and restarts Copse to dispose SDK,
  renderer and connection caches. It stops current work. A profile-volume identity
  check runs every second; loss or replacement quits without relaunching. Sleep and
  session lock use Electron power-monitor events. New saved keys are never mirrored
  into the environment; externally supplied credentials remain external.
- Encrypted profiles currently require the Electron desktop. Shared-profile ACP,
  smoke and agent-eval entry points refuse them. A maintenance gate and registered
  headless-client leases prevent participating writers during migration. Quit all
  older Copse processes before setup: old binaries cannot honor this new protocol.
- The settings marker pins format version 1, profile and key IDs. Missing manifests
  or orphan CPS3 records fail closed before legacy stores open. Commit uses a
  ciphertext-only journal; restoration replaces only the authenticated manifest by
  a single durable rename. The empty-vault challenge verifies the recovered key;
  individual records are authenticated on access, not repaired by recovery.
- The helper is independently signed and copied unchanged outside app.asar. Ordinary
  rebuilds reuse it. macOS release builds fail if it was not prepared. See
  [native build and manual checks](../../native/profile-vault/README.md).

Before release, complete the real native UI checks: cancellation at each step,
password fallback, sleep/session lock with active work, repeated app rebuilds,
packaged-helper update, reboot, and replacement-device restore. No further native
prompts were run after the user asked to stop authentication for the night.

## Outcome and scope

Protect Copse's saved secrets with a per-profile key bound to the current Mac.
The user explicitly unlocks them with Touch ID or macOS system authentication.
Offer a recovery-key backup that the user saves separately in a password manager
and can use to restore access after losing the Mac or its device key.

This is the first implementation slice of #2652. It includes provider API keys
and remembered SSH/VNC credentials. It does not encrypt conversations, ordinary
settings, repositories, browser cookies or externally managed credentials.
The product must say **Saved-secret encryption**, rather than imply the whole
profile or disk is encrypted.

Initial delivery supports macOS. Other platforms retain their existing storage
behaviour and report this feature as unavailable. A migrated profile opened on
an unsupported platform fails closed for secret access and writes.

Deferred from #2652: a portable application/toolchain/model bundle, offline
development configuration, regular multi-Mac enrollment and handoff, recipient
management, remote containers, delegated GitHub credentials, brokers and renewal.
Restoring a backup on a replacement Mac remains in scope. Existing profile paths
continue to work, including `COPSE_DIR`; an external SSD is not required.

## Product flow

1. **Enable saved-secret encryption.** Explain which saved credentials are
   protected. Check native support and inventory existing secrets before modifying
   data. Authenticate, create the device envelope, and prove it can be reopened.
2. **Choose recovery backup.** Recommend saving a recovery key in a password
   manager. The user may skip it after acknowledging that losing access to the
   device key makes these saved secrets unrecoverable. When backup is selected,
   require re-import verification before marking it complete. Cancelling the
   export never silently changes the choice to “skip”.
3. **Finish setup.** Commit the verified migration. The settings surface shows
   encryption status and separately shows recovery as “Not backed up” or
   “Verified for this key”. Verification remains transient in native UI. Verification records a successful
   recovery challenge, not a claim that a password-manager copy still exists.
4. **Normal use.** Start locked; show Unlock and Lock actions. Unlock is
   asynchronous and user-initiated. A cancelled prompt leaves saved data intact.
   Local-model work that needs no saved credential can continue while locked.
5. **Back up later.** A user who skipped recovery can export and verify it later,
   after fresh authentication. Recovery material stays in native UI; settings
   receives only status and success/failure.
6. **Restore.** With Copse stopped, restore a consistent profile backup using the
   supported recovery procedure. Import the matching recovery key, authenticate
   the saved manifest and records, and bind the profile to the replacement Mac.
   A restart must unlock normally without asking for the recovery key again.

“Backup” in this slice means a **recovery-key backup**, not a new cloud backup or
archive scheduler. Recovery needs both the recovery key and the encrypted profile
files. The key alone cannot reconstruct deleted files. Continue to use the profile
copy procedure in [Backup, migration, and recovery](../recovery.md), including
separately located stores selected by granular overrides. Project repositories
need their own backups. Keep the recovery key independently of the profile copy.

## Current implementation and required changes

- `packages/store-kit/src/keyring-cipher.ts` writes AES-256-GCM `CPS2` records;
  `os-keyring.ts` stores one OS-user key as `Copse / secret-data-key`. Keep this
  backend for existing profiles and migration reads, not as the new device key.
- `createMigratingCipher()` can fall back to Electron `safeStorage` for writes.
  A migrated profile must never take that fallback or write base64 plaintext.
- Settings and SSH/VNC readers can hide decrypt failures as missing credentials.
  Introduce typed locked, cancelled, unavailable, corrupt and unsupported results;
  only an absent record means “not saved”. Inventory every `getSecretCipher`
  consumer before finalizing the migration registry.
- Current key and credential caches outlive a single operation. Lock must
  invalidate the session cipher and every managed consumer, including providers,
  SSH/VNC sessions and any environment entries populated from saved credentials.

## Key and record design

Create a random 256-bit data key for each profile and key generation. Encrypt
secret records with AES-256-GCM, fresh random nonces and full authentication tags.
Use a versioned `CPS3` record that authenticates format, profile ID, key ID, store
kind and record identity as associated data. Define one canonical, unambiguous
encoding with bounded lengths. Moving a record between provider or host slots,
or between profiles, must fail authentication.

Wrap the data key with a non-exportable Secure Enclave device key using an
Apple CryptoKit HPKE operation with the suite recorded above. Do not invent a
cryptographic protocol. Enforce user presence on the actual private-key operation,
not by trusting a successful standalone biometric prompt.

The local profile contains a versioned security manifest and one active device
envelope. The authenticated envelope payload binds profile ID, key generation,
recipient fingerprint, format version and data key. Authenticate security-relevant
manifest metadata with a domain-separated key derived from the data key. Reject
unsupported formats, duplicate/oversized fields and mismatched identities before
using the metadata. IDs must not depend on the profile's absolute path.

The device private key stays in macOS-protected storage. An unlocked data key may
exist in Copse's main-process memory. This protects saved secrets at rest; it does
not prevent authorized development code or a compromised running host from
capturing them. Do not claim that plaintext credentials stay inside the enclave.

## Recovery format and restoration

Use #2652's random-key recovery record: version, profile ID, key generation,
profile data key and a transcription checksum. The checksum detects input errors;
it does not authenticate the profile. Import succeeds only after cryptographic
verification of the manifest and a challenge/record for that generation.

Do not introduce a passphrase-derived recovery envelope or store the raw recovery
key beside the ciphertext. Native reveal/import UI requires fresh authentication
for export and explicit user action for import. Never send recovery material
through generic settings IPC, logs, telemetry, argv, environment variables or
screenshots. Clipboard copy, if offered, is explicit and explains that clipboard
history/synchronization may retain it; later clearing is best effort.

Export verification must re-import the user's saved record into an isolated flow
and open a challenge. This also works when the vault has no saved credentials.
Reject a wrong profile, generation, checksum, key, truncated record or unsupported
version without overwriting existing security metadata. Never create a new data
key over ciphertext merely because the device key is missing.

Restoration installs a new device envelope only after the recovered key verifies
the copied profile and the new device envelope passes an authenticated round trip.
Replace the single manifest with an fsynced same-directory rename; retain the original until the replacement is verified. Keep the original backup
unchanged. A replacement device does not enter a shared multi-device recipient
list in this slice.

Recovery does not revoke a lost Mac's access to an old profile copy. Removing an
envelope cannot revoke keys or provider tokens already obtained. Suspected secret
compromise requires credential rotation at the provider. General profile-key
rotation and recipient management remain separate work. Offline restoration does
not promise detection of a valid but older backup.

## Native feasibility and development builds

Packaged Copse and ordinary ad-hoc `make run` must open the same real profile
sequentially. Do not require signing every Electron rebuild or duplicating the
user's saved credentials. `make run-dev` retains its separate default profile.

Start with #2652's stable, signed native helper candidate. Prove its hosting,
transport, update identity, Secure Enclave access and native authorization UI
before enabling migration. The helper owns its device key independently of the
changing Electron build. Ship the verified helper for development without
putting production signing credentials in the checkout.

Authenticate the live IPC peer. Validate production code identity; for ad-hoc
builds, obtain helper-owned user authorization bound to that running process,
profile and private channel, expiring when the process exits. A path, UID, claimed
bundle ID or caller-provided “authenticated” flag is insufficient. Do not trust
arbitrary rebuilt JavaScript because its Electron executable is signed. Reject
untrusted callers and wrong-profile or replayed requests. Keep handles and raw
key transfer out of agent subprocesses and debug output.

Prove Touch ID and the system-password fallback, cancellation, reboot behaviour,
helper updates and repeated ad-hoc rebuilds on actual supported hardware. If this
boundary cannot be implemented, record the failed feasibility gate; do not
substitute an ordinary exportable Keychain item while calling it Secure Enclave
protection. An external-drive helper installation and a two-laptop portability
rehearsal are not release gates for this reduced slice.

## Unlock and lock lifecycle

The vault service owns asynchronous unlock and a synchronous session cipher.
Expose non-secret status and narrow unlock/lock/backup/restore operations.
Coalesce concurrent unlock requests. Background probes never trigger prompts.
Locked, cancelled, corrupt and unsupported states must remain distinguishable.

Lock on explicit action, app quit, profile switch, system sleep/session lock and
loss of the selected profile volume. Confirm native event coverage. On lock:

1. Block new saved-secret operations and advance the unlock generation.
2. Cancel pending authentication; ignore late results from older generations.
3. Cancel owned authenticated requests, dispose provider clients, clear SSH/VNC
   credential caches and close owned authenticated sessions.
4. Remove credentials Copse injected into its environment without deleting
   externally supplied credentials. Prefer eliminating vault-to-env reflection.
5. Release helper contexts and key references; overwrite mutable buffers on a
   best-effort basis. Do not promise erasure of JavaScript strings or SDK copies.

Lock cannot retract a completed request or revoke a credential previously given
to an external process. The lock indicator describes saved-secret availability,
not encryption of the visible conversation.

## Migration and crash recovery

Migration runs explicitly on the original Mac while legacy secrets remain
readable. Cover provider keys, remembered SSH passwords/key passphrases and VNC
username/password records, including consented plaintext and legacy `safeStorage`
records as well as `CPS2`. Never export or delete the old account-wide key; another
profile may still depend on it.

Use exclusive profile access across all supported writers, a staging area and a
non-secret journal. Inventory the complete secret registry before staging. Route
secret-store files through that registry so consented plaintext is encrypted
before it reaches staging. Verify every migrated record, device unwrap and the
selected recovery outcome before committing. If a record cannot be read, require
re-entry or explicit omission; never report silent data loss as successful setup.

Flush staged data and use same-filesystem renames with deterministic startup
recovery at every interruption point. A multi-file or two-rename swap is not one
atomic operation. Preserve source data until verified commit and document how
encrypted backups retain their original key requirements. Reject path escapes,
unsafe symlinks, read-only/full disks and concurrent writes without changing the
active profile. Granular path overrides must be explicitly covered or reported
as unsupported before migration; never silently omit an external secret store.

Persist a minimum reader version before opening migrated stores. Supported
launchers must refuse incompatible readers. Old binaries cannot retroactively
honour a marker, so document that opening migrated data with an older build is
unsupported. Missing/corrupt manifests never trigger fallback encryption or an
automatic replacement key. Recovery follows the forward-only policy in
[Backup, migration, and recovery](../recovery.md).

## Implementation sequence and acceptance

1. **Native feasibility.** Add the helper prototype, authenticated transport and
   packaging/update proof. Demonstrate synthetic-key unwrap from packaged Copse
   and repeated `make run` sessions, with actual macOS authorization. Denial,
   cancellation and untrusted clients receive no key. No real-profile migration
   is enabled before this passes.
2. **Vault primitives.** Implement manifest/record decoders, authenticated identity
   binding, session generations and recovery encoding in `packages/store-kit/src/`.
   Test corruption, wrong keys/slots/profiles, nonce uniqueness, bounds, empty-vault
   recovery and refusal to downgrade. Keep platform adapters outside the renderer.
3. **Runtime and settings.** Integrate the main vault service, narrow IPC, provider
   and SSH/VNC gating, lock invalidation and the setup/unlock/recovery status UI.
   Test one prompt per unlock, no background prompts, late results after lock,
   locked reads versus absent keys, and continued credential-free local work.
4. **Migration and backup.** Implement the complete registry, journaled commit,
   native export/import and verification, and explicit skip/later-backup paths.
   Test interruption at every commit boundary, full/read-only disk, unreadable
   legacy records, and failure preserving the source without plaintext staging.
5. **Restore and delivery.** Restore a synthetic profile copy onto a replacement
   Mac or a supported clean device-key setup. Verify normal unlock after restart,
   wrong-generation rejection and failed restore leaving the backup untouched.
   Ship the helper and update `docs/profiles.md`, `docs/recovery.md` and development
   instructions with the proven behaviour and platform limits.

Run `pnpm run check` before committing implementation. For visible changes follow
`.cursor/skills/screenshot-validate/SKILL.md`: add focused WDIO specs with DOM
assertions and inspect screenshots for setup, backup skipped/verified, locked
status, cancellation and recovery failure/success. Use synthetic secrets and
keep native recovery values out of screenshots. Build and run the selected
visual tier. Real native authorization and replacement-device recovery require
on-machine validation; mocks and remote Linux e2e cannot establish those claims.

Release is complete when the supported Mac can enable encryption, optionally
verify a separate recovery backup, unlock and lock correctly, and restore a
copied encrypted profile after losing device-key access. Portable development
bundles and detached remote work are not acceptance requirements for this slice.
