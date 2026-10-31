// copse-desktop.swift
//
// Headless macOS desktop-control helper for Copse's computer-use tools.
//
// Reads one JSON request per line on stdin and writes one JSON response per
// line on stdout:
//   -> {"id":1,"method":"snapshot","params":{"pid":123}}
//   <- {"id":1,"ok":true,"result":{...}}
//   <- {"id":1,"ok":false,"error":"..."}
//
// Observation uses the Accessibility API (AXUIElement) and ScreenCaptureKit,
// both of which work on windows that are in the background or covered.
// Actions prefer accessibility actions (AXPress, AXValue) so the target app is
// never brought to the front and the user's pointer never moves; synthesized
// keyboard and pointer events are posted to the target process only.
//
// Password fields (AXSecureTextField) never have their value read.
//
// Compile:
//   swiftc -O -swift-version 5 -framework AppKit -framework ApplicationServices \
//     -framework ScreenCaptureKit copse-desktop.swift -o copse-desktop

import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

// Private but long-stable: maps an AX window element to its CGWindowID. Used by
// every macOS window manager (yabai, Rectangle, Hammerspoon).
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowId: UnsafeMutablePointer<CGWindowID>) -> AXError

struct HelperError: Error { let message: String }

func fail(_ message: String) -> HelperError { HelperError(message: message) }

let stdoutLock = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
  stdoutLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  stdoutLock.unlock()
}

// MARK: - Parameter helpers

func intParam(_ params: [String: Any], _ key: String) throws -> Int {
  if let value = params[key] as? Int { return value }
  if let value = params[key] as? Double, value.rounded() == value { return Int(value) }
  throw fail("Missing integer parameter: \(key)")
}

func optionalInt(_ params: [String: Any], _ key: String) -> Int? {
  if let value = params[key] as? Int { return value }
  if let value = params[key] as? Double, value.rounded() == value { return Int(value) }
  return nil
}

func stringParam(_ params: [String: Any], _ key: String) throws -> String {
  guard let value = params[key] as? String else { throw fail("Missing string parameter: \(key)") }
  return value
}

// MARK: - AX helpers

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = axAttribute(element, name) else { return nil }
  if let string = value as? String { return string.isEmpty ? nil : string }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func axBool(_ element: AXUIElement, _ name: String) -> Bool? {
  axAttribute(element, name) as? Bool
}

func axElements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
  guard let value = axAttribute(element, name), CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
  return (value as? [AXUIElement]) ?? []
}

func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = axAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func axFrame(_ element: AXUIElement) -> CGRect? {
  guard let positionValue = axAttribute(element, kAXPositionAttribute),
        let sizeValue = axAttribute(element, kAXSizeAttribute),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
  AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}

func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  // Custom actions arrive as "Name:<label>\nTarget:…\nSelector:…"; they are
  // performed by that full string, which the outline cannot carry, so only
  // standard AX actions are offered.
  return list.filter { !$0.contains("\n") && !$0.hasPrefix("Name:") }
}

func windowId(of element: AXUIElement) -> CGWindowID? {
  var id: CGWindowID = 0
  return _AXUIElementGetWindow(element, &id) == .success && id != 0 ? id : nil
}

func truncate(_ text: String, _ limit: Int) -> String {
  text.count <= limit ? text : String(text.prefix(limit)) + "…"
}

// MARK: - Element refs
//
// Refs are opaque, per-app, and valid until the next snapshot of that app. A
// stale ref is an error rather than a guess.

final class RefTable {
  private var byPid: [pid_t: [String: AXUIElement]] = [:]
  func reset(_ pid: pid_t) { byPid[pid] = [:] }
  func add(_ pid: pid_t, _ element: AXUIElement) -> String {
    let ref = "e\(byPid[pid, default: [:]].count + 1)"
    byPid[pid, default: [:]][ref] = element
    return ref
  }
  func lookup(_ pid: pid_t, _ ref: String) throws -> AXUIElement {
    guard let element = byPid[pid]?[ref] else {
      throw fail("Unknown or stale ref \(ref) for pid \(pid). Take a new snapshot first.")
    }
    return element
  }
}

let refs = RefTable()

// MARK: - Methods

func permissions() -> [String: Any] {
  ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
}

func requestPermissions() -> [String: Any] {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  let accessibility = AXIsProcessTrustedWithOptions(options)
  let screenRecording = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
  return ["accessibility": accessibility, "screenRecording": screenRecording]
}

