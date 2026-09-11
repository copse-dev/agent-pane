# Android emulator support spike

Date: 2026-09-11. Scope: establish capabilities and constraints before planning shared
code. This spike adds no Copse runtime integration, dependencies, or permission-policy
changes. The earlier iOS work remains separate and uncommitted.

## Result

A real Android emulator can run without a native window and supply live frames and
input over its built-in gRPC API. On this machine, a disposable Android 13 device
successfully displayed a locally built test APK, accepted a touch and ASCII text,
rotated, and supplied an accessibility hierarchy and app logs. Requests without the
gRPC bearer token were rejected.

The main uncertainty is now the transport and lifecycle experience across emulator
versions and host graphics configurations, rather than whether embedding is possible.
Do not choose shared interfaces solely around the current iOS JPEG path yet.

## What was actually tested

Host: macOS 25.6, Apple M1 Max, arm64. Installed tools: emulator 33.1.24.0
(build 11237101), ADB 35.0.0, Android 13/API 33 Google APIs arm64 image revision 9,
Build Tools 34.0.0, Android Studio's JBR 17.0.11. These are the installed versions,
not a proposed supported-version baseline.

A new `CopseSpike` AVD lived under `.tmp/android-spike/avd`. Existing AVDs were not
booted or modified. No SDK updates, package downloads, real-device connections,
release credentials, or Gradle project builds were involved.

| Check                 | Observation                                                                           | Confidence / limit                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| SDK and AVD discovery | Four existing AVD definitions found; current executable works                         | `PATH` points at obsolete `sdk/tools/emulator`; use `sdk/emulator/emulator` explicitly                    |
| Headless boot         | `-no-window -no-snapshot` works; ADB reports `sys.boot_completed=1`                   | Log reported 43.5s software-rendered boot and 32.6s host-GPU boot; single runs                            |
| Authenticated gRPC    | `getStatus` succeeds with token; no-token call returns `UNAUTHENTICATED`              | Token mode tested on loopback only; JWT not tested                                                        |
| Screen capture        | PNG and RGBA streams at 540×960; real screenshots saved                               | First image can show Android still starting; not equivalent to ready                                      |
| Touch                 | Test app displayed `Taps: 1`; Logcat contained `tap=1`                                | Verified with host GPU; first software-rendered run stalled                                               |
| Text                  | gRPC `sendKey(text=...)` produced `copse123` in EditText                              | ASCII verified; arbitrary Unicode typing not verified                                                     |
| Navigation            | Home eventually returned to launcher; Back and Overview calls accepted                | Full navigation/gesture correctness and latency not systematically measured                               |
| Rotation              | Physical-model rotation produced 960×540 frames and a settled landscape layout        | Initial rotated frame retained old content during transition; input mapping during rotation needs testing |
| Clipboard             | Unicode `café 日本語` content round-tripped through guest gRPC clipboard              | Clipboard storage only; paste and host clipboard integration not tested                                   |
| Accessibility         | ADB/UI Automator XML contained labels, classes, and bounds for the test app           | Standard Android Views only; Compose/WebView/custom canvases not tested                                   |
| Build/install/launch  | Java → D8 → AAPT2 → temporary debug signing → ADB install and `am start -W` succeeded | SDK pipeline tested; Gradle variants, dependency resolution and instrumentation not tested                |
| Logs                  | Targeted Logcat captured Activity creation and tap event                              | No crash-report attribution pipeline built                                                                |
| Stream lifecycle      | Bounded streams canceled; later screenshot and new stream succeeded                   | Multiple simultaneous clients, device restart, and stale endpoint recovery remain untested                |

The test Activity recreates on rotation and intentionally does not persist its counter
or text, explaining `Taps: 0` in the settled landscape capture.

Evidence:

- [gRPC touch and text](android-emulator/evidence/app-input.png)
- [rotation transition](android-emulator/evidence/rotation.png) and
  [settled landscape](android-emulator/evidence/rotation-settled.png)
- [accessibility XML](android-emulator/evidence/ui.xml)
- [host GPU sample](android-emulator/evidence/host-gpu-results.json)
- [software GPU sample](android-emulator/evidence/software-gpu-results.json)

These are direct emulator captures, not Copse panel screenshots. A focused Electron
visual spec will still be required when the display is integrated into Copse.

## Streaming findings and choices

The installed controller supports PNG, RGB888, and RGBA8888. At 540×960, raw RGBA
is 2,073,600 bytes per frame: about 62.2 MB/s at 30 fps before transport overhead.
The host-GPU idle sample produced approximately 54 KB PNGs. First stream frames
arrived in 53.5ms (PNG) and 14.1ms (RGBA); single PNG RPCs took 43.5–46.9ms.
These are RPC timings without Electron transfer/rendering, not end-to-end latency.

