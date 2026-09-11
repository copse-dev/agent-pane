# Standard on-device secret encryption and optional recovery backup

Status: implementation in [PR #2658](https://github.com/copse-dev/agent-pane/pull/2658);
packaged/native acceptance pending. Scoped from
[#2652](https://github.com/copse-dev/agent-pane/pull/2652).

## Product decisions

Supported signed macOS releases automatically enroll new profiles and migrate
existing saved API keys and SSH/VNC credentials. Normal startup is silent.
Settings → Storage offers **Require authentication when Copse starts**, off by
default for newly enrolled profiles. Existing vault profiles keep their previous
authentication requirement. Changing the setting requires fresh authentication.

Recovery-key export always requires fresh native authentication, including when
startup authentication is disabled or the app is already unlocked. Recovery
backup is optional and can be completed later in a password manager. A recovery
key needs the encrypted profile files; it cannot reconstruct deleted files.

An unlocked session survives sleep and screen lock until quit. There is no
separate Lock button. Quit clears managed access and leaves the app closed.
Cancelling startup authentication opens the app locked; **Unlock** retries only
when the user requests it. No background retry loop prompts repeatedly.

Conversations, ordinary settings, repositories, browser cookies and externally
managed credentials are outside this option. It must be called **Saved-secret
encryption**. Portable toolchains, offline model bundles, regular multi-device
handoff, recipient management and delegated credentials remain deferred.

Unsupported platforms and development builds retain existing OS storage for
unenrolled profiles. A migrated profile requires the desktop unlock service;
headless ACP/smoke/eval modes refuse it. Mutable development callers require
explicit approval and native authentication to open an enrolled profile. They
are never silently trusted or automatically enrolled.

## Native key and caller protection

The profile data key encrypts CPS3 records with AES-256-GCM. Each record binds its
profile ID, key ID, store and slot as authenticated data. A Secure Enclave P-256
key wraps the data key using CryptoKit HPKE, P256 / HKDF-SHA256 / AES-GCM-256.
`.privateKeyUsage` is always present; `.userPresence` is added when startup
authentication is required. Key material is device-bound, but the unlocked data
key and credentials necessarily enter application memory.

Direct permanent Security-framework keys failed with `-34018` during feasibility
work. CryptoKit's opaque hardware-encrypted key representation is stored instead;
the private scalar is not exportable. The earlier signed synthetic probe proved
a persistent, fresh-process HPKE round trip on the development Mac. Current
packaged behavior is still subject to native acceptance.

The signed helper and main process communicate on a bounded inherited socket.
Main validates the pinned helper identity on disk and as a live process before
sending. Native validates the kernel-supplied peer audit token and code signature.
Silent access additionally requires the exact `dev.copse.app` Developer ID,
hardened runtime, restrictive main-process entitlements, signed
`CopseVaultSilentAccess` marker and complete resource validation. Other callers
need an explicit native confirmation plus fresh macOS authentication.

The marker is shipped only with release hardening: RunAsNode, Node environment
options and Node inspector fuses disabled; embedded asar integrity and loading
only from app.asar enabled. Packaged debugger/V8 injection launch arguments are
rejected before credentials initialize. Main library validation and DYLD
protections remain enabled. Separate worker identities retain compatibility
entitlements without becoming trusted vault callers.

Packaged macOS workers use a separately signed Node interpreter, pinned by
`.nvmrc` and downloaded with official release checksum verification. Worker
scripts and all production dependencies are unpacked for standalone Node; their
sandbox scopes do not change.
Other platforms and development builds retain the existing runtime path.

## Native authority and authentication changes

A single Keychain item per profile/key generation contains the active device key
representation, device envelope and authentication policy. The helper chooses
this current record rather than trusting a device-key ID or policy supplied by
profile files. Status reads cannot display Keychain authorization UI.

Changing authentication performs fresh authentication, unwraps the data key,
creates a new device key with the requested access-control flags, verifies the
new envelope, then atomically replaces that Keychain value. No old silent key is
retained in a second native item. Saved records and recovery keys keep the same
profile data key.

Main verifies the returned key against its original authenticated manifest and
writes the updated envelope/policy mirror. If native commits but the app exits
before writing, the next unlock uses the current native record and repairs the
mirror. Replaying an older profile manifest cannot select the previous silent
key after opting into authentication. This does not promise resistance to
rollback of the OS Keychain itself or an already compromised native helper.

Older always-authenticated vault items are adopted only after successful unwrap;
the old per-device item is then removed. Their authentication requirement stays
on. Recovery validates the supplied key against the original manifest HMAC in
native before replacing native state, then main verifies the manifest challenge
before writing the mirror. A wrong recovery key preserves existing state and
cannot poison a subsequent correct retry.

## Automatic migration and failure behavior

Before providers, automations or renderer credential consumers initialize, the
app probes native support. Only the hardened release caller can create a new
silent device key. Supported new and legacy profiles migrate automatically.

Migration acquires the profile maintenance gate, refuses participating headless
writers, drains pending writes and inventories the complete API/SSH/VNC registry.
It includes consented legacy plaintext records and existing encrypted formats.
Every source credential must decode and encrypt successfully. No partial success
or silent omission is reported.

Commit uses a ciphertext-only staged journal with fsync/atomic replacement. The
manifest is installed last. Startup replays an interrupted committed transaction
under single-instance ownership before stores open. A settings marker pins
profile/key identity; missing manifests and orphan CPS3 records fail closed.
Successful migration restarts once to discard cached legacy stores and keys.
The next startup opens the vault under its selected authentication policy.

Failure before commit preserves the original stores and uses existing storage.
Settings explains that migration is incomplete and offers **Retry migration**.
The next launch also retries. Unsupported machines retain existing storage;
they must not claim that device encryption was applied. Quit older Copse binaries
before migration: they cannot participate in the new maintenance protocol.

Every store remains under the selected profile root (`COPSE_DIR` supported).
A profile-volume identity check runs while the app is open; loss/replacement
invalidates access and quits without relaunching.

## Session and recovery security

The service owns asynchronous, coalesced unlock and a synchronous session cipher.
Native key returns are checked against the manifest before use. Cancellation,
shutdown and lost-profile events invalidate pending generations and clear owned
buffers on a best-effort basis. Decrypted vault keys are never mirrored into the
environment. Externally supplied credentials retain their separate ownership.

Retaining the unlocked key through sleep matches the existing keyring cache's
memory lifetime. It relies on OS session security and does not protect against
an attacker already able to read Copse's process memory. Swift/JavaScript strings
and SDK copies cannot be promised securely erased. Quit clears managed consumers;
it cannot revoke a completed request or credentials given to an external process.

Recovery display/import is native-only. Export uses a fresh authentication
context independent of the startup policy and verifies the manifest before
revealing the key. Re-import verification marks recovery as verified for this
profile key; it does not prove the password-manager copy still exists. Clipboard
copy is explicit/manual and may be retained by clipboard managers or sync.

See [profiles](../profiles.md), [recovery](../recovery.md) and the
[native build and acceptance checklist](../../native/profile-vault/README.md).

## Validation and remaining release gates

Automated tests cover authenticated records/manifests, old-format compatibility,
automatic new/legacy enrollment, unsupported callers, migration failure, policy
updates, interrupted native/app synchronization, cancellation and recovery.
Native policy tests compile and execute only pure policy/HMAC code: no Keychain,
Secure Enclave operation or authentication UI. Fuse tests modify/read a disposable
Electron binary copy without signing or executing it. Focused browser/Electron
evals capture settings and unavailable-helper behavior using synthetic profiles.

Run `pnpm run check` before committing. Review screenshots from the focused
WebdriverIO workflows. Full CI remains selected for these cross-cutting changes.

Before release, complete signed packaged caller acceptance, native-addon and
worker compatibility, actual silent enrollment/startup, opt-in Touch ID/password
fallback, export authentication in both modes, cancellations, interrupted policy
updates, sleep/reboot/helper updates and replacement-Mac restore. These checks
remain pending because the user requested no further fingerprint/password
approvals during unattended work. Do not infer native acceptance from typecheck
or mock tests, or ship an old signed helper with new source.