func apps() -> [[String: Any]] {
  NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular }
    .map { app in
      var entry: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "name": app.localizedName ?? "",
        "active": app.isActive,
        "hidden": app.isHidden,
      ]
      if let bundleId = app.bundleIdentifier { entry["bundleId"] = bundleId }
      return entry
    }
}

func windows(pid filter: Int?) -> [[String: Any]] {
  guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  return info.compactMap { window in
    guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
          let id = window[kCGWindowNumber as String] as? Int,
          let owner = window[kCGWindowOwnerPID as String] as? Int else { return nil }
    if let filter, owner != filter { return nil }
    let boundsDict = window[kCGWindowBounds as String] as? [String: Any]
    let bounds = boundsDict.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
    // Off-screen helper windows (zero-size or tiny) are noise.
    if bounds.width < 40 || bounds.height < 40 { return nil }
    var entry: [String: Any] = [
      "windowId": id,
      "pid": owner,
      "app": window[kCGWindowOwnerName as String] as? String ?? "",
      "onScreen": window[kCGWindowIsOnscreen as String] as? Bool ?? false,
      "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height],
    ]
    // Titles are only visible with Screen Recording permission.
    if let title = window[kCGWindowName as String] as? String, !title.isEmpty { entry["title"] = title }
    return entry
  }
}

func appElement(_ pid: Int) throws -> AXUIElement {
  guard AXIsProcessTrusted() else { throw fail("Accessibility permission is not granted") }
  // NSRunningApplication lookups are unreliable off the main thread (they
  // intermittently return nil for a live app), so ask the kernel instead.
  guard pid > 0, kill(pid_t(pid), 0) == 0 else { throw fail("No running app with pid \(pid)") }
  return AXUIElementCreateApplication(pid_t(pid))
}

func findWindow(_ app: AXUIElement, _ id: Int?) throws -> AXUIElement {
  let all = axElements(app, kAXWindowsAttribute)
  guard !all.isEmpty else { throw fail("The app has no accessible windows") }
  guard let id else {
    return axElement(app, kAXFocusedWindowAttribute) ?? axElement(app, kAXMainWindowAttribute) ?? all[0]
  }
  guard let match = all.first(where: { windowId(of: $0) == CGWindowID(id) }) else {
    throw fail("Window \(id) does not belong to this app or is not accessible")
  }
  return match
}

/// Roles that carry no meaning of their own; when unlabeled they are elided and
/// their children promoted, which is the main lever on snapshot size.
let structuralRoles: Set<String> = [
  "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown",
]

struct SnapshotBudget {
  var nodesLeft: Int
  let maxDepth: Int
  var truncated = false
}

func describe(_ element: AXUIElement, pid: pid_t, depth: Int, budget: inout SnapshotBudget, lines: inout [String]) {
  if budget.nodesLeft <= 0 || depth > budget.maxDepth {
    budget.truncated = true
    return
  }
  let role = axString(element, kAXRoleAttribute) ?? "AXUnknown"
  let subrole = axString(element, kAXSubroleAttribute)
  let secure = subrole == "AXSecureTextField"
  let title = axString(element, kAXTitleAttribute)
  let label = axString(element, kAXDescriptionAttribute)
  let help = axString(element, kAXHelpAttribute)
  let identifier = axString(element, kAXIdentifierAttribute)
  let value = secure ? nil : axString(element, kAXValueAttribute)
  let actions = axActions(element).filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
  let children = axElements(element, kAXChildrenAttribute)

  let hasText = title != nil || label != nil || value != nil
  let elide = structuralRoles.contains(role) && !hasText && actions.isEmpty
  var childDepth = depth
  if !elide {
    budget.nodesLeft -= 1
    let ref = refs.add(pid, element)
    var parts = ["\(String(repeating: "  ", count: depth))- \(role.replacingOccurrences(of: "AX", with: "").lowercased())"]
    if let subrole, subrole != "AXStandardWindow" { parts.append("(\(subrole.replacingOccurrences(of: "AX", with: "")))") }
    if let title { parts.append("\"\(truncate(title, 120))\"") }
    if let label, label != title { parts.append("label=\"\(truncate(label, 120))\"") }
    if secure { parts.append("value=<redacted>") } else if let value, value != title { parts.append("value=\"\(truncate(value, 200))\"") }
    if let help, help != label { parts.append("help=\"\(truncate(help, 80))\"") }
    if let identifier { parts.append("id=\(truncate(identifier, 60))") }
    if axBool(element, kAXEnabledAttribute) == false { parts.append("disabled") }
    if axBool(element, kAXFocusedAttribute) == true { parts.append("focused") }
    if !actions.isEmpty { parts.append("actions=[\(actions.map { $0.replacingOccurrences(of: "AX", with: "") }.joined(separator: ","))]") }
    parts.append("[ref=\(ref)]")
    lines.append(parts.joined(separator: " "))
    childDepth = depth + 1
  }
  for child in children {
    describe(child, pid: pid, depth: childDepth, budget: &budget, lines: &lines)
  }
}

