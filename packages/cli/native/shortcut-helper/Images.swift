import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

func rendered(_ image: NSImage, size: Int) throws -> NSBitmapImageRep {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw failure("Cannot render icon") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    return bitmap
}

// Electron's dock.setIcon draws the supplied PNG verbatim, while Finder and
// LaunchServices apply the current macOS app-icon silhouette and inset to the
// same .icns resource. Derive that geometry from the real generated .app and
// map the requested appearance variant into it.
func renderedDockTile(_ image: NSImage, badges: NSImage, appPath: String, size: Int) throws -> NSBitmapImageRep {
    let system = try rendered(NSWorkspace.shared.icon(forFile: appPath), size: size)
    var minX = size, minY = size, maxX = -1, maxY = -1
    for y in 0..<size {
        // Ignore the translucent drop shadow when measuring the system tile.
        for x in 0..<size where (system.colorAt(x: x, y: y)?.alphaComponent ?? 0) >= 0.5 {
            minX = min(minX, x); minY = min(minY, y)
            maxX = max(maxX, x); maxY = max(maxY, y)
        }
    }
    guard maxX >= minX, maxY >= minY else { throw failure("Cannot derive system icon geometry") }
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw failure("Cannot render Dock icon") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let bounds = NSRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    image.draw(in: bounds, from: .zero, operation: .copy, fraction: 1)
    // Keep LaunchServices' exact alpha silhouette, including the system inset
    // and edge treatment, without inheriting the dark variant's pixels.
    guard let systemImage = system.cgImage,
          let context = NSGraphicsContext.current?.cgContext else { throw failure("Cannot apply system icon geometry") }
    context.setBlendMode(.destinationIn)
    context.draw(systemImage, in: CGRect(x: 0, y: 0, width: size, height: size))
    // Notification-style badges live outside the system inset. Draw them at
    // their intended Dock scale after masking the primary app tile.
    context.setBlendMode(.normal)
    badges.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
        from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap
}

func writeIcns(_ image: NSImage, output: String) throws {
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL,
        UTType.icns.identifier as CFString, 7, nil) else { throw failure("Cannot create icns") }
    for size in [16, 32, 64, 128, 256, 512, 1024] {
        guard let cg = try rendered(image, size: size).cgImage else { throw failure("Cannot encode icon") }
        CGImageDestinationAddImage(destination, cg, nil)
    }
    guard CGImageDestinationFinalize(destination) else { throw failure("Cannot finalize icns") }
}

func hostIcon(_ executable: String, appearance: String = "dark") -> NSImage {
    var url = URL(fileURLWithPath: executable)
    while url.path != "/" && url.pathExtension != "app" { url.deleteLastPathComponent() }
    if url.pathExtension == "app", let bundle = Bundle(url: url) {
        // Codex's CFBundleIconFile still names the legacy OpenAI knot. The
        // current Host chooses its blue Codex Dock artwork at runtime. Use
        // the same installed, read-only asset for shortcut artwork.
        if bundle.bundleIdentifier == "com.openai.codex" && appearance != "default" {
            let preferred = appearance == "light" ? "icon-codex-light.png" : "icon-codex-dark-color.png"
            for name in [preferred, "app.icns"] {
                if let icon = NSImage(contentsOf: url.appendingPathComponent("Contents/Resources/" + name)) {
                    return icon
                }
            }
        }
        if let name = bundle.object(forInfoDictionaryKey: "CFBundleIconFile") as? String {
            let file = name.hasSuffix(".icns") ? name : name + ".icns"
            if let icon = NSImage(contentsOf: url.appendingPathComponent("Contents/Resources/" + file)) { return icon }
        }
    }
    return NSWorkspace.shared.icon(forFile: url.pathExtension == "app" ? url.path : executable)
}

