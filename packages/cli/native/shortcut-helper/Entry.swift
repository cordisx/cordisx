import AppKit
import Foundation

func launchEntry() throws -> [String: Any] {
    guard let record = Bundle.main.object(forInfoDictionaryKey: "CordisXEntryRecord") as? String else {
        throw failure("启动入口记录已丢失，请重新运行创建命令。")
    }
    let value = try readObject(record)
    let runtime = try readObject(try string(value, "runtimePath"))
    let node = try string(runtime, "node"), script = try string(runtime, "entryScript")
    guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: script) else {
        throw failure("CordisX 运行时已移动，请在新的安装上重新运行创建命令。")
    }
    let log = URL(fileURLWithPath: record).deletingPathExtension().appendingPathExtension("log").path
    var logStat = stat()
    if lstat(log, &logStat) == 0 && logStat.st_size > 1_048_576 {
        try? FileManager.default.removeItem(atPath: log + ".previous")
        try FileManager.default.moveItem(atPath: log, toPath: log + ".previous")
    }
    if !FileManager.default.fileExists(atPath: log) {
        FileManager.default.createFile(atPath: log, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    guard chmod(log, 0o600) == 0 else { throw failure("Cannot secure shortcut log") }
    let errorLog = try FileHandle(forWritingTo: URL(fileURLWithPath: log))
    try errorLog.seekToEnd()
    let result = Pipe(), process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [script, record]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = result
    process.standardError = errorLog
    process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    process.environment = ["HOME": NSHomeDirectory(), "PATH": URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": NSTemporaryDirectory()]
    let data = try boundedOutput(process, result)
    try errorLog.close()
    guard process.terminationStatus == 0,
          let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          response["ok"] as? Bool == true else {
        let response = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        throw failure((response?["error"] as? String ?? "未能确认启动完成。请查看入口日志：") + "\n" + log)
    }
    if let warning = responseWarning(data) { throw failure(warning) }
    return response
}

func responseWarning(_ data: Data) -> String? {
    ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["warning"] as? String
}

func readObject(_ path: String) throws -> [String: Any] {
    var attrs = stat()
    guard lstat(path, &attrs) == 0, (attrs.st_mode & S_IFMT) == S_IFREG,
          attrs.st_uid == getuid(), (attrs.st_mode & 0o077) == 0 else {
        throw failure("Unsafe shortcut record permissions")
    }
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] else {
        throw failure("Invalid shortcut record")
    }
    return value
}
