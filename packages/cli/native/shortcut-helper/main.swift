import AppKit
import Foundation

func failure(_ message: String) -> NSError { NSError(domain: "CordisXEntry", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func string(_ value: [String: Any], _ key: String) throws -> String {
    guard let result = value[key] as? String, !result.isEmpty else { throw failure("Missing " + key) }
    return result
}
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
func tool(_ request: [String: Any]) throws -> [String: Any] {
    let op = try string(request, "operation")
    if op == "validate-record" {
        let value = try readObject(try string(request, "path"))
        let runtime = try readObject(try string(value, "runtimePath"))
        return ["nodeExists": FileManager.default.isExecutableFile(atPath: try string(runtime, "node")), "scriptExists": FileManager.default.fileExists(atPath: try string(runtime, "entryScript"))]
    }
    if op == "icon" { return try writeIcon(request) }
    if op == "app-icon" { return try writeLauncherIcon(request) }
    if op == "render-file-icon" {
        let path = try string(request, "path"), output = try string(request, "output")
        let appearance = request["appearance"] as? String ?? "dark"
        guard ["dark", "light", "default"].contains(appearance) else { throw failure("Invalid icon appearance") }
        guard path.hasSuffix(".app"), FileManager.default.fileExists(atPath: path + "/Contents/Info.plist") else {
            throw failure("Invalid entry icon source")
        }
        // Finder custom icons already carry their complete system rendering.
        // Automatic entries keep their primary tile and badges separate so
        // the system inset applies only to the primary tile.
        let resource = appearance == "light" ? "dock-main-light.icns"
            : appearance == "default" ? "dock-main-default.icns" : "dock-main-dark.icns"
        let badgeResource = appearance == "light" ? "dock-badges-light.png"
            : appearance == "default" ? "dock-badges-default.png" : "dock-badges-dark.png"
        let customized = customIcon(path)
        let image = customized
            ? NSWorkspace.shared.icon(forFile: path)
            : NSImage(contentsOfFile: path + "/Contents/Resources/" + resource)
        let badges = NSImage(contentsOfFile: path + "/Contents/Resources/" + badgeResource)
        guard let image,
              (customized || badges != nil),
              let png = try (customized ? rendered(image, size: 512)
                  : renderedDockTile(image, badges: badges!, appPath: path, size: 512))
                .representation(using: .png, properties: [:]) else { throw failure("Cannot render entry icon") }
        try png.write(to: URL(fileURLWithPath: output), options: .atomic)
        return ["written": true]
    }
    if op == "inspect" {
        let path = try string(request, "path"), url = URL(fileURLWithPath: path)
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) ?? [:]
        return ["path": path, "customIcon": customIcon(path), "bookmark": bookmark.base64EncodedString(),
                "entryId": info["CordisXEntryId"] ?? "", "recordPath": info["CordisXEntryRecord"] ?? ""]
    }
    if op == "inspect-app" {
        let path = try string(request, "path"), url = URL(fileURLWithPath: path)
        guard path.hasSuffix(".app"), FileManager.default.fileExists(atPath: path + "/Contents/Info.plist") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) ?? [:]
        return ["bundleIdentifier": info["CFBundleIdentifier"] ?? "", "runtimePath": info["CordisXAppRuntime"] ?? "",
                "helperDigest": info["CordisXAppHelperDigest"] ?? ""]
    }
    if op == "copy-custom-icon" {
        let source = try string(request, "source"), destination = try string(request, "destination")
        guard source.hasSuffix(".app"), destination.hasSuffix(".app"), customIcon(source),
              FileManager.default.fileExists(atPath: destination + "/Contents/Info.plist") else {
            throw failure("Invalid custom icon migration")
        }
        let icon = NSWorkspace.shared.icon(forFile: source)
        guard NSWorkspace.shared.setIcon(icon, forFile: destination, options: []) else {
            throw failure("Cannot preserve Finder custom icon")
        }
        return ["copied": true]
    }
    if op == "resolve" {
        guard let data = Data(base64Encoded: try string(request, "bookmark")) else { throw failure("Invalid bookmark") }
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
        return ["path": url.path, "stale": stale]
    }
    if op == "assemble" {
        let path = try string(request, "path"), url = URL(fileURLWithPath: path)
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(atPath: try string(request, "helper"), toPath: contents.appendingPathComponent("MacOS/CordisXEntry").path)
        try FileManager.default.copyItem(atPath: try string(request, "icon"), toPath: contents.appendingPathComponent("Resources/base.icns").path)
        try FileManager.default.copyItem(atPath: try string(request, "lightIcon"), toPath: contents.appendingPathComponent("Resources/dock-light.icns").path)
        try FileManager.default.copyItem(atPath: try string(request, "defaultIcon"), toPath: contents.appendingPathComponent("Resources/dock-default.icns").path)
        for (key, name) in [
            ("dockMain", "dock-main-dark.icns"), ("dockLightMain", "dock-main-light.icns"),
            ("dockDefaultMain", "dock-main-default.icns"), ("dockBadges", "dock-badges-dark.png"),
            ("dockLightBadges", "dock-badges-light.png"),
            ("dockDefaultBadges", "dock-badges-default.png"),
        ] {
            if let source = request[key] as? String {
                try FileManager.default.copyItem(atPath: source, toPath: contents.appendingPathComponent("Resources/" + name).path)
            }
        }
        let id = try string(request, "entryId")
        let plist: [String: Any] = ["CFBundleExecutable": "CordisXEntry", "CFBundleIdentifier": "org.cordisx.shortcut." + id,
            "CFBundleName": try string(request, "name"), "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
            "CFBundleIconFile": "base.icns", "LSUIElement": true, "CordisXEntryId": id,
            "CordisXEntryRecord": try string(request, "recordPath")]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        return ["assembled": true]
    }
    if op == "assemble-app" {
        let path = try string(request, "path"), url = URL(fileURLWithPath: path)
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(atPath: try string(request, "helper"), toPath: contents.appendingPathComponent("MacOS/CordisXLauncher").path)
        try FileManager.default.copyItem(atPath: try string(request, "icon"), toPath: contents.appendingPathComponent("Resources/CordisX.icns").path)
        let plist: [String: Any] = ["CFBundleExecutable": "CordisXLauncher", "CFBundleIdentifier": "org.cordisx.launcher",
            "CFBundleName": "CordisX", "CFBundleDisplayName": "CordisX", "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0", "CFBundleIconFile": "CordisX.icns",
            "NSHighResolutionCapable": true, "CordisXAppRuntime": try string(request, "runtimePath"),
            "CordisXAppHelperDigest": try string(request, "helperDigest")]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        return ["assembled": true]
    }
    if op == "activate" {
        guard let pid = request["pid"] as? Int32 else { throw failure("Missing Host PID") }
        let check = Process(), pipe = Pipe()
        check.executableURL = URL(fileURLWithPath: "/bin/ps")
        check.arguments = ["-p", String(pid), "-o", "lstart="]
        check.standardOutput = pipe
        try check.run()
        let started = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        check.waitUntilExit()
        guard started == (request["startedAt"] as? String), let app = NSRunningApplication(processIdentifier: pid) else {
            throw failure("Host process identity changed")
        }
        if #available(macOS 14.0, *) {
            let helper = NSRunningApplication.current
            NSApplication.shared.setActivationPolicy(.accessory)
            NSApplication.shared.activate()
            NSApplication.shared.yieldActivation(to: app)
            return ["activated": app.activate(from: helper, options: [.activateAllWindows])]
        }
        return ["activated": app.activate(options: [.activateAllWindows])]
    }
    throw failure("Unknown helper operation")
}

if CommandLine.arguments.dropFirst().first == "--tool" {
    do {
        let bytes = FileHandle.standardInput.readDataToEndOfFile()
        guard bytes.count < 128 * 1024,
              let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw failure("Invalid helper request") }
        try emit(tool(request))
    } catch { try? emit(["error": error.localizedDescription]); exit(1) }
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    DispatchQueue.global().async {
        do {
            _ = try launchEntry()
            DispatchQueue.main.async { app.terminate(nil) }
        } catch {
            let message = error.localizedDescription
            FileHandle.standardError.write(Data((message + "\n").utf8))
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "CordisX 启动入口"
                alert.informativeText = message
                alert.addButton(withTitle: "知道了")
                app.activate(ignoringOtherApps: true)
                alert.runModal()
                app.terminate(nil)
            }
        }
    }
    app.run()
}
