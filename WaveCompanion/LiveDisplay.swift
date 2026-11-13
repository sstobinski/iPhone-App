import Foundation
import SwiftUI
import UIKit
import ImageIO

struct TrackDeck: Decodable { let id: Int; let title: String?; let artist: String? }
struct TrackMotion: Decodable { let state: String; let validForMs: Double }
struct TrackMetadata: Decodable { let status: String; let decks: [TrackDeck]; let motion: TrackMotion? }
struct FrameRegion: Decodable {
    let x: Double; let y: Double; let width: Double; let height: Double
    var valid: Bool {
        [x, y, width, height].allSatisfy { $0.isFinite } && x >= 0 && y >= 0 && width > 0 && height > 0
            && x + width <= 1.000001 && y + height <= 1.000001
    }
    func pixels(width imageWidth: Int, height imageHeight: Int) -> CGRect? {
        guard valid else { return nil }
        let left = max(0, Int(floor(x * Double(imageWidth)))), top = max(0, Int(floor(y * Double(imageHeight))))
        let right = min(imageWidth, Int(ceil((x + width) * Double(imageWidth))))
        let bottom = min(imageHeight, Int(ceil((y + height) * Double(imageHeight))))
        guard right - left >= 2, bottom - top >= 2 else { return nil }
        return CGRect(x: CGFloat(left), y: CGFloat(top), width: CGFloat(right - left), height: CGFloat(bottom - top))
    }
}
struct FramePresentation: Decodable {
    let kind: String; let waveform: FrameRegion; let platters: [FrameRegion]
    var valid: Bool { kind == "platters-and-waveforms" && waveform.valid && platters.count == 2 && platters.allSatisfy { $0.valid } }
}
struct TransferState: Decodable {
    let enabled: Bool; let status: String; let geometryRevision: Int; let cropRevision: Int
    let ageMs: Double?; let unchanged: Bool?; let presentation: FramePresentation?
}
struct SourceStatus: Decodable { let status: String }
struct CapturePerformance: Decodable { let targetFps: Int?; let metricsVersion: Int? }
struct DisplayState: Decodable {
    let mode: String?; let transfer: TransferState; let native: SourceStatus
    let trackInfo: TrackMetadata?; let performance: CapturePerformance?
}


struct FrameIdentity {
    let sequence: Int; let geometry: Int; let crop: Int
    init?(response: HTTPURLResponse) {
        func integer(_ name: String) -> Int? {
            guard let text = response.value(forHTTPHeaderField: name),
                  text.range(of: "^[1-9][0-9]{0,15}$", options: .regularExpression) != nil,
                  let value = Int(text), value <= 9_007_199_254_740_991 else { return nil }
            return value
        }
        guard let sequence = integer("X-Frame-Sequence"), let geometry = integer("X-Frame-Geometry"), let crop = integer("X-Frame-Crop") else { return nil }
        self.sequence = sequence; self.geometry = geometry; self.crop = crop
    }
    func isOwned(by state: DisplayState?, after: Int) -> Bool {
        guard let state = state else { return false }
        return state.transfer.enabled && ["live", "waiting"].contains(state.transfer.status)
            && geometry == state.transfer.geometryRevision && crop == state.transfer.cropRevision && sequence > after
    }
}

private func monotonicNow() -> Double { ProcessInfo.processInfo.systemUptime }
private enum LocalRequestError: Error { case invalid, authentication, status }

enum FrameFetchOutcome { case accepted, unchanged, failed, inactive }
enum FrameFetchPacing {
    static func delay(after outcome: FrameFetchOutcome, elapsed: Double) -> Double {
        switch outcome {
        // Capture and long-polling already pace valid frames. This is only a
        // 120-request/s upper bound for unexpectedly immediate responses.
        case .accepted: return max(0, 1.0 / 120.0 - elapsed)
        case .unchanged: return max(0, 0.05 - elapsed)
        case .failed: return max(0, 0.1 - elapsed)
        case .inactive: return 0.25
        }
    }
}

