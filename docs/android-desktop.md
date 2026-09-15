# Android emulator Desktop preview

Copse can connect to a running Android emulator from **Desktop**, alongside local
iOS Simulators and remote desktops. This first slice supports macOS hosts and the
emulator's local token-authenticated gRPC endpoint.

1. Start an AVD from Android Studio's embedded emulator, or launch it with the SDK
   emulator's `-grpc <port> -grpc-use-token` options. Use the installed binary's
   help to check supported flags. A headless emulator (`-no-window`) also works.
2. Enable the Desktop viewer in Copse Settings, open Desktop, and use **Refresh
   desktop devices** if the emulator started after opening the panel.
3. Select the emulator and connect. It starts in view-only mode. **Control
   emulator** enables touch, drags, keyboard input, and Back / Home / Apps buttons.
4. Disconnect to release the display and input streams. Copse leaves the emulator
   and its apps running.

The connection is independent of Apple Development and does not require Xcode or
screen-recording permission. It discovers emulator process records from the
standard macOS registration directory. Tokens remain in the main process and are
sent only to the advertised port on `127.0.0.1`; Copse neither disables emulator
authentication nor accepts arbitrary gRPC addresses from renderer IPC.

An emulator configured exclusively for signed JWT authentication is shown with an
actionable connection error. JWT key registration is not implemented in this
slice. No emulator process or personal AVD is launched or modified automatically.

## Implementation and limits

- Uses the SDK's `android.emulation.control.EmulatorController` API, with a small
  protobuf descriptor for display and input messages and the maintained Node gRPC
  client. There is no VNC server or host-window capture helper.
- Streams PNG frames at the primary display's native dimensions. The canvas fits
  them into the existing Desktop viewer. Rotation updates the canvas dimensions; touch coordinates are mapped back to the native digitizer orientation.
- Input uses one `streamInputEvent` connection: the emulator explicitly guarantees
  event ordering on this RPC. Writes are paced by 16 ms for the UI-loop scheduling observed on emulator 33.1.24; pending pointer moves are coalesced so high-rate motion does not create a backlog. Independent `sendKey` calls can reorder rapid input,
  even when the client waits for each call's response.
- Bounds frame size, queued input, initial-frame wait, and input writes. Closing
  the viewer releases held touch/modifier state and closes both streams. Streams
  are scoped to their owning renderer, with one connection per running emulator.
- Connected means display frames are arriving; it does not imply Android has
  completed booting or an app has finished launching.

The first slice covers one pointer and common physical keyboard keys. Clipboard,
IME, multitouch, foldables/resizable displays, secondary displays, audio, remote
emulator transport, JWT, and Linux/Windows discovery need separate validation.
SDK installation, AVD creation/boot controls, Gradle build/test/install workflows,
and agent-visible Android tools are follow-up work, not part of this connection.

## Evidence

The [Android spike](spikes/android-emulator.md) records the original SDK/API
investigation and disposable test app. Integration tests run a real local gRPC
server to exercise credentials, ordered input, stream cancellation, ownership,
rotation dimensions, and reconnect. The focused Electron spec
`tests/e2e/simulator-desktop.e2e.ts` checks both platforms, explicit control,
navigation, refresh, and disconnect, and saves `android-desktop-live.png`.

Protocol reference:
[EmulatorController](https://android.googlesource.com/platform/tools/base/+/refs/heads/mirror-goog-studio-main/emulator/proto/emulator_controller.proto).

Real-device validation on emulator **33.1.24.0 / Android 13 / arm64**, with a disposable
AVD and the spike activity, confirmed a live 1080×1920 display inside Electron,
a panel tap changing the counter to `Taps: 1`, text `panel` arriving in order,
and disconnect. A landscape test confirmed 1920×1080 frames and a correctly
mapped tap after inverse rotation. See the [real panel capture](spikes/android-emulator/evidence/copse-live-panel.png).
