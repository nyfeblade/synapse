import AppKit
import ApplicationServices
import Contacts
import CoreGraphics
import EventKit
import Foundation
import OSAKit

// JSON-lines Mac-app helper (bots-mac). One warm, long-lived process that drives the Mac for a Bot:
// it reads the screen through the Accessibility API, runs AppleScript / JavaScript for Automation
// through OSAKit, reports which permissions are actually granted, and presses, types and keys.
//
// It is WARM on purpose. Spawning `osascript` per action pays the compile cost every time and loses
// every bit of state; this process keeps the compiled scripts (64 of them) and — the part that
// matters — a STABLE element table, so `e12` still means the same button on the next read and the
// caller can diff two outlines the way it diffs two web pages.
//
// stdin: one JSON request per line —
//   {"id":1,"op":"ping"}
//   {"id":2,"op":"osa","lang":"js"|"as","source":"<script>","timeoutMs":8000,"app":"Calendar"}
//     "app" is an optional hint naming the app the script drives. It changes nothing about the run;
//     it only lets a timeout be told apart from macOS waiting on a consent decision (see below).
//   {"id":3,"op":"perms","apps":["Messages","Mail",…]}
//   {"id":4,"op":"ax","action":"outline","app":"Figma"}        app omitted = the frontmost app
//   {"id":5,"op":"ax","action":"press"|"focus","ref":"e12","app":"Figma"}
//   {"id":6,"op":"ax","action":"set","ref":"e12","value":"hello","app":"Figma"}
//   {"id":7,"op":"ax","action":"menu","value":"File > Save","app":"Figma"}
//   {"id":8,"op":"ax","action":"key","value":"cmd+s","app":"Figma"}
// stdout: EXACTLY one JSON reply per line, always echoing `id` —
//   {"id":1,"ok":true,"pong":true}
//   {"id":2,"ok":true,"result":"<the script's string result, verbatim>"}
//   {"id":3,"ok":true,"perms":{accessibility,contacts,calendars,reminders,automation:{App:…}}}
//   {"id":4,"ok":true,"app":"Figma","window":"Untitled","vh":900,"nodes":[…],"truncated":false}
//   {"id":N,"ok":false,"error":"<one plain sentence>","code":"permission"|"notfound"|"timeout"|"script"|"badrequest"}
//   press/set/menu/key/focus re-read the UI after acting, so a reply carries the new outline too.
// stderr: human-readable diagnostics, "[bots-mac +<ms>] …" (the app keeps the tail).
//
// A bad request NEVER kills the helper — it is answered with an error object and the loop goes on.
// The helper exits when stdin closes, and only then.
//
// NOTHING BLOCKS ANYTHING ELSE. An Apple event sent to an app whose Automation consent is still
// undecided does not return until the user decides — which may be never — so the helper runs in
// separate lanes: requests are dispatched concurrently, Apple events get a concurrent queue (one
// stuck app cannot stop a script to another), Accessibility gets a serial lane of its own with a
// per-call messaging timeout, and timeouts fire on a queue that does no work at all. A request that
// times out answers and is forgotten; the abandoned work may finish later, but it can never write a
// second reply for the same id. `perms` probes every app at once and caps each probe, so a Mac where
// nothing has been decided yet still answers in well under a second instead of hanging.
//
// A timeout and "macOS is waiting for the user to decide" look identical from inside the process, so
// the helper only calls it a permission when it can show its work: the request named the app AND a
// bounded consent probe came back saying undecided. Otherwise it says timeout and nothing more.
//
// A node is the shape the TypeScript outline renderer already eats for web pages, so the fields are
// not ours to rename: {ref, role, name, depth, y, h, interactive} plus the optional value, checked,
// expanded, disabled, focused, sensitive. `role` is the AX role mapped to short web-ish names
// (AXButton → button, AXStaticText → text, …) so a Mac outline reads like a browser one, `y` and `h`
// are RELATIVE TO THE FOCUSED WINDOW's top edge and `vh` is that window's height — which is what
// lets the TypeScript side prune far-off-screen nodes with exactly the web code path.
//
// The walk is deliberately mean: hard caps of 2,500 elements visited, 1,200 nodes emitted and 400 ms
// of wall time (whichever lands first sets "truncated":true), invisible / AXHidden subtrees dropped,
// and nameless unpressable groups and scroll areas skipped in favour of their children. `depth` only
// grows under a window, sheet, toolbar, tab group, list or table, so the outline stays flat and cheap.
//
// Flags, for the app's one-shot checks (no helper left running):
//   --perms                  answer one `perms` reply and exit
//   --prompt-accessibility   AXIsProcessTrustedWithOptions with the prompt — the ONE call here that
//                            is allowed to put a system dialog on screen — then print {ok,accessibility}
//
// Two refusals are hard-coded, not policy the caller can talk around: `set` will not write into a
// secure text field (that is a password), and `perms` passes askUserIfNeeded:false everywhere, so
// reading status can never itself raise a prompt.

setvbuf(stdout, nil, _IOLBF, 0)
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
  outLock.lock(); print(s); fflush(stdout); outLock.unlock()
}
let t0 = DispatchTime.now().uptimeNanoseconds
func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000 }
func log(_ s: String) {
  FileHandle.standardError.write("[bots-mac +\(Int(nowMs()))ms] \(s)\n".data(using: .utf8)!)
}

/// Every failure the protocol knows about. One sentence, one code; the caller decides what to say.
enum Code: String { case permission, notfound, timeout, script, badrequest }
func fail(_ id: Any, _ code: Code, _ sentence: String) {
  emit(["id": id, "ok": false, "error": sentence, "code": code.rawValue])
}