/// Short-lived play-rate evidence; no audio or waveform reconstruction.
/// Time is counted only with a visible, foreground stream. The first frame
/// after visibility resumes establishes the interval and is not counted twice.
struct MovingPlaybackCounter {
    private(set) var milliseconds: Double = 0
    private(set) var frames = 0
    private var since: Double?
    private var deadline: Double = 0
    mutating func update(at now: Double, visible: Bool, evidenceForMs: Double? = nil) {
        if let start = since { milliseconds += max(0, min(now, deadline) - start) * 1000 }
        if let evidence = evidenceForMs {
            deadline = now + (evidence.isFinite ? min(500, max(0, evidence)) : 0) / 1000
        }
        since = visible && now < deadline ? now : nil
    }
    mutating func recordFrame(at now: Double, visible: Bool) {
        let measured = since != nil && visible && now < deadline
        update(at: now, visible: visible)
        if measured { frames += 1 }
    }
}

/// Every request is built from the validated local origin. Redirects are
/// refused before a bearer credential can follow a different server.
// Session is assigned once during construction. URLSession is thread-safe;
// the redirect callback is stateless. Requests may run concurrently.
private final class MacTransport: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let link: ConnectionLink
    private var session: URLSession!
    init(link: ConnectionLink) {
        self.link = link; super.init()
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 3; config.timeoutIntervalForResource = 5
        config.httpMaximumConnectionsPerHost = 4
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    func request(_ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        guard ["/api/state", "/api/frame", "/api/client-metrics"].contains(path),
              var parts = URLComponents(url: link.url, resolvingAgainstBaseURL: false),
              let fragment = parts.fragment, fragment.hasPrefix("key=") else { throw LocalRequestError.invalid }
        let token = String(fragment.dropFirst(4)); parts.fragment = nil; parts.path = path
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url, link.allowsRequest(to: url) else { throw LocalRequestError.invalid }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body = body { request.httpMethod = "POST"; request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw LocalRequestError.invalid }
        if http.statusCode == 401 || http.statusCode == 403 { throw LocalRequestError.authentication }
        return (data, http)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func close() { session.invalidateAndCancel() }
}

@MainActor
final class NativeFrameRenderer {
    private weak var waveformView: UIImageView?
    private weak var deck1View: UIImageView?
    private weak var deck2View: UIImageView?
    private var images: [UIImage?] = [nil, nil, nil]
    func attach(_ view: UIImageView, part: FramePart) {
        if part != .waveform && waveformView === view { waveformView = nil }
        if part != .deck1 && deck1View === view { deck1View = nil }
        if part != .deck2 && deck2View === view { deck2View = nil }
        switch part { case .waveform: waveformView = view; case .deck1: deck1View = view; case .deck2: deck2View = view }
        if view.image !== images[part.rawValue] { view.image = images[part.rawValue] }
    }
    func show(_ image: CGImage, presentation: FramePresentation?) -> Bool {
        if let presentation = presentation {
            guard presentation.valid else { return false }
            let regions = [presentation.waveform] + presentation.platters
            let parts = regions.compactMap { region -> UIImage? in
                guard let rect = region.pixels(width: image.width, height: image.height), let crop = image.cropping(to: rect) else { return nil }
                return UIImage(cgImage: crop)
            }
            guard parts.count == 3 else { return false }
            images = parts.map { Optional($0) }
        } else { images = [UIImage(cgImage: image), nil, nil] }
        waveformView?.image = images[0]; deck1View?.image = images[1]; deck2View?.image = images[2]
        return true
    }
    func clear() { images = [nil, nil, nil]; waveformView?.image = nil; deck1View?.image = nil; deck2View?.image = nil }
}
enum FramePart: Int { case waveform = 0, deck1 = 1, deck2 = 2 }
@MainActor
final class NativeImageSurface: UIView {
    let imageView = UIImageView()
    override init(frame: CGRect) {
        super.init(frame: frame); backgroundColor = .black; clipsToBounds = true
        imageView.contentMode = .scaleAspectFit; imageView.backgroundColor = .black
        imageView.clipsToBounds = true; addSubview(imageView)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() { super.layoutSubviews(); imageView.frame = bounds }
}
@MainActor
struct NativeFrameView: UIViewRepresentable {
    let renderer: NativeFrameRenderer
    var part: FramePart = .waveform
    func makeUIView(context: Context) -> NativeImageSurface {
        let surface = NativeImageSurface(frame: .zero); renderer.attach(surface.imageView, part: part); return surface
    }
    func updateUIView(_ view: NativeImageSurface, context: Context) { renderer.attach(view.imageView, part: part) }
}

private func decodeJPEG(_ data: Data) async -> CGImage? {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let type = CGImageSourceGetType(source), (type as String) == "public.jpeg",
                      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = props[kCGImagePropertyPixelWidth] as? Int,
                      let height = props[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, width <= 4096, height <= 4096, width * height <= 8_000_000 else {
                    continuation.resume(returning: nil); return
                }
                continuation.resume(returning: CGImageSourceCreateImageAtIndex(source, 0,
                    [kCGImageSourceShouldCacheImmediately: true] as CFDictionary))
            }
        }
    }
}

