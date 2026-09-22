import AppKit
import Darwin
import Foundation

// Keep the managed Host's Dock tile while it runs without adding a new
// "recent application" tile after every normal quit. `open(1)` has no switch
// for NSWorkspace.OpenConfiguration.addsToRecentItems.
guard CommandLine.arguments.count >= 2 else {
    fputs("CordisX Host app path is missing\n", stderr)
    exit(2)
}

let appURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let configuration = NSWorkspace.OpenConfiguration()
configuration.createsNewApplicationInstance = true
configuration.activates = false
configuration.hides = true
configuration.addsToRecentItems = false
configuration.arguments = Array(CommandLine.arguments.dropFirst(2))
configuration.environment = ProcessInfo.processInfo.environment

var launched: NSRunningApplication?
var launchError: Error?
var completed = false
NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
    launched = app
    launchError = error
    completed = true
}

let launchDeadline = Date().addingTimeInterval(8)
while !completed && Date() < launchDeadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
}
guard completed, let host = launched else {
    fputs("CordisX Host launch failed: \(launchError?.localizedDescription ?? "timed out")\n", stderr)
    exit(1)
}
if let launchError {
    host.terminate()
    fputs("CordisX Host launch failed: \(launchError.localizedDescription)\n", stderr)
    exit(1)
}

// This helper is the equivalent of `open -W`: the Node supervisor still owns
// the exact Host PID through its separate inspector and process-tree checks.
// NSRunningApplication remains bound to that launch even if the PID is reused.
while !host.isTerminated {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