// MARK: - Walk limits

/// The whole point of the helper: an outline the model can afford to read. Caps, not suggestions.
let LIMIT_VISIT = 2500
let LIMIT_NODES = 1200
let LIMIT_WALK_MS = 400.0
let LIMIT_RECURSE = 25
/// How long an AX request may hang before we give up on that app (a beachballed app must not hang us).
let LIMIT_AX_TIMEOUT: Float = 2.0
/// How long the UI gets to settle before an action's re-read, so the caller diffs the new state.
let LIMIT_SETTLE_MS: UInt32 = 150_000
/// How long one Automation probe may take before it is abandoned and reported as "unknown".
let LIMIT_PROBE_MS = 300
/// The ceiling on a whole `perms` reply, however many apps it was asked about.
let LIMIT_PERMS_MS = 600
/// How many scripts may be in flight at once. Blocked Apple events pile up threads; past this the
/// honest answer is that we are not going to get to it.
let LIMIT_OSA_INFLIGHT = 16

// MARK: - Small concurrency tools

/// A locked value. Concurrent request handling means several threads touch the same box.
final class Box<T> {
  private let lock = NSLock()
  private var v: T
  init(_ v: T) { self.v = v }
  func get() -> T { lock.lock(); defer { lock.unlock() }; return v }
  func set(_ n: T) { lock.lock(); v = n; lock.unlock() }
  func mutate(_ f: (inout T) -> Void) { lock.lock(); f(&v); lock.unlock() }
}
/// The one-reply guarantee. A request that timed out and the work that was abandoned both race to
/// answer; whichever claims this first wins, and the loser stays silent. The protocol says EXACTLY
/// one object per request, and a second line for an id the caller has already closed would desync it.
final class Once {
  private let lock = NSLock()
  private var taken = false
  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if taken { return false }
    taken = true
    return true
  }
}

// MARK: - Accessibility plumbing

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}
func axString(_ el: AXUIElement, _ attr: String) -> String? {
  guard let s = axCopy(el, attr) as? String else { return nil }
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}
func axElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}
func axElements(_ el: AXUIElement, _ attr: String) -> [AXUIElement] {
  (axCopy(el, attr) as? [AXUIElement]) ?? []
}
func axActions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}
/// AXFrame when the app offers it, AXPosition + AXSize when it doesn't (both are AXValue boxes).
func axFrame(_ el: AXUIElement) -> CGRect? {
  if let v = axCopy(el, "AXFrame"), CFGetTypeID(v) == AXValueGetTypeID() {
    var r = CGRect.zero
    if AXValueGetValue((v as! AXValue), .cgRect, &r) { return r }
  }
  guard let pv = axCopy(el, kAXPositionAttribute as String), CFGetTypeID(pv) == AXValueGetTypeID(),
    let sv = axCopy(el, kAXSizeAttribute as String), CFGetTypeID(sv) == AXValueGetTypeID()
  else { return nil }
  var p = CGPoint.zero
  var s = CGSize.zero
  guard AXValueGetValue((pv as! AXValue), .cgPoint, &p), AXValueGetValue((sv as! AXValue), .cgSize, &s) else { return nil }
  return CGRect(origin: p, size: s)
}

/// Every attribute a node needs, fetched in ONE call. This matters more than anything else in the
/// walk: each AX attribute read is an IPC round trip into the other app, and a slow app (Finder is
/// one) spends ~6 ms per element when you ask thirteen times. Asked once, the same element costs one
/// trip — which is the difference between a truncated stub and the real outline inside the 400 ms cap.
let BATCH_ATTRS: [String] = [
  "AXRole", "AXSubrole", "AXHidden", "AXFrame", "AXPosition", "AXSize", "AXTitle", "AXDescription",
  "AXValue", "AXEnabled", "AXFocused", "AXExpanded", "AXHelp", "AXLabel",
]
func axBatch(_ el: AXUIElement) -> [String: CFTypeRef] {
  var out: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(el, BATCH_ATTRS as CFArray, AXCopyMultipleAttributeOptions(), &out) == .success,
    let vals = out as? [AnyObject], vals.count == BATCH_ATTRS.count
  else { return [:] }
  var d: [String: CFTypeRef] = [:]
  for (i, k) in BATCH_ATTRS.enumerated() {
    let v = vals[i] as CFTypeRef
    // An attribute the app does not have comes back as an AXValue holding an AXError, not as a gap.
    if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType((v as! AXValue)) == .axError { continue }
    d[k] = v
  }
  return d
}
func bString(_ d: [String: CFTypeRef], _ k: String) -> String? {
  guard let s = d[k] as? String else { return nil }
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}
func bFrame(_ d: [String: CFTypeRef]) -> CGRect? {
  if let v = d["AXFrame"], CFGetTypeID(v) == AXValueGetTypeID() {
    var r = CGRect.zero
    if AXValueGetValue((v as! AXValue), .cgRect, &r) { return r }
  }
  guard let pv = d["AXPosition"], let sv = d["AXSize"],
    CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID()
  else { return nil }
  var p = CGPoint.zero
  var s = CGSize.zero
  guard AXValueGetValue((pv as! AXValue), .cgPoint, &p), AXValueGetValue((sv as! AXValue), .cgSize, &s) else { return nil }
  return CGRect(origin: p, size: s)
}