The four-second idle samples delivered 9 PNG and 10 RGBA frames. This is a
damage-driven stream, so that is not a maximum frame-rate measurement. The initial
software-rendered sample saw 11.7 fps for PNG but later Android displayed a system
ANR. Its animation samples and fixed-delay input captures are inconclusive. Matching
hashes in that result are stalled frames, not proof that input worked.

`-gpu auto` plus `-no-window` chose SwiftShader on this older installation. Retrying
with `-gpu host` used Apple M1 Max graphics and visibly delivered tap/text input.
That is useful evidence for exposing diagnostics/fallbacks, not sufficient evidence
to force host GPU universally.

| Candidate                | Where it fits                                                                | Work / constraints                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Emulator gRPC PNG        | Smallest emulator-only integration experiment; current canvas can decode PNG | CPU-intensive encoding; size caps, backpressure and visibility-aware subscriptions needed                |
| Emulator gRPC raw pixels | Avoid PNG encoding; potentially good local path                              | High bandwidth and Electron copying; add raw pixel transport/rendering and inspect shared-memory options |
| scrcpy + Tango           | Compressed video and a route to ADB-connected physical phones                | Node ADB client, matched server artifact, WebCodecs decoder, codec checks, cleanup and version pinning   |
| Repeated `adb screencap` | Debug snapshot/fallback                                                      | Process overhead makes this a poor default live-view architecture                                        |

