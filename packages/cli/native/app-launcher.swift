import AppKit
import Foundation

func launcherFailure(_ message: String) -> NSError {
    NSError(domain: "CordisXLauncher", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

func launcherObject(_ path: String) throws -> [String: Any] {
    var attrs = stat()
    guard lstat(path, &attrs) == 0, (attrs.st_mode & S_IFMT) == S_IFREG,
          attrs.st_uid == getuid(), (attrs.st_mode & 0o077) == 0 else {
        throw launcherFailure("Unsafe CordisX runtime permissions")
    }
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
        as? [String: Any] else { throw launcherFailure("Invalid CordisX runtime") }
    return value
}

func launcherOutput(_ process: Process, _ pipe: Pipe, timeout: Double) throws -> Data {
    let lock = NSLock(), terminated = DispatchSemaphore(value: 0), readDone = DispatchSemaphore(value: 0)
    var bytes = Data(), oversized = false
    process.terminationHandler = { _ in terminated.signal() }
    try process.run()
    DispatchQueue.global().async {
        while true {
            let chunk = pipe.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            lock.lock()
            if bytes.count + chunk.count > 96 * 1024 { oversized = true }
            else { bytes.append(chunk) }
            let stop = oversized
            lock.unlock()
            if stop { process.terminate(); break }
        }
        readDone.signal()
    }
    guard terminated.wait(timeout: .now() + .milliseconds(Int(timeout * 1000))) == .success else {
        if process.isRunning { process.terminate() }
        throw launcherFailure("CordisX operation timed out")
    }
    guard readDone.wait(timeout: .now() + 2) == .success else {
        throw launcherFailure("CordisX operation output did not finish")
    }
    lock.lock(); defer { lock.unlock() }
    if oversized { throw launcherFailure("CordisX operation output was too large") }
    return bytes
}

final class CordisXLauncherDelegate: NSObject, NSApplicationDelegate {
    private let runtimePath: String
    private var launchInFlight = false
    private var lastError: String?

    override init() {
        runtimePath = Bundle.main.object(forInfoDictionaryKey: "CordisXAppRuntime") as? String ?? ""
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !runtimePath.isEmpty else {
            NSLog("CordisX runtime record is missing")
            return
        }
        rebuildMainMenu()
        launchDefault(nil)
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        rebuildMainMenu()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        launchDefault(nil)
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        profileMenu(includeQuit: false)
    }

    @objc private func launchDefault(_ sender: Any?) {
        launch(["launch-default"])
    }

    @objc private func launchProfile(_ sender: NSMenuItem) {
        guard let selection = sender.representedObject as? [String], selection.count == 2 else { return }
        launch(["launch-profile", selection[0], selection[1]])
    }

    @objc private func quitLauncher(_ sender: Any?) {
        // Owned Host supervisors are independent. Quitting this menu app never stops them.
        NSApplication.shared.terminate(nil)
    }

    @objc private func showLastError(_ sender: Any?) {
        guard let lastError else { return }
        presentError(lastError)
    }

    private func launch(_ arguments: [String]) {
        if launchInFlight {
            NSSound.beep()
            return
        }
        launchInFlight = true
        lastError = nil
        rebuildMainMenu()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var failure: String?
            do { _ = try self?.invoke(arguments, timeout: 75) }
            catch {
                failure = error.localizedDescription
                self?.appendLog(error.localizedDescription)
            }
            DispatchQueue.main.async {
                self?.launchInFlight = false
                self?.lastError = failure
                self?.rebuildMainMenu()
                if let failure { self?.presentError(failure) }
            }
        }
    }

    private func profiles() -> (app: String, selected: String, items: [[String: Any]])? {
        guard let response = try? invoke(["menu"], timeout: 5), response["ok"] as? Bool == true,
              let app = response["appId"] as? String, let selected = response["defaultProfile"] as? String,
              let items = response["profiles"] as? [[String: Any]] else { return nil }
        return (app, selected, items)
    }

    private func profileMenu(includeQuit: Bool) -> NSMenu {
        let menu = NSMenu(title: "CordisX")
        let launch = NSMenuItem(title: "启动默认配置", action: #selector(launchDefault(_:)), keyEquivalent: "")
        launch.target = self
        launch.isEnabled = !launchInFlight
        menu.addItem(launch)
        menu.addItem(.separator())
        if let projection = profiles() {
            for profile in projection.items {
                guard let id = profile["id"] as? String, let displayName = profile["displayName"] as? String else {
                    continue
                }
                let title = id == projection.selected ? "✓ " + displayName : displayName
                let item = NSMenuItem(title: title, action: #selector(launchProfile(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = [projection.app, id]
                item.isEnabled = !launchInFlight
                menu.addItem(item)
            }
        } else {
            let unavailable = NSMenuItem(title: "配置暂不可用", action: nil, keyEquivalent: "")
            unavailable.isEnabled = false
            menu.addItem(unavailable)
        }
        if launchInFlight {
            menu.addItem(.separator())
            let status = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")
            status.isEnabled = false
            menu.addItem(status)
        } else if lastError != nil {
            menu.addItem(.separator())
            let error = NSMenuItem(title: "查看启动错误…", action: #selector(showLastError(_:)), keyEquivalent: "")
            error.target = self
            menu.addItem(error)
        }
        if includeQuit {
            menu.addItem(.separator())
            let quit = NSMenuItem(title: "退出 CordisX", action: #selector(quitLauncher(_:)), keyEquivalent: "q")
            quit.target = self
            menu.addItem(quit)
        }
        return menu
    }

    private func presentError(_ message: String) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "CordisX 启动失败"
        alert.informativeText = message
        alert.addButton(withTitle: "知道了")
        alert.runModal()
    }

    private func rebuildMainMenu() {
        let main = NSMenu()
        let root = NSMenuItem()
        root.submenu = profileMenu(includeQuit: true)
        main.addItem(root)
        NSApplication.shared.mainMenu = main
    }

    private func invoke(_ arguments: [String], timeout: Double) throws -> [String: Any] {
        let runtime = try launcherObject(runtimePath)
        guard runtime["schemaVersion"] as? Int == 1,
              let node = runtime["node"] as? String,
              let script = runtime["entryScript"] as? String,
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: script) else {
            throw launcherFailure("CordisX runtime moved; run `cordisx app` again")
        }
        let output = Pipe(), process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script, runtimePath] + arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        process.environment = [
            "HOME": NSHomeDirectory(),
            "PATH": URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": NSTemporaryDirectory(),
        ]
        let data = try launcherOutput(process, output, timeout: timeout)
        guard process.terminationStatus == 0,
              let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              response["ok"] as? Bool == true else {
            let response = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw launcherFailure(response?["error"] as? String ?? "CordisX operation failed")
        }
        if let warning = response["warning"] as? String { appendLog(warning) }
        return response
    }

    private func appendLog(_ line: String) {
        guard !runtimePath.isEmpty else { return }
        let log = URL(fileURLWithPath: runtimePath).deletingLastPathComponent().appendingPathComponent("launcher.log")
        let data = Data((ISO8601DateFormatter().string(from: Date()) + " " + line + "\n").utf8)
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        if let handle = try? FileHandle(forWritingTo: log) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        }
    }
}

let application = NSApplication.shared
let delegate = CordisXLauncherDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