/// AXUIElement is a CF type, so it needs CFEqual/CFHash to be a dictionary key. This is what makes a
/// `ref` stable: the same on-screen element hashes to the same slot on every re-read.
struct ElKey: Hashable {
  let el: AXUIElement
  init(_ el: AXUIElement) { self.el = el }
  static func == (a: ElKey, b: ElKey) -> Bool { CFEqual(a.el, b.el) }
  func hash(into h: inout Hasher) { h.combine(CFHash(el)) }
}

var refByEl: [ElKey: Int] = [:]
var elByRef: [Int: AXUIElement] = [:]
var refCounter = 0
/// Requests are handled concurrently now, so the ref tables are shared mutable state and need a lock.
/// Only the table is guarded — never an AX call, which could block for as long as the target app likes.
let refLock = NSLock()
/// `e<N>`, assigned once and kept for the life of the process.
func refFor(_ el: AXUIElement) -> String {
  let k = ElKey(el)
  refLock.lock()
  defer { refLock.unlock() }
  if let n = refByEl[k] { return "e\(n)" }
  refCounter += 1
  refByEl[k] = refCounter
  elByRef[refCounter] = el
  return "e\(refCounter)"
}
/// A ref only resolves while its element is still on screen — a stale one must read as notfound.
func resolveRef(_ ref: String) -> AXUIElement? {
  refLock.lock()
  let known = ref.hasPrefix("e") ? Int(ref.dropFirst()).flatMap { elByRef[$0] } : nil
  refLock.unlock()
  guard let el = known else { return nil }
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &v) == .success else { return nil }
  return el
}

// MARK: - Roles

/// The AX role vocabulary, mapped to the short web-ish names the outline renderer already speaks.
let ROLE_MAP: [String: String] = [
  "AXButton": "button", "AXStaticText": "text", "AXTextField": "textbox", "AXTextArea": "textbox",
  "AXSecureTextField": "textbox", "AXCheckBox": "checkbox", "AXRadioButton": "radio",
  "AXPopUpButton": "combobox", "AXComboBox": "combobox", "AXMenuItem": "menuitem", "AXLink": "link",
  "AXTabGroup": "tablist", "AXRadioGroup": "radiogroup", "AXSlider": "slider", "AXImage": "image",
  "AXGroup": "group", "AXWindow": "window", "AXSheet": "dialog", "AXToolbar": "toolbar",
  "AXList": "list", "AXTable": "table", "AXRow": "row", "AXScrollArea": "scrollarea",
]
/// Anything unmapped keeps its own name, minus the "AX" the model does not need to read.
func shortRole(_ ax: String) -> (role: String, mapped: Bool) {
  if let r = ROLE_MAP[ax] { return (r, true) }
  var s = ax
  if s.hasPrefix("AX") { s.removeFirst(2) }
  return (s.lowercased(), false)
}
let INTERACTIVE_ROLES: Set<String> = [
  "button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "slider", "tab", "row",
]
/// The containers worth an indent. Everything else stays flat, which is what keeps the outline cheap.
let DEPTH_ROLES: Set<String> = ["window", "dialog", "toolbar", "tablist", "list", "table"]

func clip(_ s: String) -> String {
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.count <= 160 ? t : String(t.prefix(159)) + "…"
}

// MARK: - The walk

final class WalkState {
  var nodes: [[String: Any]] = []
  var visited = 0
  var truncated = false
  let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(LIMIT_WALK_MS * 1_000_000)
  let windowTop: CGFloat
  init(windowTop: CGFloat) { self.windowTop = windowTop }
  /// One place to ask "have we spent enough?", so every cap sets the same honest `truncated` flag.
  var spent: Bool {
    if visited >= LIMIT_VISIT || nodes.count >= LIMIT_NODES || DispatchTime.now().uptimeNanoseconds > deadline {
      truncated = true
      return true
    }
    return false
  }
}

func walk(_ el: AXUIElement, depth: Int, level: Int, _ st: WalkState) {
  if level > LIMIT_RECURSE || st.spent { return }
  st.visited += 1
  let d = axBatch(el)
  let axRole = (d["AXRole"] as? String) ?? "AXUnknown"
  let (role, mapped) = shortRole(axRole)
  let subrole = d["AXSubrole"] as? String

  // Invisible is invisible: a zero or negative box, or AXHidden, takes its whole subtree with it.
  // The root is exempt — a top level that will not report its own frame (the login window does not)
  // still has a tree worth reading, and dropping it there would silently empty the whole outline.
  if (d["AXHidden"] as? Bool) == true, level > 0 { return }
  let frame = bFrame(d)
  if let f = frame, f.width <= 0 || f.height <= 0, level > 0 { return }

  let secure = axRole == "AXSecureTextField" || subrole == (kAXSecureTextFieldSubrole as String)
  let isTextField = role == "textbox"

  // name: title, then description, then a short value, then the label/help leftovers.
  var name = bString(d, "AXTitle") ?? bString(d, "AXDescription")
  if name == nil, let v = d["AXValue"] as? String, !secure {
    let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.isEmpty, t.count <= 160 { name = t }
  }
  if name == nil { name = bString(d, "AXLabel") ?? bString(d, "AXHelp") }

  // AXPress costs another round trip, so only ask where the answer can change the node: the roles
  // that could be interactive, and the nameless wrappers that are only kept because they press.
  let mayPress = INTERACTIVE_ROLES.contains(role) || ((role == "group" || role == "scrollarea" || !mapped) && name == nil)
  let pressable = mayPress && axActions(el).contains(kAXPressAction as String)

  // A nameless, unpressable wrapper is scaffolding, not content: emit its children in its place.
  let scaffold = (role == "group" || role == "scrollarea" || !mapped) && name == nil && !pressable
  var childDepth = depth
  if !scaffold {
    var node: [String: Any] = [
      "ref": refFor(el),
      "role": role,
      "name": clip(name ?? ""),
      "depth": depth,
      "y": Int(((frame?.origin.y ?? st.windowTop) - st.windowTop).rounded()),
      "h": Int((frame?.height ?? 0).rounded()),
      "interactive": INTERACTIVE_ROLES.contains(role) && (pressable || isTextField),
    ]
    if let v = d["AXValue"] as? String, !secure {
      let t = clip(v)
      if !t.isEmpty, t != (node["name"] as? String) { node["value"] = t }
    }
    if role == "checkbox" || role == "radio", let n = d["AXValue"] as? NSNumber {
      node["checked"] = n.intValue != 0
    }
    if let e = d["AXExpanded"] as? Bool { node["expanded"] = e }
    if (d["AXEnabled"] as? Bool) == false { node["disabled"] = true }
    if (d["AXFocused"] as? Bool) == true { node["focused"] = true }
    if secure { node["sensitive"] = "password" }
    st.nodes.append(node)
    if DEPTH_ROLES.contains(role) { childDepth = depth + 1 }
  }
  if st.spent { return }
  for c in axElements(el, kAXChildrenAttribute as String) {
    if st.spent { return }
    walk(c, depth: childDepth, level: level + 1, st)
  }
}