func snapshot(_ params: [String: Any]) throws -> [String: Any] {
  let pid = try intParam(params, "pid")
  let app = try appElement(pid)
  let window = try findWindow(app, optionalInt(params, "windowId"))
  refs.reset(pid_t(pid))
  var budget = SnapshotBudget(nodesLeft: optionalInt(params, "maxNodes") ?? 600, maxDepth: optionalInt(params, "maxDepth") ?? 40)
  var lines: [String] = []
  let started = Date()
  describe(window, pid: pid_t(pid), depth: 0, budget: &budget, lines: &lines)
  var result: [String: Any] = [
    "tree": lines.joined(separator: "\n"),
    "nodes": lines.count,
    "truncated": budget.truncated,
    "elapsedMs": Int(Date().timeIntervalSince(started) * 1000),
  ]
  if let id = windowId(of: window) { result["windowId"] = Int(id) }
  return result
}

func menu(_ params: [String: Any]) throws -> [String: Any] {
  let pid = try intParam(params, "pid")
  let app = try appElement(pid)
  guard let path = params["path"] as? [String], !path.isEmpty else { throw fail("Missing menu path") }
  guard var current = axElement(app, kAXMenuBarAttribute) else { throw fail("The app has no accessible menu bar") }
  for (index, name) in path.enumerated() {
    // Menu bar items hold an AXMenu child; menu items hold their submenu the same way.
    let items = axElements(current, kAXChildrenAttribute).flatMap { item -> [AXUIElement] in
      axString(item, kAXRoleAttribute) == "AXMenu" ? axElements(item, kAXChildrenAttribute) : [item]
    }
    guard let match = items.first(where: { axString($0, kAXTitleAttribute)?.caseInsensitiveCompare(name) == .orderedSame }) else {
      let available = items.compactMap { axString($0, kAXTitleAttribute) }.prefix(40).joined(separator: ", ")
      throw fail("No menu item \"\(name)\". Available: \(available)")
    }
    if index == path.count - 1 {
      if axBool(match, kAXEnabledAttribute) == false { throw fail("Menu item \"\(name)\" is disabled") }
      let error = AXUIElementPerformAction(match, kAXPressAction as CFString)
      guard error == .success else { throw fail("Pressing \"\(name)\" failed (AXError \(error.rawValue))") }
      return ["pressed": path.joined(separator: " > ")]
    }
    current = match
  }
  throw fail("Unreachable")
}

func press(_ params: [String: Any]) throws -> [String: Any] {
  let pid = try intParam(params, "pid")
  let element = try refs.lookup(pid_t(pid), try stringParam(params, "ref"))
  let action = (params["action"] as? String).map { $0.hasPrefix("AX") ? $0 : "AX\($0)" } ?? kAXPressAction
  let error = AXUIElementPerformAction(element, action as CFString)
  guard error == .success else { throw fail("\(action) failed (AXError \(error.rawValue))") }
  return ["performed": action]
}

/// Screen-point frame of a ref, for pointer fallbacks on elements whose
/// accessibility actions do nothing.
func frame(_ params: [String: Any]) throws -> [String: Any] {
  let pid = try intParam(params, "pid")
  let element = try refs.lookup(pid_t(pid), try stringParam(params, "ref"))
  guard let rect = axFrame(element) else { throw fail("That element has no frame") }
  return ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}