Only gRPC was exercised. scrcpy/Tango were researched, not installed or benchmarked.
The [scrcpy protocol](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md)
requires matched client/server versions. [Tango](https://tangoadb.dev/scrcpy/) already
implements a TypeScript client, with a
[WebCodecs decoder](https://tangoadb.dev/scrcpy/video/web-codecs/); investigate that
before maintaining a binary control protocol ourselves. Electron codec availability
and renderer lifetime still need direct validation.

## Support inventory for a later plan

### Device setup and lifecycle

- Resolve SDK/JDK and separate platform-tools, emulator, system-image and build-tools
  availability. An installed Android Studio does not establish all of these.
- Distinguish AVD identity from running ADB serial (`emulator-5580` here). Verify the
  selected serial, AVD name, gRPC endpoint and process belong to the same instance.
- Track process started, ADB online, Android boot complete, package manager ready,
  app launched, and first visible frame as separate milestones.
- Support attaching to an existing emulator separately from launching one Copse owns.
  An existing instance may not expose usable gRPC; do not restart it silently.
- Model port conflicts, stale discovery records, unauthorized/offline devices,
  architecture/acceleration mismatch, GPU failure, low disk, startup timeout and ANR.
- Disconnect stops our stream; it should not kill an externally owned emulator.
  Stop may terminate a Copse-owned process. Never kill the shared ADB server during
  ordinary tab cleanup. Snapshot/wipe/create/delete are separate device operations.

### Interaction and observability

- Handle physical display coordinates, stream scaling, rotation transitions and
  pointer cancellation. Release touch contacts on blur/disconnect; the installed
  schema requires pressure zero to release a contact.
- Back, Home, Overview, Power, volume, scrolling, long press, drag, multi-touch,
  keyboard down/up, text composition and Unicode paste need explicit coverage.
- Represent device controls as capabilities. Foldables, multi-display, Wear/TV,
  sensors, GPS, network conditions and biometrics need separate scope decisions.
- Bound frame queues and drop superseded frames. Idle/screen-off can legitimately
  produce no updates or an empty image; an inactivity watchdog must not mistake
  that for a dead emulator.
- Accessibility snapshots and screenshots are complementary. Agent UI automation
  should not need continuous screen images in its context just because the user
  is watching a live panel.

### Build, run and agent tools

Use a project's Gradle wrapper and actual module/variant selection for production
builds. Resolve APK outputs/application ID from build metadata rather than assuming
`:app`, `debug`, or a fixed launcher Activity. Account for split APKs, test APKs,
flavors, launch intents, install conflicts and target ABI/API. A bundle is not an
APK that can be installed directly. This spike deliberately did not invoke an
arbitrary project's Gradle scripts. See the official
[command-line build guide](https://developer.android.com/build/building-cmdline).

[Mobile Next MCP](https://github.com/mobile-next/mobile-mcp) is a candidate for
agent device discovery, accessibility, screenshots, gestures, app install/launch,
orientation and other device automation. Its published tools do not establish a
complete Gradle build/variant workflow or provide Copse's live panel transport.
It requires a running emulator for its Android setup. Validate its actual tool
behavior, dependencies and cancellation before adoption; it was not executed here.
A full replacement equivalent to our XcodeBuildMCP workflow is not established.

Copse would still need a host presentation operation so an agent can open the
selected device's panel after launch. Register it through native and ACP paths,
with consistent feature enablement. Do not settle the shared tool name/API now.

### Authority and local endpoints

Clicking a supported Build/Run action can carry the user's authority for that
operation; repeated approval dialogs are not inherent to Android. Agent-triggered
builds still run project code and should use the app's existing permission contract.
Device wipe, SDK installation, signing and access to a physical phone are distinct
operations from displaying an already selected emulator.

The tested gRPC server bound only to 127.0.0.1 and rejected missing tokens. The local
binary warns that basic token mode is intended for Android Studio; evaluate JWT and
current-emulator discovery before choosing production auth. Keep tokens out of the
renderer and logs, validate discovery ownership, and avoid enabling network ADB as
part of local viewing. None of this requires putting the native emulator inside the
same restricted environment as arbitrary agent shell commands.

## What this tells us about code sharing (not a design commitment)

Current seams worth revisiting after transport selection:

- `src/shared/types/simulator-desktop.ts` uses UUID device IDs, image MIME payloads,
  USB-key usages and iOS hardware buttons. Android adds serials, display/rotation
  metadata, text composition and possibly compressed video/raw pixels.
- `src/renderer/views/simulator-desktop-view.ts` owns image decoding and input mapping.
  Sharing tab chrome does not require sharing every decoder or input encoder.
- `src/renderer/views/vnc-pane.ts` owns selection and tab/session state; this is a
  plausible shared presentation surface, with explicit device ownership/reuse.
- Main-process services should retain platform-specific discovery, lifecycle,
  transport and build semantics until a second implementation proves the abstraction.

## Next decisions / experiments

1. Choose emulator-only versus physical-phone scope. This changes the value of scrcpy.
2. Compare gRPC PNG/raw and scrcpy on the same deterministic animation in the actual
   Electron renderer: 540p/720p, frame latency, dropped frames, memory, CPU, hidden tab.
3. Repeat on a current emulator version; check authenticated attachment to an instance
   started by Android Studio. Validate JWT, restart and stale-port recovery.
4. Build a small Gradle project with variants; verify install/launch, cancellation,
   test reporting and Logcat attribution. Trial Mobile Next's actual MCP tools.
5. Then choose supported hosts/versions and design shared code around measured needs.

No production refactor or MCP selection is proposed as settled by this spike.

## Reproduction

The standalone [probe](android-emulator/probe.py) uses Python `grpcio` and `protobuf`
and a descriptor compiled from the **installed** emulator schema. Python 3.12,
grpcio 1.76.0, protobuf 7.34.0 and protoc 7.35.1 were available here. Generated
Python source hit a protoc/runtime version check; descriptor-based dynamic messages
worked without changing installed packages. This is spike tooling, not a proposal
to ship Python with Copse.

Create a disposable AVD with a matching installed system image (the spike used a
fresh config, not an existing device's userdata). Set `ANDROID_AVD_HOME` to its
isolated parent directory. Launch with the installed SDK executable:

```sh
"$ANDROID_HOME/emulator/emulator" -avd CopseSpike -no-window -no-snapshot \
  -no-audio -no-boot-anim -gpu host -port 5580 -grpc 8556 -grpc-use-token
```

Check free ports first. On the tested version `-grpc` accepts the numeric port;
use the installed binary's help rather than assuming current documentation matches.
Read the matching process discovery INI from the directory named by that help.
Do not print its token. Wait for Android readiness using the explicitly selected
ADB serial before running input tests.

```sh
protoc -I "$ANDROID_HOME/emulator/lib" -I /opt/homebrew/include \
  --include_imports --descriptor_set_out=/tmp/controller.pb \
  "$ANDROID_HOME/emulator/lib/emulator_controller.proto"
python3 docs/spikes/android-emulator/probe.py \
  --descriptor /tmp/controller.pb --discovery /path/to/pid_PROCESS.ini \
  --port 8556 --output /tmp/android-spike-results
```

The optional `--exercise-input` expects the included disposable
[Activity](android-emulator/MainActivity.java) and
[manifest](android-emulator/AndroidManifest.xml), already launched in portrait at
1080×1920. Build it with javac against android.jar, D8, AAPT2 link, append classes.dex,
then sign with a temporary debug key. Install using `adb -s emulator-5580 install`
and launch `dev.copse.androidspike/.MainActivity` via `am start -W`.
Input results require screenshot/content verification, not merely successful RPCs.
The retained input evidence came from the explicit tap/text probe before the final
read-only stream sample; the two JSON files are not automated UI pass/fail verdicts.

Additional API references: [installed controller's upstream schema](https://android.googlesource.com/platform/tools/base/+/refs/heads/mirror-goog-studio-main/emulator/proto/emulator_controller.proto),
[emulator launch options](https://developer.android.com/studio/run/emulator-commandline),
[ADB](https://developer.android.com/tools/adb).