// MARK: - Target app

struct Target {
  let pid: pid_t
  let name: String
  let app: AXUIElement
}
/// The app a request means: the one it named, or whatever is frontmost when it named nothing.
func targetApp(_ wanted: String?) -> Target? {
  let running = NSWorkspace.shared.runningApplications
  var app: NSRunningApplication?
  if let w = wanted?.trimmingCharacters(in: .whitespaces), !w.isEmpty {
    app = running.first { $0.localizedName?.caseInsensitiveCompare(w) == .orderedSame }
      ?? running.first { $0.bundleIdentifier?.caseInsensitiveCompare(w) == .orderedSame }
      ?? running.first { ($0.localizedName ?? "").lowercased().contains(w.lowercased()) && $0.activationPolicy == .regular }
  } else {
    app = NSWorkspace.shared.frontmostApplication
  }
  guard let a = app, a.processIdentifier > 0 else { return nil }
  let el = AXUIElementCreateApplication(a.processIdentifier)
  AXUIElementSetMessagingTimeout(el, LIMIT_AX_TIMEOUT)
  return Target(pid: a.processIdentifier, name: a.localizedName ?? wanted ?? "", app: el)
}

/// The roles a real top-level window can have. AXApplication is emphatically not one of them.
let WINDOW_ROLES: Set<String> = ["AXWindow", "AXSheet", "AXDrawer", "AXPopover", "AXSystemDialog", "AXDialog"]

/// Why there is no outline. "The app has no window" and "we were not allowed to see its windows"
/// look almost identical from here and mean opposite things to a Bot, so they are kept apart.
enum WindowPick {
  case found(AXUIElement)
  case none
  case unreadable(String)
}

/// The window to read — and NOT the application element. When a process does not really have
/// Accessibility access, macOS does not fail the call: it returns PLACEHOLDERS. AXFocusedWindow,
/// AXMainWindow and every AXWindows entry come back as elements that CFEqual-match the app itself,
/// with role AXApplication, no frame and the app's name as their title. Measured on this Mac:
/// opening a second Finder window took AXWindows from 2 entries to 3, and every added entry was a
/// placeholder — so the windows ARE enumerated, they are just redacted.
///
/// That is why a placeholder is treated as a failed read and never as "no window". Reporting "no
/// open window" for an app whose window is plainly on screen sends the caller chasing the wrong
/// problem, and falling back to Finder's desktop (the one element that does survive redaction)
/// would hand back a confident two-node outline of the wrong thing.
func pickWindow(_ t: Target) -> WindowPick {
  var wv: CFTypeRef?
  let listErr = AXUIElementCopyAttributeValue(t.app, kAXWindowsAttribute as CFString, &wv)
  var candidates = (wv as? [AXUIElement]) ?? []
  // AXFocusedWindow is nil whenever the app is not frontmost, which is the normal case for a Bot
  // reading an app it has not activated, so the window LIST is the main path, not the fallback.
  if let w = axElement(t.app, kAXFocusedWindowAttribute as String) { candidates.insert(w, at: 0) }
  if let w = axElement(t.app, kAXMainWindowAttribute as String) { candidates.append(w) }

  let placeholders = candidates.filter { CFEqual($0, t.app) }.count
  let real = candidates.filter { !CFEqual($0, t.app) }
  func roleOf(_ e: AXUIElement) -> String { (axCopy(e, kAXRoleAttribute as String) as? String) ?? "" }
  func minimised(_ e: AXUIElement) -> Bool { (axCopy(e, "AXMinimized") as? Bool) == true }
  let live = real.filter { !minimised($0) }
  let pool = live.isEmpty ? real : live

  // A real, standard window wins outright — Finder's own window list also holds the desktop.
  if let w = pool.first(where: { (axCopy($0, kAXSubroleAttribute as String) as? String) == "AXStandardWindow" }) {
    return .found(w)
  }
  if let w = pool.first(where: { WINDOW_ROLES.contains(roleOf($0)) }) { return .found(w) }

  // No real window turned up. Before saying there is none, rule out the two ways a read can fail.
  switch listErr {
  case .cannotComplete, .apiDisabled, .notImplemented, .failure:
    return .unreadable("macOS would not report \(t.name)'s windows (Accessibility error \(listErr.rawValue)).")
  default: break
  }
  if placeholders > 0 {
    return .unreadable(
      "macOS returned \(placeholders) placeholder window\(placeholders == 1 ? "" : "s") for \(t.name) instead of the real ones, which means Synapse does not actually have Accessibility access even though the system reports it as trusted. Re-grant it in System Settings → Privacy & Security → Accessibility.")
  }
  // Some top levels are not window-role at all (the login window's is a group, Finder's desktop is a
  // scroll area). Accept one only when it is a distinct element that actually has children to read.
  if let w = pool.first(where: { !axElements($0, kAXChildrenAttribute as String).isEmpty }) { return .found(w) }
  return .none
}

