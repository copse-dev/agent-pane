# Device Hub on macOS

Enable the experimental Apple Development plugin and enroll a local project. The `device_hub`
agent tool uses the selected Xcode toolchain. Xcode 27 adds Device Hub and device screenshots.
Device discovery uses the versioned `devicectl --json-output` file format, including Xcode 27's
`properties` dictionary and older physical-device fields.

| Action       | Behavior                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`       | Discover CoreDevice physical devices and simulators, their identifiers, connection state, and supported capabilities.                                      |
| `open`       | Open Device Hub from the selected Xcode; select a device in its sidebar.                                                                                   |
| `apps`       | List installed development apps on the selected device.                                                                                                    |
| `launch`     | Launch an installed bundle ID using `simctl` for simulators or `devicectl` for physical devices.                                                           |
| `screenshot` | Return a PNG to the agent; temporary files are removed after the call.                                                                                     |
| `show`       | Open a booted simulator in Copse's Desktop panel. The Desktop setting must be enabled, and the panel starts view-only.                                     |
| `input`      | Send a simulator tap, USB HID key, or Home/Lock/Side/Siri button. Each action passes through the tool permission gate and does not turn on renderer input. |

Call `list` first, then use an explicit `device_id` for every device action. `launch` also takes
`bundle_id`. Input coordinates are ratios from zero to one, measured from the screenshot's top
left. Use the bundled XcodeBuildMCP tools to build, install, and boot simulators.

Device Hub calls request host-device permission by default, including discovery and screenshots.
Enrollment is checked against the calling agent task's project, independent of the project
selected in the UI. The normal explicit Always allow, Always ask, and Blocked settings apply.
Read-only agent mode blocks the tool. All subprocesses use fixed argument arrays, cancellation, time limits, and output
bounds. Screenshots and JSON outputs use private per-call temporary directories.

The simulator input helper searches both Xcode 27's `Contents/SharedFrameworks/SimulatorKit.framework`
and earlier Xcode's `Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework`. Capture
and input respect `DEVELOPER_DIR`, including when it points to an Xcode.app bundle. Initialization
failures fail the operation, and a discrete input call waits for HID delivery acknowledgements
before exiting. A lost DTUHID connection stops the helper so the viewer reports disconnection.

Recent simulators use the DTUHID XPC transport for touch, keys, and hardware buttons. Copse checks
that the guest daemon answers before sending input, and drains the transport before a discrete
agent call exits. Older runtimes retain the Indigo transport. The DTUHID wire format and connection
setup follow [idb's implementation](https://github.com/facebook/idb/tree/main/FBSimulatorControl/HID),
under its accompanying MIT license.

## Remaining physical-device work

Physical-device live embedding and touch/keyboard input are **not implemented**. The installed
Xcode 27 `devicectl` supports screenshots and screen recordings, but its documented command tree
does not expose HID input or a live frame transport. The existing CoreSimulator framebuffer/HID
helpers work only with simulated devices. A screenshot must not be advertised as an interactive
stream, and a physical device must never be sent to the simulator helper.

Until a physical-device transport is implemented and verified, use `open` to interact in Device
Hub itself. A subsequent implementation needs a real connected development device, a verified
display/input bridge, disconnect and cancellation tests, and the same view-only and approval
boundaries as the existing viewer. Discovery of a paired but disconnected phone does not establish
that screenshots or input work on it.

References: [Apple Device Hub documentation](https://developer.apple.com/documentation/xcode/device-hub)
and [Get the most out of Device Hub](https://developer.apple.com/videos/play/wwdc2026/260/).
