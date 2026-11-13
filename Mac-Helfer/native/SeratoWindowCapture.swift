// Development helper: compile with Swift 5 language mode on macOS 13 or later.
// No image files, audio, MIDI, transport controls, or network sockets are used.
import Foundation
import CoreFoundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import Darwin

private let maximumJPEGBytes = 2 * 1024 * 1024
private let maximumHeaderBytes = 4096
private let maximumSafeInteger = 9_007_199_254_740_991

private extension NSLock {
    func protected<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}

private func integer(_ value: Any?, minimum: Int = 0) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, value.rounded() == value,
          value >= Double(minimum), value <= Double(maximumSafeInteger) else { return nil }
    return Int(value)
}

private struct Crop {
    let x: Double, y: Double, width: Double, height: Double
    static func parse(_ value: Any?) -> Crop? {
        guard let values = value as? [String: Any],
              Set(values.keys) == Set(["x", "y", "width", "height"]) else { return nil }
        var numbers = [Double]()
        for name in ["x", "y", "width", "height"] {
            guard let number = values[name] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
            numbers.append(number.doubleValue)
        }
        let crop = Crop(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
        guard crop.x >= 0, crop.y >= 0, crop.width > 0, crop.height > 0,
              crop.x + crop.width <= 1, crop.y + crop.height <= 1 else { return nil }
        return crop
    }
    // CGImage cropping uses image pixel coordinates with the first image row
    // at the top; do not apply CoreImage's bottom-left crop convention here.
    func pixels(width imageWidth: Int, height imageHeight: Int) -> CGRect? {
        let left = max(0, min(imageWidth, Int(floor(x * Double(imageWidth)))))
        let top = max(0, min(imageHeight, Int(floor(y * Double(imageHeight)))))
        let right = max(left, min(imageWidth, Int(ceil((x + width) * Double(imageWidth)))))
        let bottom = max(top, min(imageHeight, Int(ceil((y + height) * Double(imageHeight)))))
        guard right - left >= 16, bottom - top >= 16 else { return nil }
        return CGRect(x: CGFloat(left), y: CGFloat(top), width: CGFloat(right - left), height: CGFloat(bottom - top))
    }
}

/** All stdout records use one bounded SWC1 packet. A blocked reader blocks one
 * writer, while the capture semaphore drops additional samples. */
private final class PacketWriter {
    private let lock = NSLock()
    private var failed = false
    func send(_ header: [String: Any], jpeg: Data = Data()) -> Bool {
        return lock.protected {
            if failed { return false }
            guard jpeg.count <= maximumJPEGBytes,
                  JSONSerialization.isValidJSONObject(header),
                  let json = try? JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]),
                  json.count > 0, json.count <= maximumHeaderBytes else { return false }
            var data = Data("SWC1".utf8)
            var headerLength = UInt32(json.count).bigEndian
            var bodyLength = UInt32(jpeg.count).bigEndian
            withUnsafeBytes(of: &headerLength) { data.append(contentsOf: $0) }
            withUnsafeBytes(of: &bodyLength) { data.append(contentsOf: $0) }
            data.append(json); data.append(jpeg)
            let success = data.withUnsafeBytes { bytes -> Bool in
                guard let base = bytes.baseAddress else { return false }
                var offset = 0
                while offset < bytes.count {
                    let written = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), bytes.count - offset)
                    if written > 0 { offset += written }
                    else if written < 0 && errno == EINTR { continue }
                    else { return false }
                }
                return true
            }
            if !success { failed = true }
            return success
        }
    }
}

