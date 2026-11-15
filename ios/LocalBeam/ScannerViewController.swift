import AVFoundation
import UIKit

/// Full-screen camera view that reports the first QR code it sees.
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var reported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let close = UIButton(type: .system)
        close.setTitle("Cancel", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 18, weight: .semibold)
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false

        let hint = UILabel()
        hint.text = "Point the camera at the QR code on the computer"
        hint.textColor = .white
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.translatesAutoresizingMaskIntoConstraints = false

        startCamera()
        view.addSubview(close)
        view.addSubview(hint)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            hint.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
            hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }

    private func startCamera() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer

        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !reported,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let text = object.stringValue else { return }
        reported = true
        session.stopRunning()
        dismiss(animated: true) { [onCode] in onCode?(text) }
    }

    @objc private func cancel() {
        session.stopRunning()
        dismiss(animated: true)
    }
}