/// One outline of the target app: the focused window (or its first window) walked under the caps.
func outline(_ t: Target, id: Any, extra: [String: Any] = [:]) {
  guard AXIsProcessTrusted() else {
    fail(id, .permission, "Synapse does not have Accessibility access yet, so it cannot read \(t.name).")
    return
  }
  let win: AXUIElement
  switch pickWindow(t) {
  case .found(let w):
    win = w
  case .none:
    log("outline \(t.name) pid=\(t.pid): no window")
    fail(id, .notfound, "\(t.name) has no open window to read. It may be hidden, minimised, or showing no window at all.")
    return
  case .unreadable(let why):
    // A failed read is NOT an empty app. Saying so plainly is the difference between the caller
    // fixing a permission and the caller believing the window is empty.
    log("outline \(t.name) pid=\(t.pid): unreadable — \(why)")
    fail(id, .permission, why)
    return
  }
  // A window whose own frame will not read is still worth walking (the login window is one), so the
  // viewport falls back to the screen rather than reporting a nonsense height of zero.
  let wf = axFrame(win)
  let usable = (wf?.height ?? 0) > 0
  let windowTop = usable ? wf!.origin.y : 0
  let vh = usable ? wf!.height : (NSScreen.main?.frame.height ?? 0)
  let st = WalkState(windowTop: windowTop)
  walk(win, depth: 0, level: 0, st)
  // An empty outline is almost never the truth — a window that is really on screen contains at least
  // itself. Answering ok:true here would tell a Bot the window is empty when in fact nothing was
  // read, which is the one failure shape that makes it act confidently on nothing.
  guard !st.nodes.isEmpty else {
    log("outline \(t.name) read nothing; visited=\(st.visited)")
    fail(id, .notfound, "\(t.name)'s window could not be read: it reported no visible elements. It may be hidden or minimised.")
    return
  }
  var reply: [String: Any] = [
    "id": id, "ok": true, "app": t.name,
    "window": axString(win, kAXTitleAttribute as String) ?? "",
    "vh": Int(vh.rounded()), "nodes": st.nodes,
  ]
  if st.truncated { reply["truncated"] = true }
  for (k, v) in extra { reply[k] = v }
  log("outline \(t.name) pid=\(t.pid) window=\(axString(win, kAXTitleAttribute as String) ?? "") nodes=\(st.nodes.count) visited=\(st.visited) truncated=\(st.truncated)")
  emit(reply)
}

// MARK: - Keys

/// cmd/shift/opt/ctrl plus the named keys and the plain a–z 0–9 — what a keyboard shortcut is made of.
let KEY_CODES: [String: CGKeyCode] = [
  "return": 36, "enter": 76, "tab": 48, "space": 49, "escape": 53, "esc": 53, "delete": 51,
  "backspace": 51, "up": 126, "down": 125, "left": 123, "right": 124,
  "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40,
  "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
  "w": 13, "x": 7, "y": 16, "z": 6,
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
]
func parseKey(_ spec: String) -> (CGKeyCode, CGEventFlags)? {
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  for raw in spec.lowercased().split(separator: "+") {
    let p = raw.trimmingCharacters(in: .whitespaces)
    switch p {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "opt", "option", "alt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default:
      guard let c = KEY_CODES[p] else { return nil }
      key = c
    }
  }
  guard let k = key else { return nil }
  return (k, flags)
}

// MARK: - Menus

/// One level of a menu path: the children of this item, or of the AXMenu it opens.
func menuChildren(_ el: AXUIElement) -> [AXUIElement] {
  let kids = axElements(el, kAXChildrenAttribute as String)
  if kids.count == 1, (axCopy(kids[0], kAXRoleAttribute as String) as? String) == "AXMenu" {
    return axElements(kids[0], kAXChildrenAttribute as String)
  }
  return kids
}
func findMenuItem(_ parent: AXUIElement, _ title: String) -> AXUIElement? {
  let want = title.trimmingCharacters(in: .whitespaces).lowercased()
  return menuChildren(parent).first {
    guard let t = axString($0, kAXTitleAttribute as String) else { return false }
    return t.lowercased() == want || t.lowercased().hasPrefix(want)
  }
}

// MARK: - Permissions

