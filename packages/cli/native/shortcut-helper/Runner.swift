import Foundation

func boundedOutput(_ process: Process, _ pipe: Pipe) throws -> Data {
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
    guard terminated.wait(timeout: .now() + 75) == .success else {
        // This is only the short-lived CLI, never its detached supervisor/process group.
        if process.isRunning { process.terminate() }
        throw failure("尚未确认启动完成。后台实例可能仍在启动，请稍后重试。")
    }
    guard readDone.wait(timeout: .now() + 2) == .success else { throw failure("启动结果读取未完成。") }
    lock.lock(); defer { lock.unlock() }
    if oversized { throw failure("启动结果超过允许大小。") }
    return bytes
}