func writeIcon(_ request: [String: Any]) throws -> [String: Any] {
    let executable = try string(request, "executable"), output = try string(request, "output")
    let appearance = request["appearance"] as? String ?? "dark"
    guard ["dark", "light", "default"].contains(appearance) else { throw failure("Invalid icon appearance") }
    let light = appearance == "light"
    let brandPath = try string(request, light ? "brandLight" : "brandDark")
    guard let brand = NSImage(contentsOfFile: brandPath) else { throw failure("CordisX brand mark unavailable") }
    let host = hostIcon(executable, appearance: light ? "light" : "dark")
    let main = NSImage(size: NSSize(width: 512, height: 512))
    main.lockFocus()
    // The OS masks the opaque app icon. Transparent rounded corners would be
    // framed by Finder with a pale backing plate that the running icon lacks.
    (light ? NSColor(calibratedWhite: 0.96, alpha: 1) : NSColor.black).setFill()
    NSRect(x: 0, y: 0, width: 512, height: 512).fill()
    // Keep the brand mark centered on the full icon canvas. Its own SVG
    // margins leave the upper-right corner free for the system badge.
    brand.draw(in: NSRect(x: 31, y: 31, width: 450, height: 450))
    main.unlockFocus()
    let badges = NSImage(size: NSSize(width: 512, height: 512))
    badges.lockFocus()
    func circle(_ source: NSImage, at x: CGFloat, hostArtwork: Bool = false) {
        // At the native Dock size the outer 200-point circle matches the
        // system's notification bubble. Keep its rim within the 512 canvas.
        let badge = NSRect(x: x, y: 7, width: 192, height: 192)
        NSGraphicsContext.saveGraphicsState()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: badge.insetBy(dx: -4, dy: -4)).fill()
        NSBezierPath(ovalIn: badge).addClip()
        // The Host asset includes transparent rounded-square corners. Zoom it
        // inside the circular crop so they cannot reveal a thick white plate.
        if hostArtwork {
            (light ? NSColor.white : NSColor(calibratedWhite: 0.10, alpha: 1)).setFill()
            NSBezierPath(ovalIn: badge).fill()
        }
        source.draw(in: hostArtwork ? badge.insetBy(dx: -31, dy: -31) : badge)
        NSGraphicsContext.restoreGraphicsState()
    }
    circle(host, at: 4, hostArtwork: true)
    if let inline = request["avatar"] as? String, inline.count <= 65536,
       let comma = inline.firstIndex(of: ","), let bytes = Data(base64Encoded: String(inline[inline.index(after: comma)...])),
       let avatar = NSImage(data: bytes) {
        circle(avatar, at: 316)
    }
    badges.unlockFocus()
    let image = NSImage(size: NSSize(width: 512, height: 512))
    image.lockFocus()
    main.draw(in: NSRect(x: 0, y: 0, width: 512, height: 512))
    badges.draw(in: NSRect(x: 0, y: 0, width: 512, height: 512))
    image.unlockFocus()
    try writeIcns(image, output: output)
    if let runtimeMain = request["runtimeMain"] as? String { try writeIcns(main, output: runtimeMain) }
    if let runtimeBadges = request["runtimeBadges"] as? String {
        guard let png = try rendered(badges, size: 512).representation(using: .png, properties: [:]) else {
            throw failure("Cannot encode Dock badges")
        }
        try png.write(to: URL(fileURLWithPath: runtimeBadges), options: .atomic)
    }
    if let preview = request["preview"] as? String {
        try rendered(image, size: 256).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: preview))
    }
    return ["written": true]
}

func writeLauncherIcon(_ request: [String: Any]) throws -> [String: Any] {
    let output = try string(request, "output")
    guard let brand = NSImage(contentsOfFile: try string(request, "brand")) else {
        throw failure("CordisX brand mark unavailable")
    }
    let image = NSImage(size: NSSize(width: 512, height: 512))
    image.lockFocus()
    NSColor.black.setFill()
    NSRect(x: 0, y: 0, width: 512, height: 512).fill()
    brand.draw(in: NSRect(x: 31, y: 31, width: 450, height: 450))
    image.unlockFocus()
    try writeIcns(image, output: output)
    return ["written": true]
}

func customIcon(_ path: String) -> Bool {
    var bytes = [UInt8](repeating: 0, count: 32)
    let count = path.withCString { p in "com.apple.FinderInfo".withCString { name in
        getxattr(p, name, &bytes, bytes.count, 0, 0)
    }}
    // kHasCustomIcon is bit 10 of the big-endian Finder flags word.
    return (count >= 10 && (UInt16(bytes[8]) << 8 | UInt16(bytes[9])) & 0x0400 != 0)

}
