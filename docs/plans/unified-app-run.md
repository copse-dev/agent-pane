# Shared Apple and Android app running

Follow-on to #2667, on `codex/unified-app-run`.

## User flow

A detected local Apple or Android project offers **Run app…**. Opening it loads app metadata;
there is no pack toggle or project enrollment step for user-operated builds. One compact picker
contains App and Device, remembers the last valid project choice, and folds variants/configuration
into More options. Run builds, starts the device, installs, launches, and opens Desktop. Build and
Test remain explicit secondary actions. Progress names the actual stage and logs stream while it
runs. Stop app stops the launched app; closing Desktop leaves the device running.

Missing dependencies appear in the picker with an actionable recovery. Creation uses installed
runtimes; downloads are separate, explicit setup actions. No silent license acceptance, signing
changes, SDK installation, or emulator authentication downgrade. User-initiated Run opens a local
device ready for interaction. Agent-initiated presentation and remote desktops remain view-only.

## Implementation boundaries

- Share discovery result/selection/operation types, picker, status/logs, cancellation, persistence,
  and presentation. Keep Apple and Android drivers independent.
- Reuse the installed Xcode driver; retain XcodeBuildMCP and its existing agent permissions.
- Android uses the project's Gradle wrapper, installed SDK tools, AVDs, authenticated loopback
  framebuffer connection, and targeted adb commands. Discover Gradle application modules and
  variants by evaluating their real configuration, not by guessing build filenames.
- Main resolves project/thread roots on every action. Renderer supplies identities, never arbitrary
  host commands. Project build configuration and build scripts run with normal host access after
  a user action, as existing Apple panel actions do. This does not grant agent permission.
- Save only project-relative app identities and device/variant preferences, never authentication
  tokens. Operations are bounded and cancelled on shutdown; interrupted work is never replayed.
- Physical devices, remote toolchains, publishing, multi-touch, and Android agent tools are outside
  this UI/lifecycle change. Existing platform tools stay available independently.

## Acceptance

- Apple and Android projects reach a shared Run picker without visiting Settings.
- Multiple apps, variants, compatible devices, and stopped devices are selectable; choices persist.
- Missing tools/runtimes and device creation/download are actionable in place.
- Both Run paths show real stages/logs and automatically present the selected local device.
- User-run control is immediate, agent/remote presentation remains view-only.
- Tests cover owner isolation, stale choices, failures, cancellation, setup consent, and presentation.
- Focused visual evidence covers picker, setup, progress, and running on both platforms.

## Validation and current limits

The shared flow was exercised through the real Electron titlebar and picker on macOS arm64 with
two disposable applications. Android used Gradle 8.10.2, AGP 8.7.3, SDK 34, and an Android 33
arm64 AVD; Run built, started the AVD, installed, launched, opened Desktop, and delivered a tap
to the guest app. Apple used an unsigned simulator-only SwiftUI sample and an iOS 26.5 iPhone 16;
Run built, booted the stopped simulator, installed, launched, and displayed its framebuffer.
Both opened with control enabled and made the Desktop toolbar visible from a disabled setting.
No personal app, physical device, signing profile, or personal AVD was used.

- [Android running in Desktop](../spikes/unified-app-run/android-running.png)
- [Apple running in Desktop](../spikes/unified-app-run/apple-running.png)
- Deterministic picker/setup/progress screenshots: `tests/e2e/screenshots/app-run-*.png`.
- Repeatable browser fixture: `tests/demo/app-run.demo.ts`.
- Desktop view-only behavior and separate device tabs: `tests/e2e/simulator-desktop.e2e.ts`.

This first shared UI supports local macOS hosts. Android Test runs the selected variant's local
unit tests; instrumentation tests and split-APK installation remain future work. Android runtime
downloads require SDK command-line tools and any licenses to be accepted in Android Studio.
The picker offers Debug/Release Xcode configurations. “App running” confirms successful launch;
it is not a continuous guest-process health monitor. Stop app stops the tracked app and leaves
the simulator/emulator available. Closing a dialog does not cancel a build; its progress and Cancel
action are available when reopening Run app. Closing Copse cancels unfinished operations.

The initial `pnpm run check` passed all 9,218 tests plus typecheck, lint, formatting, dead-code,
oracle, and syntax gates. The focused browser spec passed four cases; the Desktop spec passed
three, including two-device tab reuse. Fresh Apple and Android builds also passed through the
final picker/IPC implementation. The broader Electron run reached 72 passing specs before
`git-changes-image.e2e.ts` failed to display its proposed-image section. The same failure was
reproduced on the unmodified parent build (`fd3d969ca`), using that test's own Git fixture;
the remaining broad specs were not run. A separate follow-up demo fixture was corrected to use
an isolated workspace because a dirty checkout correctly adds an extra Changes bubble.

After rebasing onto the updated parent, `pnpm run check` passed all 9,282 tests and the build
passed. All 22 browser specs passed, including the four Run app cases. The three Desktop cases
and both image-preview cases passed; the parent now contains the image-preview fixture fix.
The full Electron suite has not been rerun. The API compatibility check against the parent passed
with protocol version 10, preserving its supervisor and Android protocol changes.