@available(macOS 13.0, *)
private final class CaptureController: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: PacketWriter
    private let targetFrameRate: Int
    private let beganAt = ProcessInfo.processInfo.systemUptime
    private let stateLock = NSLock()
    private let sampleQueue = DispatchQueue(label: "SeratoWindowCapture.samples", qos: .userInteractive)
    private let encodeQueue = DispatchQueue(label: "SeratoWindowCapture.encode", qos: .userInitiated)
    private let encodeGate = DispatchSemaphore(value: 1)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var stopping = false
    private var currentStream: SCStream?
    private var currentWindowID: CGWindowID?
    private var currentWindowSize: CGSize?
    private var geometryRevision = 0
    private var cropRevision = 0
    private var crop: Crop?
    private var cropRequestID = 0
    private var sequence = 0
    private var frameSignature: [Int]?
    private var cachedImage: CGImage?
    private var sourcePaused = true
    private var lastSourceAt: Double?
    private var lastAnalysisAt = -Double.infinity
    private var lastFrameCropRevision = -1
    private var lastStatus = ""
    private var captureSamples = 0, busyDrops = 0, cropFrames = 0, previewFrames = 0
    private var rateAt = ProcessInfo.processInfo.systemUptime
    private var rateSamples = 0, rateCrops = 0
    private var captureFps: Double = 0, encodeFps: Double = 0
    private var peakCaptureFps: Double = 0, peakEncodeFps: Double = 0

    init(writer: PacketWriter, frameRate: Int) { self.writer = writer; self.targetFrameRate = frameRate; super.init() }
    var shouldStop: Bool { stateLock.protected { stopping } }
    func requestStop() { stateLock.protected { stopping = true; crop = nil; cropRequestID = 0 } }

    private func status(_ name: String, errorCode: String? = nil, force: Bool = false, requestID: Int? = nil) {
        let packet: [String: Any]? = stateLock.protected {
            let signature = name + ":" + (errorCode ?? "")
            if !force && signature == lastStatus { return nil }
            lastStatus = signature
            var header: [String: Any] = ["type": "status", "status": name,
                "geometryRevision": geometryRevision, "cropRevision": cropRevision,
                "requestId": requestID ?? cropRequestID]
            if let code = errorCode { header["errorCode"] = code }
            return header
        }
        if let packet = packet, !writer.send(packet) { requestStop() }
    }

    private func clearGeometry() {
        stateLock.protected {
            geometryRevision += 1; cropRevision += 1
            crop = nil; cropRequestID = 0; cachedImage = nil; frameSignature = nil
            sourcePaused = true; lastSourceAt = nil
            lastAnalysisAt = -Double.infinity; lastFrameCropRevision = -1
        }
    }

    func command(_ values: [String: Any]) {
        guard let command = values["command"] as? String else {
            status("crop-rejected", errorCode: "CAPTURE_COMMAND_INVALID", force: true); return
        }
        if command == "stop" { requestStop(); return }
        if command == "clearCrop" {
            stateLock.protected { crop = nil; cropRequestID = 0; cropRevision += 1 }
            status("crop-cleared", force: true); return
        }
        guard command == "setCrop", let request = integer(values["requestId"], minimum: 1),
              let geometry = integer(values["geometryRevision"], minimum: 1),
              let rectangle = Crop.parse(values["crop"]) else {
            status("crop-rejected", errorCode: "CAPTURE_CROP_INVALID", force: true); return
        }
        let accepted = stateLock.protected { () -> Bool in
            guard !stopping, !sourcePaused, currentStream != nil, geometry == geometryRevision,
                  let image = cachedImage, rectangle.pixels(width: image.width, height: image.height) != nil else { return false }
            crop = rectangle; cropRequestID = request; cropRevision += 1
            return true
        }
        if accepted {
            status("crop-applied", force: true)
            scheduleCachedImage()
        } else { status("crop-rejected", errorCode: "CAPTURE_CROP_STALE", force: true, requestID: request) }
    }

    private func isSerato(_ application: SCRunningApplication?) -> Bool {
        // The exact running application name is used rather than an unverified
        // bundle identifier or a window title belonging to a browser tab.
        return application?.applicationName.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare("Serato DJ Pro") == .orderedSame
    }

    private func chooseWindow(_ windows: [SCWindow]) -> (window: SCWindow?, ambiguous: Bool) {
        let candidates = windows.filter { window in
            guard isSerato(window.owningApplication), window.windowLayer == 0,
                  window.frame.width.isFinite, window.frame.height.isFinite,
                  window.frame.width >= 480, window.frame.height >= 320 else { return false }
            let title = (window.title ?? "").lowercased()
            return !["preferences", "settings", "setup", "einstellungen"].contains(title)
        }
        let scored = candidates.map { window -> (SCWindow, Double) in
            let title = (window.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let mainTitle = title.caseInsensitiveCompare("Serato DJ Pro") == .orderedSame
            return (window, Double(window.frame.width * window.frame.height) * (mainTitle ? 4 : 1))
        }.sorted { $0.1 > $1.1 }
        guard let first = scored.first else { return (nil, false) }
        if scored.count > 1 && scored[1].1 >= first.1 * 0.85 { return (nil, true) }
        return (first.0, false)
    }

    private func stopStream() async {
        let stream = stateLock.protected { () -> SCStream? in
            let old = currentStream; currentStream = nil; currentWindowID = nil; currentWindowSize = nil
            return old
        }
        if let stream = stream { try? await stream.stopCapture() }
    }

    private func start(_ window: SCWindow) async {
        clearGeometry()
        status("window-found", force: true)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let size = window.frame.size
        var pixelScale: CGFloat = 1
        #if compiler(>=5.9)
        if #available(macOS 14.0, *) {
            let reportedScale = CGFloat(filter.pointPixelScale)
            if reportedScale.isFinite { pixelScale = min(4, max(1, reportedScale)) }
        }
        #endif
        // Keep backing pixels until AFTER cropping. Only the local analysis
        // preview is reduced to 1280px; phone images use the captured pixels.
        let scale = min(pixelScale, 4096 / max(size.width, size.height),
            sqrt(8_000_000 / (size.width * size.height)))
        configuration.width = max(16, Int((size.width * scale).rounded(.down)))
        configuration.height = max(16, Int((size.height * scale).rounded(.down)))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: Int32(targetFrameRate))
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        configuration.colorSpaceName = CGColorSpace.sRGB
        #if compiler(>=5.9)
        if #available(macOS 14.2, *) {
            configuration.preservesAspectRatio = true
            configuration.ignoreShadowsSingleWindow = true
        }
        #endif
        let stream = SCStream(filter: filter,
            configuration: configuration, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            stateLock.protected { currentStream = stream; currentWindowID = window.windowID; currentWindowSize = size }
            try await stream.startCapture()
            if shouldStop { await stopStream(); return }
            status("capture-ready", force: true)
        } catch {
            await stopStream(); clearGeometry()
            status("capture-error", errorCode: "CAPTURE_START_FAILED", force: true)
        }
    }

    func run() async {
        var askedPermission = false
        while !shouldStop {
            if !CGPreflightScreenCaptureAccess() {
                if !askedPermission {
                    askedPermission = true
                    _ = await MainActor.run { CGRequestScreenCaptureAccess() }
                }
                if !CGPreflightScreenCaptureAccess() {
                    if stateLock.protected({ currentStream != nil }) { await stopStream(); clearGeometry() }
                    status("permission-required", errorCode: "CAPTURE_PERMISSION_REQUIRED")
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
            }
            do {
                let available = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                if shouldStop { break }
                let selected = chooseWindow(available.windows)
                guard let window = selected.window else {
                    if stateLock.protected({ currentStream != nil }) { await stopStream(); clearGeometry() }
                    status(selected.ambiguous ? "multiple-windows" : "waiting-for-serato",
                        errorCode: selected.ambiguous ? "CAPTURE_WINDOW_AMBIGUOUS" : nil)
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    continue
                }
                let oldID = stateLock.protected { currentWindowID }
                if oldID != window.windowID {
                    await stopStream()
                    if !shouldStop { await start(window) }
                } else {
                    let resized = stateLock.protected { () -> Bool in
                        let previous = currentWindowSize
                        currentWindowSize = window.frame.size
                        return previous != window.frame.size
                    }
                    if resized {
                        // Reconfigure the capture pixel size as well as crop geometry.
                        await stopStream()
                        if !shouldStop { await start(window) }
                    }
                }
                scheduleCachedImage()
            } catch {
                if !shouldStop { status("capture-error", errorCode: "CAPTURE_WINDOW_LIST_FAILED") }
            }
            try? await Task.sleep(nanoseconds: 450_000_000)
        }
        await stopStream(); clearGeometry(); status("stopped", force: true)
    }

    private func analysisPreview(_ image: CGImage) -> CGImage? {
        let scale = min(1, 1280 / Double(max(image.width, image.height)))
        if scale == 1 { return image }
        let width = max(16, Int((Double(image.width) * scale).rounded()))
        let height = max(16, Int((Double(image.height) * scale).rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        bitmap.interpolationQuality = .high
        bitmap.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        return bitmap.makeImage()
    }

    private func jpeg(_ image: CGImage, analysis: Bool) -> Data? {
        let qualities: [Double] = analysis ? [0.70, 0.50] : [0.94, 0.88, 0.78]
        for quality in qualities {
            let bytes = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(bytes as CFMutableData,
                UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image,
                [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            if CGImageDestinationFinalize(destination), bytes.length <= maximumJPEGBytes { return bytes as Data }
        }
        return nil
    }

    private func emitImage(_ image: CGImage, type: String, geometry: Int, cropVersion: Int,
        request: Int, repeated: Bool, startedAt: Double) {
        let analysis = type == "analysis"
        let outputImage: CGImage? = analysis ? analysisPreview(image) : image
        guard let output = outputImage,
              let bytes = jpeg(output, analysis: analysis) else { status("capture-error", errorCode: "CAPTURE_JPEG_FAILED"); return }
        let header: [String: Any]? = stateLock.protected {
            guard !stopping, !sourcePaused, currentStream != nil, geometryRevision == geometry,
                  type == "analysis" || (crop != nil && cropRevision == cropVersion && cropRequestID == request) else { return nil }
            sequence += 1
            let now = ProcessInfo.processInfo.systemUptime
            if analysis { lastAnalysisAt = now; previewFrames += 1 }
            else { lastFrameCropRevision = cropVersion; cropFrames += 1 }
            var header: [String: Any] = ["type": type, "width": output.width, "height": output.height,
                "sequence": sequence, "geometryRevision": geometry, "cropRevision": cropVersion,
                "requestId": request, "repeated": repeated,
                "sourceAgeMs": max(0, (ProcessInfo.processInfo.systemUptime - (lastSourceAt ?? startedAt)) * 1000),
                "encodeMs": max(0, (ProcessInfo.processInfo.systemUptime - startedAt) * 1000)]
            if analysis {
                header["captureWidth"] = image.width; header["captureHeight"] = image.height
                let elapsed = now - rateAt
                if elapsed >= 1 {
                    captureFps = Double(captureSamples - rateSamples) / elapsed
                    encodeFps = Double(cropFrames - rateCrops) / elapsed
                    peakCaptureFps = max(peakCaptureFps, captureFps); peakEncodeFps = max(peakEncodeFps, encodeFps)
                    rateAt = now; rateSamples = captureSamples; rateCrops = cropFrames
                }
                let metrics: [String: Any] = ["targetFps": targetFrameRate, "captureSamples": captureSamples,
                    "busyDrops": busyDrops, "cropFrames": cropFrames, "previewFrames": previewFrames,
                    "elapsedMs": max(0, (now - beganAt) * 1000), "captureFps": captureFps,
                    "encodeFps": encodeFps, "peakCaptureFps": peakCaptureFps, "peakEncodeFps": peakEncodeFps]
                header["performance"] = metrics
            }
            return header
        }
        if let header = header, !writer.send(header, jpeg: bytes) { requestStop() }
    }

    private func process(_ image: CGImage, geometry: Int, newSourceFrame: Bool) {
        let startedAt = ProcessInfo.processInfo.systemUptime
        if !newSourceFrame && stateLock.protected({ startedAt - (lastSourceAt ?? startedAt) > 0.5 }) { status("source-idle") }
        let settings = stateLock.protected { (crop, cropRevision, cropRequestID,
            startedAt - lastAnalysisAt >= 0.5, lastFrameCropRevision) }
        if let crop = settings.0, newSourceFrame || settings.4 != settings.1,
           let rectangle = crop.pixels(width: image.width, height: image.height),
           let cropped = image.cropping(to: rectangle) {
            emitImage(cropped, type: "frame", geometry: geometry, cropVersion: settings.1,
                request: settings.2, repeated: !newSourceFrame, startedAt: startedAt)
        }
        // Deliver the approved crop before doing the lower-rate preview work.
        if settings.3 {
            emitImage(image, type: "analysis", geometry: geometry, cropVersion: settings.1,
                request: settings.2, repeated: !newSourceFrame, startedAt: startedAt)
        }
    }

    private func scheduleCachedImage() {
        guard encodeGate.wait(timeout: .now()) == .success else { return }
        let snapshot = stateLock.protected { (cachedImage, geometryRevision, stopping || sourcePaused) }
        guard let image = snapshot.0, !snapshot.2 else { encodeGate.signal(); return }
        encodeQueue.async { [self] in
            defer { encodeGate.signal() }
            autoreleasepool { process(image, geometry: snapshot.1, newSourceFrame: false) }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              stateLock.protected({ currentStream === stream && !stopping }) else { return }
        guard let all = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let attachments = all.first, let raw = attachments[.status] as? Int,
              let frameStatus = SCFrameStatus(rawValue: raw) else { return }
        if frameStatus != .complete {
            switch frameStatus {
            case .idle: status(stateLock.protected({ sourcePaused }) ? "source-paused" : "source-idle")
            case .blank, .suspended, .stopped:
                // A paused/minimized/blank source must not reuse a cropped frame
                // as a newly captured live frame. The parent marks its old image.
                stateLock.protected { sourcePaused = true }
                status("source-paused")
            default: break
            }
            return
        }
        guard let buffer = sampleBuffer.imageBuffer else { return }
        stateLock.protected { captureSamples += 1 }
        let sourceAt = ProcessInfo.processInfo.systemUptime
        var signature = [CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer)]
        if let dictionary = attachments[.contentRect] as? [String: Any],
           let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary) {
            let values = [rect.origin.x, rect.origin.y, rect.width, rect.height]
            if values.allSatisfy({ $0.isFinite && abs($0) < 16384 }) {
                signature += values.map { Int(($0 * 100).rounded()) }
            }
        }
        let change = stateLock.protected { () -> (Bool, Bool) in
            let changed = frameSignature != nil && frameSignature != signature
            let resumed = sourcePaused
            frameSignature = signature
            if changed {
                geometryRevision += 1; cropRevision += 1; crop = nil; cropRequestID = 0
                cachedImage = nil; lastAnalysisAt = -Double.infinity; lastFrameCropRevision = -1
            }
            sourcePaused = false
            return (changed, resumed)
        }
        if change.0 { status("geometry-changed", force: true) }
        else { status("capture-ready", force: change.1) }
        guard encodeGate.wait(timeout: .now()) == .success else {
            stateLock.protected { busyDrops += 1 }; return
        }
        let geometry = stateLock.protected { geometryRevision }
        encodeQueue.async { [self] in
            defer { encodeGate.signal() }
            autoreleasepool {
                let input = CIImage(cvPixelBuffer: buffer)
                guard let image = context.createCGImage(input, from: input.extent) else {
                    status("capture-error", errorCode: "CAPTURE_IMAGE_FAILED"); return
                }
                let current = stateLock.protected { () -> Bool in
                    guard !stopping, currentStream === stream, geometryRevision == geometry else { return false }
                    cachedImage = image; lastSourceAt = sourceAt; return true
                }
                if current { process(image, geometry: geometry, newSourceFrame: true) }
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let unexpected = stateLock.protected { () -> Bool in
            guard currentStream === stream && !stopping else { return false }
            currentStream = nil; currentWindowID = nil; currentWindowSize = nil; return true
        }
        if unexpected { clearGeometry(); status("capture-error", errorCode: "CAPTURE_STREAM_STOPPED", force: true) }
    }
}

@main
private struct SeratoWindowCaptureMain {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let writer = PacketWriter()
        let arguments = Array(CommandLine.arguments.dropFirst())
        let frameRate: Int
        if arguments.isEmpty { frameRate = 60 }
        else if arguments.count == 2, arguments[0] == "--fps", let value = Int(arguments[1]), [30, 60].contains(value) { frameRate = value }
        else {
            _ = writer.send(["type": "status", "status": "capture-error", "errorCode": "CAPTURE_ARGUMENT_INVALID",
                "geometryRevision": 0, "cropRevision": 0, "requestId": 0]); return
        }
        guard #available(macOS 13.0, *) else {
            _ = writer.send(["type": "status", "status": "capture-error", "errorCode": "CAPTURE_MACOS_TOO_OLD",
                "geometryRevision": 0, "cropRevision": 0, "requestId": 0]); return
        }
        let controller = CaptureController(writer: writer, frameRate: frameRate)
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        let interrupts = [SIGINT, SIGTERM].map { value -> DispatchSourceSignal in
            let source = DispatchSource.makeSignalSource(signal: value, queue: .global(qos: .userInitiated))
            source.setEventHandler { controller.requestStop() }; source.resume(); return source
        }
        Thread.detachNewThread {
            var pending = Data()
            while !controller.shouldStop {
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty { controller.requestStop(); break }
                pending.append(chunk)
                if pending.count > 8192 { controller.requestStop(); break }
                while let end = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<end]); pending.removeSubrange(...end)
                    guard let command = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                    controller.command(command)
                }
            }
        }
        await controller.run()
        interrupts.forEach { $0.cancel() }
    }
}