func mapCN(_ s: CNAuthorizationStatus) -> String {
  switch s {
  case .authorized, .limited: return "granted"
  case .notDetermined: return "unknown"
  default: return "denied"
  }
}
func mapEK(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .fullAccess, .writeOnly: return "granted"
  case .notDetermined: return "unknown"
  default: return "denied"
  }
}
/// The apps a Bot actually drives; anything else is looked up by its running process or on disk.
let BUNDLE_IDS: [String: String] = [
  "messages": "com.apple.MobileSMS", "mail": "com.apple.mail", "calendar": "com.apple.iCal",
  "reminders": "com.apple.reminders", "notes": "com.apple.Notes", "contacts": "com.apple.AddressBook",
  "music": "com.apple.Music", "finder": "com.apple.finder", "safari": "com.apple.Safari",
  "system events": "com.apple.systemevents", "photos": "com.apple.Photos", "terminal": "com.apple.Terminal",
]
func bundleId(for name: String) -> String? {
  let key = name.trimmingCharacters(in: .whitespaces).lowercased()
  if let b = BUNDLE_IDS[key], NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) != nil { return b }
  if let b = BUNDLE_IDS[key] { return b }
  if name.contains("."), NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) != nil { return name }
  if let r = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }) {
    return r.bundleIdentifier
  }
  for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices"] {
    let u = URL(fileURLWithPath: dir).appendingPathComponent("\(name).app")
    if let b = Bundle(url: u)?.bundleIdentifier { return b }
  }
  return nil
}
/// What a probe actually learned. `notDetermined` and `unresolved` both read as "unknown" on the
/// wire, but they are NOT the same thing and the helper must not pretend they are: notDetermined is
/// macOS telling us it would have to ask the user, unresolved is us giving up on a call that hung.
enum Automation { case granted, denied, notDetermined, unresolved }
func wireName(_ a: Automation) -> String {
  switch a {
  case .granted: return "granted"
  case .denied: return "denied"
  default: return "unknown"
  }
}
/// askUserIfNeeded is false and stays false — reading status must never put a dialog on screen.
///
/// It must also never HANG. On a Mac where consent is still undecided, AEDeterminePermissionToAutomateTarget
/// can sit inside launch services for tens of seconds (that is the bug that wedged the whole helper:
/// one undecided Calendar probe blocked every later request, Accessibility reads included). So the
/// call runs on a throwaway global-queue worker and we wait a hard 300 ms for it; a probe that has
/// not answered by then is abandoned — it may finish later, but nobody is listening and nothing of
/// ours is holding its thread.
func automationStatus(_ name: String, within ms: Int = LIMIT_PROBE_MS) -> Automation {
  let box = Box<Automation>(.unresolved)
  let done = DispatchSemaphore(value: 0)
  DispatchQueue.global(qos: .userInitiated).async {
    defer { done.signal() }
    guard let bid = bundleId(for: name) else { return box.set(.unresolved) }
    var addr = AEAddressDesc()
    let bytes = Array(bid.utf8)
    let made = bytes.withUnsafeBufferPointer { p in
      AECreateDesc(DescType(typeApplicationBundleID), p.baseAddress, p.count, &addr)
    }
    guard made == noErr else { return box.set(.unresolved) }
    defer { AEDisposeDesc(&addr) }
    switch AEDeterminePermissionToAutomateTarget(&addr, AEEventClass(typeWildCard), AEEventID(typeWildCard), false) {
    case noErr: box.set(.granted)
    case OSStatus(errAEEventNotPermitted): box.set(.denied)
    case OSStatus(errAEEventWouldRequireUserConsent): box.set(.notDetermined)
    default: box.set(.unresolved)  // procNotFound, a missing app, anything else we cannot claim
    }
  }
  if done.wait(timeout: .now() + .milliseconds(ms)) == .timedOut {
    log("automation probe for \(name) did not answer in \(ms) ms; reporting unknown")
    return .unresolved
  }
  return box.get()
}
/// Every app probed at once, and the whole op capped: `perms` backs the Settings panel, which
/// re-checks on focus, so it has to answer fast every single time even when nothing is decided yet.
func permsReply(_ id: Any, apps: [String]) {
  let results = Box<[String: String]>([:])
  let group = DispatchGroup()
  for a in apps {
    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      let s = wireName(automationStatus(a))
      results.mutate { $0[a] = s }
      group.leave()
    }
  }
  _ = group.wait(timeout: .now() + .milliseconds(LIMIT_PERMS_MS))
  var automation = results.get()
  for a in apps where automation[a] == nil { automation[a] = "unknown" }
  emit([
    "id": id, "ok": true,
    "perms": [
      "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
      "contacts": mapCN(CNContactStore.authorizationStatus(for: .contacts)),
      "calendars": mapEK(EKEventStore.authorizationStatus(for: .event)),
      "reminders": mapEK(EKEventStore.authorizationStatus(for: .reminder)),
      "automation": automation,
    ],
  ])
}

// MARK: - OSA, compiled once and kept

/// The warm-helper win: a repeated action pays the compile cost exactly once. 64 scripts, oldest out.
final class ScriptCache {
  private let lock = NSLock()
  private var scripts: [String: OSAScript] = [:]
  private var order: [String] = []
  func get(lang: String, source: String) -> OSAScript? {
    let key = "\(lang)\u{1}\(source.hashValue)\u{1}\(source.count)"
    lock.lock()
    defer { lock.unlock() }
    if let s = scripts[key] { return s }
    let langName = lang == "as" || lang.lowercased().hasPrefix("apple") ? "AppleScript" : "JavaScript"
    guard let l = OSALanguage(forName: langName) else { return nil }
    let s = OSAScript(source: source, language: l)
    var err: NSDictionary?
    guard s.compileAndReturnError(&err) else { return nil }
    scripts[key] = s
    order.append(key)
    if order.count > 64, let oldest = order.first { order.removeFirst(); scripts.removeValue(forKey: oldest) }
    return s
  }
}
let scriptCache = ScriptCache()
/// CONCURRENT, deliberately. An Apple event to an app whose consent is undecided does not return
/// until the user decides, so a serial queue here means one undecided Calendar event stops every
/// later script — including one to an app that was granted long ago. Each run gets its own thread.
let osaQueue = DispatchQueue(label: "bots-mac.osa", attributes: .concurrent)
/// The timeouts fire here, never on a queue that does real work, so a timer is always on time.
let timerQueue = DispatchQueue(label: "bots-mac.timers")
/// Accessibility's own lane: serial among itself, and never shared with Apple events. Each AX call
/// is bounded by AXUIElementSetMessagingTimeout, so this lane cannot be held open indefinitely.
let axQueue = DispatchQueue(label: "bots-mac.ax")
let osaInflight = Box<Int>(0)

