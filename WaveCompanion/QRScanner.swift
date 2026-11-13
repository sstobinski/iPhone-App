import SwiftUI
import UIKit
import AVFoundation

final class CameraPreview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let connection = previewLayer.connection, connection.isVideoOrientationSupported else { return }
        switch window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: connection.videoOrientation = .landscapeLeft
        case .landscapeRight: connection.videoOrientation = .landscapeRight
        case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
        default: connection.videoOrientation = .portrait
        }
    }
}

struct QRScanner: UIViewRepresentable {
    let found: (String) -> Void
    let failure: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(found: found, failure: failure) }
    func makeUIView(context: Context) -> CameraPreview {
        let view = CameraPreview(); view.previewLayer.session = context.coordinator.session
        view.previewLayer.videoGravity = .resizeAspectFill; context.coordinator.preview = view; context.coordinator.begin(); return view
    }
    func updateUIView(_ view: CameraPreview, context: Context) { }
    static func dismantleUIView(_ view: CameraPreview, coordinator: Coordinator) { coordinator.stop() }
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession()
        weak var preview: CameraPreview?
        private let queue = DispatchQueue(label: "WaveCompanion.QRCamera")
        private var cancelled = false
        private var finished = false
        private let found: (String) -> Void
        private let failure: (String) -> Void
        init(found: @escaping (String) -> Void, failure: @escaping (String) -> Void) { self.found = found; self.failure = failure }
        func begin() {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: configure()
            case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { self.configure() } else { DispatchQueue.main.async { if !self.finished { self.failure("Kamerazugriff fehlt. Alternativ den Mac-Verbindungslink einfügen.") } } }
            }
            default: failure("Kamerazugriff fehlt. Alternativ den Mac-Verbindungslink einfügen.")
            }
        }
        private func configure() {
            queue.async {
                guard !self.cancelled else { return }
                do {
                    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { throw CameraError.unavailable }
                    let input = try AVCaptureDeviceInput(device: camera), output = AVCaptureMetadataOutput()
                    self.session.beginConfiguration()
                    guard self.session.canAddInput(input) else {
                        self.session.commitConfiguration(); throw CameraError.unavailable
                    }
                    self.session.addInput(input)
                    guard self.session.canAddOutput(output) else {
                        self.session.commitConfiguration(); throw CameraError.unavailable
                    }
                    self.session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
                    self.session.commitConfiguration(); self.session.startRunning()
                    DispatchQueue.main.async { self.preview?.setNeedsLayout() }
                } catch { DispatchQueue.main.async { if !self.finished { self.failure("Die Kamera ist nicht verfügbar. Alternativ den Mac-Verbindungslink einfügen.") } } }
            }
        }
        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !finished, let value = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
            finished = true; stop(); found(value)
        }
        func stop() { finished = true; queue.async { self.cancelled = true; if self.session.isRunning { self.session.stopRunning() } } }
        private enum CameraError: Error { case unavailable }
    }
}