func setValue(_ params: [String: Any]) throws -> [String: Any] {
  let pid = try intParam(params, "pid")
  let element = try refs.lookup(pid_t(pid), try stringParam(params, "ref"))
  if axString(element, kAXSubroleAttribute) == "AXSecureTextField" {
    throw fail("Refusing to write into a password field")
  }
  let value = try stringParam(params, "value")
  let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
  guard error == .success else { throw fail("Setting the value failed (AXError \(error.rawValue))") }
  return ["set": true]
}

/// A fresh private source per call: a shared source remembers modifier state,
/// so a ⌘ shortcut would leave later typed text arriving as ⌘-chords.
func freshEventSource() -> CGEventSource? { CGEventSource(stateID: .privateState) }

func modifierFlags(_ params: [String: Any]) -> CGEventFlags {
  var flags: CGEventFlags = []
  for name in (params["modifiers"] as? [String]) ?? [] {
    switch name {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "option": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: break
    }
  }
  return flags
}

func type(_ params: [String: Any]) throws -> [String: Any] {
  let pid = pid_t(try intParam(params, "pid"))
  let text = try stringParam(params, "text")
  guard AXIsProcessTrusted() else { throw fail("Accessibility permission is not granted") }
  let eventSource = freshEventSource()
  // One event per UTF-16 chunk; CGEvent caps a unicode string at 20 units.
  let units = Array(text.utf16)
  var index = 0
  while index < units.count {
    let chunk = Array(units[index..<min(index + 20, units.count)])
    for keyDown in [true, false] {
      guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: keyDown) else {
        throw fail("Could not create a keyboard event")
      }
      chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
      event.flags = []
      event.postToPid(pid)
    }
    index += 20
    usleep(4_000)
  }
  return ["typed": units.count]
}

func key(_ params: [String: Any]) throws -> [String: Any] {
  let pid = pid_t(try intParam(params, "pid"))
  let keyCode = CGKeyCode(try intParam(params, "keyCode"))
  guard AXIsProcessTrusted() else { throw fail("Accessibility permission is not granted") }
  let flags = modifierFlags(params)
  let eventSource = freshEventSource()
  for keyDown in [true, false] {
    guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: keyDown) else {
      throw fail("Could not create a keyboard event")
    }
    event.flags = flags
    event.postToPid(pid)
  }
  return ["key": Int(keyCode)]
}

/// Coordinate click posted to one process. The user's pointer does not move.
/// Whether a background app honours it depends on the app; AppKit apps that
/// gate on key-window status may ignore the first click. Prefer `press`.
func click(_ params: [String: Any]) throws -> [String: Any] {
  let pid = pid_t(try intParam(params, "pid"))
  guard AXIsProcessTrusted() else { throw fail("Accessibility permission is not granted") }
  let point = CGPoint(x: Double(try intParam(params, "x")), y: Double(try intParam(params, "y")))
  let windowNumber = optionalInt(params, "windowId")
  let count = optionalInt(params, "clickCount") ?? 1
  let eventSource = freshEventSource()
  for type in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
    guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
      throw fail("Could not create a mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    if let windowNumber {
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowNumber))
      event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowNumber))
    }
    event.postToPid(pid)
    usleep(30_000)
  }
  return ["clicked": ["x": point.x, "y": point.y]]
}

func screenshot(_ params: [String: Any]) throws -> [String: Any] {
  let id = try intParam(params, "windowId")
  let outputPath = try stringParam(params, "path")
  guard CGPreflightScreenCaptureAccess() else { throw fail("Screen Recording permission is not granted") }
  let semaphore = DispatchSemaphore(value: 0)
  var outcome: Result<[String: Any], Error> = .failure(fail("Capture did not complete"))
  Task {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let window = content.windows.first(where: { $0.windowID == CGWindowID(id) }) else {
        throw fail("Window \(id) is not capturable")
      }
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let configuration = SCStreamConfiguration()
      let scale = CGFloat(filter.pointPixelScale)
      // Cap the long edge so a 5K window does not become a 15 MB tool result.
      let maxEdge = CGFloat(optionalInt(params, "maxEdge") ?? 1600)
      let factor = min(1, maxEdge / max(window.frame.width * scale, window.frame.height * scale))
      configuration.width = Int(window.frame.width * scale * factor)
      configuration.height = Int(window.frame.height * scale * factor)
      configuration.showsCursor = false
      configuration.ignoreShadowsSingleWindow = true
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
      let url = URL(fileURLWithPath: outputPath)
      guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw fail("Could not write \(outputPath)")
      }
      CGImageDestinationAddImage(destination, image, nil)
      guard CGImageDestinationFinalize(destination) else { throw fail("Could not encode the PNG") }
      outcome = .success([
        "path": outputPath,
        "width": image.width,
        "height": image.height,
        // Points-per-pixel so coordinate clicks can map image pixels back to screen points.
        "frame": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height],
      ])
    } catch {
      outcome = .failure(error)
    }
    semaphore.signal()
  }
  semaphore.wait()
  return try outcome.get()
}