/// Runs a script WITHOUT blocking the caller's thread. The reply comes either from the script or
/// from the timeout, whichever claims `once` first; the loser is dropped. A script that is still
/// stuck when its timeout fires keeps running on its own thread until macOS lets it go — we simply
/// stop caring, which is the difference between one wedged app and one wedged helper.
func runOSA(_ id: Any, lang: String, source: String, timeoutMs: Double, app: String?, done: @escaping () -> Void) {
  guard !source.isEmpty else {
    fail(id, .badrequest, "The osa request has no script source.")
    return done()
  }
  let inflight = osaInflight.get()
  guard inflight < LIMIT_OSA_INFLIGHT else {
    fail(id, .timeout, "\(inflight) scripts are already waiting on apps that have not answered; this one was not started.")
    return done()
  }
  let ms = Int(max(100, timeoutMs))
  let once = Once()
  osaInflight.mutate { $0 += 1 }
  osaQueue.async {
    defer { osaInflight.mutate { $0 -= 1 } }
    // Compiling happens here too, so even a slow compile never holds the request thread.
    guard let script = scriptCache.get(lang: lang, source: source) else {
      if once.claim() {
        fail(id, .script, "That \(lang == "as" ? "AppleScript" : "JavaScript") would not compile.")
        done()
      }
      return
    }
    var err: NSDictionary?
    let d = script.executeAndReturnError(&err)
    guard once.claim() else {
      log("script for id \(id) came back after its timeout; the reply was already sent")
      return
    }
    defer { done() }
    if let e = err {
      let m = (e["OSAScriptErrorMessage"] as? String) ?? (e["NSLocalizedDescription"] as? String) ?? "the script failed"
      let n = (e["OSAScriptErrorNumber"] as? NSNumber)?.intValue ?? 0
      // -1743 / -1744: the Mac will not let Synapse send Apple events there yet. That is a permission.
      if n == -1743 || n == -1744 {
        return fail(id, .permission, "Synapse is not allowed to control that app yet: \(m)")
      }
      return fail(id, .script, m)
    }
    emit(["id": id, "ok": true, "result": d?.stringValue ?? ""])
  }
  timerQueue.asyncAfter(deadline: .now() + .milliseconds(ms)) {
    guard once.claim() else { return }
    // The consent probe below can take up to LIMIT_PROBE_MS, so it happens off the timer queue —
    // one script's diagnosis must not delay another script's deadline.
    DispatchQueue.global(qos: .userInitiated).async {
      defer { done() }
      // A hung script has two very different causes and we only name the one we can prove: if the
      // request said which app it drives and macOS reports that app's consent as still undecided,
      // the script is sitting behind a consent decision, not running slowly. Anything else — no app
      // named, or a probe that would not answer either — stays an honest timeout.
      if let a = app, automationStatus(a) == .notDetermined {
        return fail(id, .permission, "macOS is waiting for you to allow Synapse to control \(a). Answer that prompt, or allow it in System Settings → Privacy & Security → Automation.")
      }
      fail(id, .timeout, "The script was still running after \(ms) ms.")
    }
  }
}

// MARK: - The ax op

