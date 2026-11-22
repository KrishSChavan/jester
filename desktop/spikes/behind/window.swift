import AppKit
import WebKit

// A window of my own for trying jester-driver on: a button, a canvas that says nothing to accessibility,
// a text field, a text view and a menu command. What happened to it is in its title.
final class Canvas: NSView {
    var clicks = 0, rights = 0, doubles = 0, drags = 0, last = NSPoint.zero
    var onChange: (() -> Void)?
    override func draw(_ dirty: NSRect) {
        (clicks % 2 == 0 ? NSColor(white: 0.25, alpha: 1) : NSColor(white: 0.85, alpha: 1)).setFill(); bounds.fill()
    }
    override func isAccessibilityElement() -> Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { clicks += 1; if e.clickCount == 2 { doubles += 1 }; last = convert(e.locationInWindow, from: nil); needsDisplay = true; onChange?() }
    override func rightMouseDown(with e: NSEvent) { rights += 1; onChange?() }
    override func mouseDragged(with e: NSEvent) { drags += 1; last = convert(e.locationInWindow, from: nil); onChange?() }
}
final class Delegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var window: NSWindow!, canvas: Canvas!, label: NSTextField!, field: NSTextField!, text: NSTextView!
    var presses = 0, stamps = 0, picks = 0, pings = 0
    var webView: WKWebView?, webTitle = ""
    var menuItem: NSStatusItem!, panelItem: NSStatusItem!, panel: NSPanel?
    func title() {
        window.title = "fixture presses=\(presses) canvas=\(canvas.clicks) right=\(canvas.rights) double=\(canvas.doubles) drags=\(canvas.drags) at=\(Int(canvas.last.x)),\(Int(canvas.last.y)) stamps=\(stamps) picks=\(picks) pings=\(pings)" + (webTitle.isEmpty ? "" : " || " + webTitle)
    }
    @objc func pick() { picks += 1; title() }
    @objc func ping() { pings += 1; title() }
    @objc func togglePanel() {
        if let open = panel { open.close(); panel = nil; return }
        guard let button = panelItem.button, let anchor = button.window else { return }
        let at = anchor.convertToScreen(button.convert(button.bounds, to: nil))
        let p = NSPanel(contentRect: NSRect(x: at.minX - 100, y: at.minY - 150, width: 240, height: 140), styleMask: [.nonactivatingPanel, .titled], backing: .buffered, defer: false)
        p.level = .popUpMenu; p.title = "FixPanel"
        let box = NSButton(checkboxWithTitle: "Turbo", target: nil, action: nil); box.frame = NSRect(x: 20, y: 80, width: 120, height: 24); p.contentView!.addSubview(box)
        let go = NSButton(title: "Ping", target: self, action: #selector(ping)); go.frame = NSRect(x: 20, y: 30, width: 90, height: 30); p.contentView!.addSubview(go)
        p.orderFrontRegardless(); panel = p
    }
    @objc func pressed() { presses += 1; label.stringValue = "Presses: \(presses)"; title() }
    @objc func stamp() { stamps += 1; title() }
    func applicationDidFinishLaunching(_ n: Notification) {
        let menu = NSMenu(), app = NSMenuItem(), file = NSMenuItem()
        menu.addItem(app); menu.addItem(file)
        app.submenu = NSMenu(title: "Fixture")
        let fileMenu = NSMenu(title: "File"); file.submenu = fileMenu
        fileMenu.addItem(NSMenuItem(title: "Stamp", action: #selector(stamp), keyEquivalent: "t"))
        let shifted = NSMenuItem(title: "Send Stamp", action: #selector(stamp), keyEquivalent: "D"); fileMenu.addItem(shifted)
        NSApp.mainMenu = menu
        let args = CommandLine.arguments
        let x = args.count > 2 ? Double(args[2]) ?? 20 : 20, y = args.count > 3 ? Double(args[3]) ?? 60 : 60
        window = NSWindow(contentRect: NSRect(x: x, y: y, width: 420, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        let v = window.contentView!
        let button = NSButton(title: "Count", target: self, action: #selector(pressed)); button.frame = NSRect(x: 20, y: 255, width: 90, height: 30); v.addSubview(button)
        label = NSTextField(labelWithString: "Presses: 0"); label.frame = NSRect(x: 130, y: 258, width: 150, height: 22); v.addSubview(label)
        field = NSTextField(string: "milk, eggs"); field.frame = NSRect(x: 20, y: 215, width: 380, height: 24); field.setAccessibilityLabel("Shopping"); v.addSubview(field)
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 120, width: 380, height: 85)); scroll.hasVerticalScroller = true
        text = NSTextView(frame: NSRect(x: 0, y: 0, width: 365, height: 85)); text.string = "The quick brown fox.\nSecond line here."; text.setAccessibilityLabel("Notes")
        scroll.documentView = text; v.addSubview(scroll)
        canvas = Canvas(frame: NSRect(x: 20, y: 15, width: 380, height: 95)); canvas.onChange = { [weak self] in self?.title() }; v.addSubview(canvas)
        if args.contains("web") {
            window.setFrame(NSRect(x: x, y: y, width: 420, height: 560), display: true)
            let web = WKWebView(frame: NSRect(x: 0, y: 300, width: 420, height: 230))
            let page = try! String(contentsOfFile: (CommandLine.arguments[0] as NSString).deletingLastPathComponent + "/page.html", encoding: .utf8)
            web.loadHTMLString(page, baseURL: nil)
            window.contentView!.addSubview(web)
            webView = web
            Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in web.evaluateJavaScript("document.title") { value, _ in self?.webTitle = value as? String ?? ""; self?.title() } }
        }
        if args.contains("icons") {
            menuItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            menuItem.button?.title = "FixMenu"; menuItem.button?.setAccessibilityLabel("FixMenu")
            let m = NSMenu(); m.addItem(NSMenuItem(title: "Alpha", action: #selector(pick), keyEquivalent: "")); m.addItem(NSMenuItem(title: "Sign Out Beta", action: #selector(pick), keyEquivalent: ""))
            menuItem.menu = m
            panelItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            panelItem.button?.title = "FixPanel"; panelItem.button?.setAccessibilityLabel("FixPanel")
            panelItem.button?.target = self; panelItem.button?.action = #selector(togglePanel)
        }
        title()
        // Shown without taking the front: the user's app keeps it.
        if args.contains("back") { window.orderBack(nil) } else { window.orderFrontRegardless() }
        let seconds = args.count > 1 ? Double(args[1]) ?? 30 : 30
        print("pid \(ProcessInfo.processInfo.processIdentifier) window \(window.windowNumber)"); fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