@MainActor
final class CompanionClient: ObservableObject {
    @Published private(set) var state: DisplayState?
    @Published private(set) var imageVisible = false
    @Published private(set) var message = "Verbindung zum Mac wird hergestellt …"
    @Published private(set) var submittedFps = 0
    let renderer = NativeFrameRenderer()
    private let transport: MacTransport
    private var tasks: [Task<Void, Never>] = []
    private var stopped = false, started = false, foreground = true, expired = false
    private var stateAt: Double = 0, frameAt: Double = 0
    private var sequence = 0, generation = 0
    private let metricID = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16)
    private var frames = 0, skipped = 0, samples = 0, foregroundMs: Double = 0
    private var requestMs: Double = 0, decodeMs: Double = 0, drawMs: Double = 0, visibleAt: Double?
    private var movingPlayback = MovingPlaybackCounter()
    private var rateAt = monotonicNow(), rateFrames = 0
    init(link: ConnectionLink) { transport = MacTransport(link: link) }
    deinit { transport.close() }
    var metadataConnected: Bool { fresh && ["connected", "demo"].contains(state?.trackInfo?.status ?? "") }
    private var fresh: Bool { foreground && !expired && monotonicNow() - stateAt <= 2.5 }
    private var canReceive: Bool {
        guard fresh, let value = state?.transfer else { return false }
        return value.enabled && ["live", "waiting"].contains(value.status) && value.geometryRevision > 0 && value.cropRevision > 0
            && (unchanged || value.ageMs == nil || (value.ageMs ?? .infinity) <= 1800)
    }
    private var unchanged: Bool { state?.native.status == "source-idle" || state?.transfer.unchanged == true }
    func start() {
        guard !started else { return }; started = true
        tasks = [Task { await stateLoop() }, Task { await frameLoop() }, Task { await metricsLoop() }, Task { await healthLoop() }]
    }
    func setForeground(_ value: Bool) {
        movingPlayback.update(at: monotonicNow(), visible: false)
        foreground = value
        if !value { clearFrame(); message = "Anzeige pausiert" }
        else { stateAt = 0; message = "Mac-Verbindung wird aktualisiert …" }
    }
    func stop() {
        stopped = true; tasks.forEach { $0.cancel() }; tasks.removeAll(); clearFrame(); transport.close()
    }
    private func updateVisibleTime(at now: Double = monotonicNow()) {
        if let since = visibleAt { foregroundMs += max(0, now - since) * 1000 }
        visibleAt = foreground && imageVisible ? now : nil
    }
    private func clearFrame() {
        movingPlayback.update(at: monotonicNow(), visible: false)
        updateVisibleTime(); imageVisible = false; visibleAt = nil
        generation += 1; sequence = 0; frameAt = 0; renderer.clear()
    }
    private func stateLoop() async {
        while !Task.isCancelled && !stopped {
            if foreground && !expired {
                do {
                    let requestedAt = monotonicNow()
                    let (data, response) = try await transport.request("/api/state")
                    guard response.statusCode == 200, data.count <= 128 * 1024,
                          response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("application/json") == true else { throw LocalRequestError.status }
                    let next = try JSONDecoder().decode(DisplayState.self, from: data)
                    if state?.transfer.geometryRevision != next.transfer.geometryRevision || state?.transfer.cropRevision != next.transfer.cropRevision
                        || !next.transfer.enabled || !["live", "waiting"].contains(next.transfer.status) { clearFrame() }
                    let receivedAt = monotonicNow()
                    state = next; stateAt = receivedAt
                    let motion = next.trackInfo?.motion
                    let evidence = next.mode != "demo" && next.trackInfo?.status == "connected" && motion?.state == "moving"
                        ? max(0, (motion?.validForMs ?? 0) - (receivedAt - requestedAt) * 1000) : 0
                    movingPlayback.update(at: receivedAt, visible: foreground && imageVisible && canReceive, evidenceForMs: evidence)
                    if !next.transfer.enabled { message = "Warte auf den Wellenformausschnitt vom Mac" }
                    else if next.transfer.status == "stale" { message = "Serato-Aufnahme pausiert" }
                } catch LocalRequestError.authentication {
                    expired = true; clearFrame(); message = "Der Verbindungslink ist abgelaufen. Bitte den neuen Mac-QR-Code scannen."
                } catch { if !fresh { clearFrame(); message = "Mac nicht erreichbar. Helfer und WLAN prüfen und auf dem iPhone den Zugriff auf das lokale Netzwerk erlauben." } }
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }
    private func matches(_ frame: FrameIdentity, _ owner: Int) -> Bool {
        canReceive && owner == generation && frame.isOwned(by: state, after: sequence)
    }
    private func frameLoop() async {
        while !Task.isCancelled && !stopped {
            let began = monotonicNow()
            var outcome = FrameFetchOutcome.inactive
            if canReceive {
                outcome = .failed
                let owner = generation, after = sequence
                do {
                    let (data, response) = try await transport.request("/api/frame", query: [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "wait", value: "1")])
                    if response.statusCode == 200 {
                        outcome = await acceptFrame(data, response, began: began, owner: owner) ? .accepted : .failed
                    } else if response.statusCode == 204 { outcome = .unchanged }
                } catch LocalRequestError.authentication {
                    expired = true; clearFrame(); message = "Bitte den aktuellen Mac-QR-Code scannen."
                } catch { /* State freshness determines whether the last picture remains usable. */ }
            }
            let delay = FrameFetchPacing.delay(after: outcome, elapsed: monotonicNow() - began)
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            else { await Task.yield() }
        }
    }
    private func acceptFrame(_ data: Data, _ response: HTTPURLResponse, began: Double, owner: Int) async -> Bool {
        let requested = monotonicNow()
        guard data.count >= 16, data.count <= 2 * 1024 * 1024,
              response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("image/jpeg") == true,
              let frame = FrameIdentity(response: response), matches(frame, owner),
              let image = await decodeJPEG(data), matches(frame, owner), !Task.isCancelled else { return false }
        let number = frame.sequence
        let decoded = monotonicNow()
        if sequence > 0 && decoded - frameAt < 2 { skipped += max(0, number - sequence - 1) }
        guard renderer.show(image, presentation: state?.transfer.presentation) else { return false }; let drawn = monotonicNow()
        sequence = number; frameAt = drawn; frames += 1; rateFrames += 1
        requestMs += (requested - began) * 1000; decodeMs += (decoded - requested) * 1000; drawMs += (drawn - decoded) * 1000
        if !imageVisible { imageVisible = true; visibleAt = drawn }
        movingPlayback.recordFrame(at: drawn, visible: foreground && imageVisible && canReceive)
        if drawn - rateAt >= 1 { submittedFps = Int((Double(rateFrames) / (drawn - rateAt)).rounded()); rateAt = drawn; rateFrames = 0 }
        return true
    }
    private func healthLoop() async {
        while !Task.isCancelled && !stopped {
            movingPlayback.update(at: monotonicNow(), visible: foreground && imageVisible && canReceive)
            if foreground && !expired {
                if !fresh && state != nil { clearFrame(); message = "Mac-Verbindung unterbrochen. Helfer und WLAN prüfen." }
                else if imageVisible && !unchanged && (monotonicNow() - frameAt > 1.8 || (state?.transfer.ageMs ?? 0) > 1800) {
                    clearFrame(); message = "Warte auf ein aktuelles Serato-Bild …"
                }
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }
    private func metricsLoop() async {
        while !Task.isCancelled && !stopped {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled, !stopped, foreground, fresh else { continue }
            let measuredAt = monotonicNow()
            updateVisibleTime(at: measuredAt); guard foregroundMs >= 1000 else { continue }; samples += 1
            movingPlayback.update(at: measuredAt, visible: foreground && imageVisible && canReceive)
            var values: [String: Any] = ["clientId": String(metricID), "sample": samples, "foregroundMs": foregroundMs,
                "frames": frames, "skipped": skipped, "requestMs": requestMs, "decodeMs": decodeMs, "renderWaitMs": 0, "drawMs": drawMs]
            if state?.performance?.metricsVersion == 2 {
                values["movingMs"] = min(foregroundMs, movingPlayback.milliseconds)
                values["movingFrames"] = movingPlayback.frames
            }
            if let data = try? JSONSerialization.data(withJSONObject: values) { _ = try? await transport.request("/api/client-metrics", body: data) }
        }
    }
}

@MainActor
struct LiveDisplay: View {
    @StateObject private var client: CompanionClient
    @Environment(\.scenePhase) private var phase
    init(link: ConnectionLink) { _client = StateObject(wrappedValue: CompanionClient(link: link)) }
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                if client.state?.mode == "demo" { Text("DEMO · Synthetische Bilder").font(.caption.bold()).frame(maxWidth: .infinity).padding(5).background(.orange.opacity(0.25)) }
                let landscape = geometry.size.width > geometry.size.height
                let platterHeight = min(geometry.size.width / 2 - 16, geometry.size.height * (landscape ? 0.30 : 0.25))
                if client.state?.transfer.presentation?.valid == true {
                    HStack(spacing: 12) {
                        NativeFrameView(renderer: client.renderer, part: .deck1).clipShape(Circle())
                        NativeFrameView(renderer: client.renderer, part: .deck2).clipShape(Circle())
                    }.frame(height: max(50, platterHeight)).padding(.horizontal, 8).padding(.vertical, 4)
                } else if client.imageVisible && client.state?.mode != "demo" {
                    Text("Platten noch nicht erkannt").font(.caption2).foregroundStyle(.secondary).padding(4)
                }
                NativeFrameView(renderer: client.renderer).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay {
                        if !client.imageVisible {
                            VStack(spacing: 14) { Image(systemName: "waveform").font(.largeTitle).foregroundStyle(.cyan)
                                Text(client.message).font(.callout).multilineTextAlignment(.center).foregroundStyle(.secondary) }.padding(30)
                        }
                    }
                HStack(spacing: 0) {
                    deck(1, compact: landscape)
                    Divider().overlay(.gray.opacity(0.4))
                    deck(2, compact: landscape)
                }.fixedSize(horizontal: false, vertical: true).background(Color(red: 0.04, green: 0.07, blue: 0.11))
                if !client.metadataConnected { Text("Warte auf Titel und Interpret …").font(.caption2).foregroundStyle(.orange).padding(4) }
            }.background(.black)
        }
        .onAppear { client.start() }.onDisappear { client.stop() }
        .onChange(of: phase) { _, value in client.setForeground(value == .active) }
        .persistentSystemOverlays(.hidden)
    }
    private func deck(_ id: Int, compact: Bool) -> some View {
        let value = client.metadataConnected ? client.state?.trackInfo?.decks.first(where: { $0.id == id }) : nil
        let rawTitle = String((value?.title ?? "").prefix(160))
        let title = rawTitle.isEmpty ? (client.metadataConnected ? "Kein Track geladen" : "—") : rawTitle
        return VStack(alignment: .leading, spacing: 4) {
            Text("DECK \(id)").font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundStyle(id == 1 ? Color.cyan : Color.pink)
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: compact ? 13 : 15, weight: .semibold)).lineLimit(1)
                    Text(String((value?.artist ?? "").prefix(160))).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(.horizontal, compact ? 13 : 12).padding(.vertical, compact ? 8 : 12)
            .padding(.trailing, id == 2 ? 44 : 0).frame(maxWidth: .infinity, alignment: .leading)
    }
}