func handleAX(_ id: Any, _ req: [String: Any]) {
  let action = (req["action"] as? String) ?? "outline"
  guard let t = targetApp(req["app"] as? String) else {
    fail(id, .notfound, "\((req["app"] as? String) ?? "The frontmost app") is not running.")
    return
  }
  guard AXIsProcessTrusted() else {
    fail(id, .permission, "Synapse does not have Accessibility access yet, so it cannot control \(t.name).")
    return
  }
  let value = req["value"] as? String

  /// press / set / focus all start the same way: a ref that still points at something on screen.
  func element() -> AXUIElement? {
    guard let r = req["ref"] as? String else {
      fail(id, .badrequest, "That \(action) request is missing a ref.")
      return nil
    }
    guard let el = resolveRef(r) else {
      fail(id, .notfound, "\(r) is no longer on screen. Read the app again with action outline.")
      return nil
    }
    return el
  }

  switch action {
  case "outline":
    outline(t, id: id)

  case "press":
    guard let el = element() else { return }
    let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    guard err == .success else {
      return fail(id, .notfound, "That element would not accept a press.")
    }
    usleep(LIMIT_SETTLE_MS)
    outline(t, id: id)

  case "focus":
    guard let el = element() else { return }
    let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard err == .success else { return fail(id, .notfound, "That element cannot take keyboard focus.") }
    usleep(LIMIT_SETTLE_MS)
    outline(t, id: id)

  case "set":
    guard let el = element() else { return }
    guard let v = value else { return fail(id, .badrequest, "That set request is missing a value.") }
    // Hard refusal, not a policy the caller can argue with: never type into a credential field.
    let role = (axCopy(el, kAXRoleAttribute as String) as? String) ?? ""
    let subrole = (axCopy(el, kAXSubroleAttribute as String) as? String) ?? ""
    if role == "AXSecureTextField" || subrole == (kAXSecureTextFieldSubrole as String) {
      return fail(id, .permission, "Refused: that field holds a password or another credential.")
    }
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, v as CFTypeRef)
    guard err == .success else { return fail(id, .notfound, "That element would not take a new value.") }
    usleep(LIMIT_SETTLE_MS)
    outline(t, id: id)

  case "menu":
    guard let path = value, !path.isEmpty else {
      return fail(id, .badrequest, "That menu request is missing a path like \"File > Save\".")
    }
    guard let bar = axElement(t.app, kAXMenuBarAttribute as String) else {
      return fail(id, .notfound, "\(t.name) has no menu bar.")
    }
    let parts = path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    var cursor = bar
    for (i, part) in parts.enumerated() {
      guard let next = findMenuItem(cursor, part) else {
        AXUIElementPerformAction(bar, "AXCancel" as CFString)
        return fail(id, .notfound, "There is no \"\(part)\" in \(t.name)'s \(i == 0 ? "menu bar" : "\(parts[i - 1]) menu").")
      }
      // Opening each menu on the way down is what makes the next level's items exist to be found.
      AXUIElementPerformAction(next, kAXPressAction as CFString)
      cursor = next
      if i < parts.count - 1 { usleep(80_000) }
    }
    usleep(LIMIT_SETTLE_MS)
    outline(t, id: id)

  case "key":
    guard let spec = value, let (code, flags) = parseKey(spec) else {
      return fail(id, .badrequest, "\"\(value ?? "")\" is not a keyboard shortcut this helper knows.")
    }
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
      let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    else { return fail(id, .permission, "macOS would not let Synapse post a key event.") }
    down.flags = flags
    up.flags = flags
    down.postToPid(t.pid)
    usleep(15_000)
    up.postToPid(t.pid)
    usleep(LIMIT_SETTLE_MS)
    outline(t, id: id)

  default:
    fail(id, .badrequest, "\"\(action)\" is not an ax action this helper knows.")
  }
}

// MARK: - Request loop

/// `done` fires when this request's one reply has been written — not when `handle` returns, which
/// for a script is long before. It is what lets stdin's close wait for real answers instead of
/// guessing at a grace period.
func handle(_ line: String, done: @escaping () -> Void) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return done() }
  guard let d = trimmed.data(using: .utf8),
    let req = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  else {
    fail(0, .badrequest, "That line was not a JSON object.")
    return done()
  }
  let id = req["id"] ?? 0
  guard let op = req["op"] as? String else {
    fail(id, .badrequest, "That request has no op.")
    return done()
  }
  switch op {
  case "ping":
    emit(["id": id, "ok": true, "pong": true])
    done()
  case "osa":
    runOSA(
      id, lang: (req["lang"] as? String) ?? "js", source: (req["source"] as? String) ?? "",
      timeoutMs: (req["timeoutMs"] as? NSNumber)?.doubleValue ?? 8000, app: req["app"] as? String,
      done: done)
  case "perms":
    permsReply(id, apps: (req["apps"] as? [String]) ?? [])
    done()
  case "ax":
    // The Accessibility walk keeps a lane of its own. It is the one path that must stay responsive
    // while Apple events are stuck, and serialising it among itself keeps the ref table's churn
    // predictable without ever putting it behind an app that has not answered.
    axQueue.async {
      handleAX(id, req)
      done()
    }
  default:
    fail(id, .badrequest, "\"\(op)\" is not an op this helper knows.")
    done()
  }
}

// One-shot flags, so the app can read status (or ask for Accessibility once) without a warm helper.
let args = CommandLine.arguments.dropFirst()
if args.contains("--prompt-accessibility") {
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  emit(["ok": true, "accessibility": AXIsProcessTrustedWithOptions(opts)])
  exit(0)
}
if args.contains("--perms") {
  permsReply(0, apps: Array(BUNDLE_IDS.keys.sorted().map { $0.capitalized }))
  exit(0)
}

log("start warm helper; accessibility=\(AXIsProcessTrusted())")
/// CONCURRENT. A serial request queue was the wedge: one request waiting on a blocked Apple event
/// held the queue, so every later request — a ping, an Accessibility read of an unrelated app —
/// waited behind an app that might never answer. Requests are independent, so they run independently.
let q = DispatchQueue(label: "bots-mac.requests", attributes: .concurrent)
/// Requests that have been handed to a lane but have not written their reply yet. A concurrent queue
/// has no natural "everything before this is finished" point, so the count is the drain signal.
let pending = Box<Int>(0)
Thread {
  while let line = readLine() {
    pending.mutate { $0 += 1 }
    q.async { handle(line) { pending.mutate { $0 -= 1 } } }
  }
  // stdin closing is the only way out, but the last requests still deserve their answers. Every
  // lane is bounded (a script by its timeoutMs, a probe by 300 ms, an AX call by its messaging
  // timeout), so this drains in a moment; the ceiling is only there so a pathological app cannot
  // keep a helper nobody is talking to alive forever.
  log("stdin closed; draining \(pending.get()) request(s)")
  let giveUp = Date().addingTimeInterval(30)
  while pending.get() > 0, Date() < giveUp { usleep(10_000) }
  exit(0)
}.start()
RunLoop.main.run()
