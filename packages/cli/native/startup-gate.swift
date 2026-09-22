import AppKit
import Foundation

private func publish(_ event: String, error: String? = nil) {
    var value: [String: Any] = ["event": event]
    if let error { value["error"] = error }
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func processStart(_ pid: pid_t) -> String? {
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-p", String(pid), "-o", "lstart="]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        let value = String(
            data: output.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        process.waitUntilExit()
        return process.terminationStatus == 0 ? value : nil
    } catch { return nil }
}

private final class CordisXMarkView: NSView {
    private let light = CommandLine.arguments.count > 1 ? NSImage(contentsOfFile: CommandLine.arguments[1]) : nil
    private let dark = CommandLine.arguments.count > 2 ? NSImage(contentsOfFile: CommandLine.arguments[2]) : nil

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let appearance = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
        if let image = appearance == .darkAqua ? dark : light {
            image.draw(in: bounds.insetBy(dx: 5, dy: 0))
            return
        }
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        NSColor.labelColor.setStroke()
        for angle in [0.0, 60.0, -60.0] {
            let path = NSBezierPath(ovalIn: NSRect(x: center.x - 35, y: center.y - 13, width: 70, height: 26))
            var transform = AffineTransform()
            transform.translate(x: center.x, y: center.y)
            transform.rotate(byDegrees: angle)
            transform.translate(x: -center.x, y: -center.y)
            path.transform(using: transform)
            path.lineWidth = 4
            path.stroke()
        }
    }
}

private final class StartupGateDelegate: NSObject, NSApplicationDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 420, height: 270),
        styleMask: [.titled, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    private let status = NSTextField(labelWithString: "正在启动 CordisX")
    private let detail = NSTextField(labelWithString: "正在检查运行配置")
    private let progress = NSProgressIndicator()
    private let retry = NSButton(title: "重试", target: nil, action: nil)
    private let cancel = NSButton(title: "关闭", target: nil, action: nil)
    private var hostIdentity: (pid: pid_t, startedAt: String)?
    private var terminal = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureWindow()
        startReader()
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        publish("visible")
    }

    private func configureWindow() {
        window.title = "CordisX"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.backgroundColor = NSColor.windowBackgroundColor
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true

        let mark = CordisXMarkView()
        mark.translatesAutoresizingMaskIntoConstraints = false
        mark.widthAnchor.constraint(equalToConstant: 86).isActive = true
        mark.heightAnchor.constraint(equalToConstant: 76).isActive = true

        let title = NSTextField(labelWithString: "CordisX")
        title.font = .systemFont(ofSize: 25, weight: .semibold)
        title.alignment = .center
        status.font = .systemFont(ofSize: 15, weight: .medium)
        status.alignment = .center
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.maximumNumberOfLines = 3
        detail.lineBreakMode = .byWordWrapping
        progress.style = .spinning
        progress.controlSize = .small
        progress.startAnimation(nil)

        retry.target = self
        retry.action = #selector(retryStartup(_:))
        retry.keyEquivalent = "\r"
        cancel.target = self
        cancel.action = #selector(cancelStartup(_:))
        retry.isHidden = true
        cancel.isHidden = true
        let actions = NSStackView(views: [cancel, retry])
        actions.orientation = .horizontal
        actions.spacing = 10

        let stack = NSStackView(views: [mark, title, status, detail, progress, actions])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(2, after: status)
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = NSView()
        window.contentView?.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor, constant: 5),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: window.contentView!.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: window.contentView!.trailingAnchor, constant: -32),
            detail.widthAnchor.constraint(lessThanOrEqualToConstant: 340),
        ])
    }

    private func startReader() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.receive(object) }
            }
            DispatchQueue.main.async {
                guard let self, !self.terminal else { return }
                self.terminal = true
                NSApplication.shared.terminate(nil)
            }
        }
    }

    private func receive(_ value: [String: Any]) {
        guard let event = value["event"] as? String else { return }
        switch event {
        case "stage":
            showLoading(value["message"] as? String ?? "正在准备 CordisX")
        case "host-launched":
            guard let number = value["pid"] as? NSNumber,
                  let startedAt = value["startedAt"] as? String else {
                publish("gate-error", error: "Host identity is incomplete")
                return
            }
            hideHost(pid: number.int32Value, startedAt: startedAt)
        case "ready":
            guard let number = value["pid"] as? NSNumber,
                  let startedAt = value["startedAt"] as? String else {
                publish("gate-error", error: "Ready Host identity is incomplete")
                return
            }
            revealHost(pid: number.int32Value, startedAt: startedAt)
        case "failed":
            showFailure(value["message"] as? String ?? "CordisX 启动失败")
        case "close":
            terminal = true
            NSApplication.shared.terminate(nil)
        default: break
        }
    }

    private func showLoading(_ message: String) {
        status.stringValue = message
        detail.stringValue = "请稍候，完整应用准备好后会自动打开。"
        detail.textColor = .secondaryLabelColor
        progress.isHidden = false
        progress.startAnimation(nil)
        retry.isHidden = true
        cancel.isHidden = true
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func hideHost(pid: pid_t, startedAt: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard processStart(pid) == startedAt else {
                DispatchQueue.main.async { publish("gate-error", error: "Host identity changed before startup gate") }
                return
            }
            var host: NSRunningApplication?
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline && host == nil {
                host = NSRunningApplication(processIdentifier: pid)
                if host == nil { Thread.sleep(forTimeInterval: 0.02) }
            }
            DispatchQueue.main.async {
                guard let self, let host else {
                    publish("gate-error", error: "Host process was unavailable to startup gate")
                    return
                }
                self.hostIdentity = (pid, startedAt)
                // The owned Electron main-process visibility agent prevents
                // BrowserWindow.show before renderer readiness. This helper
                // verifies identity and owns the single visible loading UI.
                _ = host
                NSApplication.shared.activate(ignoringOtherApps: true)
                self.window.makeKeyAndOrderFront(nil)
                publish("host-hidden")
            }
        }
    }

    private func revealHost(pid: pid_t, startedAt: String) {
        let identity = hostIdentity ?? (pid, startedAt)
        guard identity.pid == pid, identity.startedAt == startedAt,
              processStart(pid) == startedAt,
              let host = NSRunningApplication(processIdentifier: pid) else {
            publish("gate-error", error: "Ready Host identity is unavailable")
            return
        }
        _ = host.unhide()
        let activated: Bool
        if #available(macOS 14.0, *) {
            activated = host.activate(from: NSRunningApplication.current, options: [.activateAllWindows])
        } else {
            activated = host.activate(options: [.activateAllWindows])
        }
        guard activated else {
            publish("gate-error", error: "Ready Host could not be activated")
            return
        }
        terminal = true
        publish("ready")
        window.orderOut(nil)
        NSApplication.shared.terminate(nil)
    }

    private func showFailure(_ message: String) {
        status.stringValue = "CordisX 启动失败"
        detail.stringValue = message
        detail.textColor = .systemRed
        progress.stopAnimation(nil)
        progress.isHidden = true
        retry.isHidden = false
        cancel.isHidden = false
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func retryStartup(_ sender: Any?) {
        showLoading("正在重试")
        publish("retry")
    }

    @objc private func cancelStartup(_ sender: Any?) {
        terminal = true
        publish("dismiss")
        NSApplication.shared.terminate(nil)
    }
}

let application = NSApplication.shared
private let delegate = StartupGateDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