/// Where the user's pointer is, which app is frontmost, and how long since the
/// user last touched the keyboard or pointer. Agent input must yield to a
/// present user, and these let the caller decide that.
func userActivity() -> [String: Any] {
  let location = NSEvent.mouseLocation
  let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
  var result: [String: Any] = ["pointer": ["x": location.x, "y": location.y], "idleSeconds": idle]
  if let front = NSWorkspace.shared.frontmostApplication {
    result["frontmostPid"] = Int(front.processIdentifier)
    if let bundleId = front.bundleIdentifier { result["frontmostBundleId"] = bundleId }
  }
  return result
}

func handle(_ method: String, _ params: [String: Any]) throws -> Any {
  switch method {
  case "userActivity": return userActivity()
  case "permissions": return permissions()
  case "requestPermissions": return requestPermissions()
  case "apps": return apps()
  case "windows": return windows(pid: optionalInt(params, "pid"))
  case "snapshot": return try snapshot(params)
  case "press": return try press(params)
  case "frame": return try frame(params)
  case "setValue": return try setValue(params)
  case "menu": return try menu(params)
  case "type": return try type(params)
  case "key": return try key(params)
  case "click": return try click(params)
  case "screenshot": return try screenshot(params)
  default: throw fail("Unknown method: \(method)")
  }
}

// MARK: - TCC identity
//
// macOS attributes Accessibility and Screen Recording to the *responsible*
// process, which for a plain child is the app that spawned it (Copse, or
// Electron in development). Re-spawning ourselves with responsibility
// disclaimed makes this helper its own TCC subject: the user grants
// "Copse Desktop Control" rather than all of Copse, the grant survives Copse
// dev/prod identity changes, and the Copse main process never holds
// Accessibility itself. stdio is inherited, so the parent sees no difference.

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let disclaimedFlag = "--disclaimed"
var disclaimedChild: pid_t = 0
if !CommandLine.arguments.contains(disclaimedFlag), ProcessInfo.processInfo.environment["COPSE_DESKTOP_NO_DISCLAIM"] == nil {
  var attrs: posix_spawnattr_t?
  posix_spawnattr_init(&attrs)
  _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)
  let executable = Bundle.main.executablePath ?? CommandLine.arguments[0]
  let argv = [executable] + CommandLine.arguments.dropFirst() + [disclaimedFlag]
  var cArgs = argv.map { strdup($0) } + [nil]
  let status = posix_spawn(&disclaimedChild, executable, nil, &attrs, &cArgs, environ)
  posix_spawnattr_destroy(&attrs)
  if status == 0 {
    // Forward termination so the parent's kill reaches the real helper.
    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig) { received in kill(disclaimedChild, received); exit(0) }
    }
    var childStatus: Int32 = 0
    waitpid(disclaimedChild, &childStatus, 0)
    exit((childStatus >> 8) & 0xff)
  }
  FileHandle.standardError.write("copse-desktop: disclaim spawn failed (\(status)); running undisclaimed\n".data(using: .utf8)!)
}

// MARK: - Main loop
//
// Requests are handled on a serial background queue so the main thread stays
// free for the run loop ScreenCaptureKit's async callbacks need.

let queue = DispatchQueue(label: "copse-desktop.requests")
queue.async {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = request["id"] else {
      emit(["ok": false, "error": "Malformed request"])
      continue
    }
    let method = request["method"] as? String ?? ""
    let params = request["params"] as? [String: Any] ?? [:]
    do {
      emit(["id": id, "ok": true, "result": try handle(method, params)])
    } catch let error as HelperError {
      emit(["id": id, "ok": false, "error": error.message])
    } catch {
      emit(["id": id, "ok": false, "error": String(describing: error)])
    }
  }
  exit(0)
}
emit(["ready": true, "permissions": permissions()])
RunLoop.main.run()
