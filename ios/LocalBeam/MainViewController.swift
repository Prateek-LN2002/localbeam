import UIKit
import WebKit

/// LocalBeam for iPhone and iPad.
///
/// Pairing: scan the QR code on the computer (or type its address and code). The QR code carries the
/// fingerprint of the computer's certificate authority. From then on the app only talks to a computer
/// whose certificate was issued by exactly that authority, so no browser warning is involved.
///
/// After pairing, the app shows the computer's own Send / From computer / Progress pages.
final class MainViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private static let blue = UIColor(red: 0.082, green: 0.376, blue: 0.910, alpha: 1)
    private static let page = UIColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1)

    private var pairing: Pairing?
    private var webView: WKWebView!
    private let pairPanel = UIScrollView()
    private let problemPanel = UIView()
    private let problemTitle = UILabel()
    private let problemDetail = UILabel()
    private let statusLabel = UILabel()
    private let addressField = UITextField()
    private let codeField = UITextField()
    private let scanButton = UIButton(type: .system)
    private let pairButton = UIButton(type: .system)
    private var downloadTargets: [ObjectIdentifier: URL] = [:]

    // MARK: - Screen setup

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.page

        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "LocalBeamApp/1.0"
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = Self.page

        buildPairPanel()
        buildProblemPanel()
        for panel in [webView as UIView, pairPanel, problemPanel] {
            panel.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(panel)
            NSLayoutConstraint.activate([
                panel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                panel.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                panel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                panel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
        }

        if let saved = PairingStore.load() { showWeb(saved) } else { showPair(message: nil) }
    }

    private func styled(_ button: UIButton, title: String, primary: Bool) {
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        button.setTitleColor(primary ? .white : Self.blue, for: .normal)
        button.backgroundColor = primary ? Self.blue : .white
        button.layer.cornerRadius = 14
        button.layer.borderWidth = primary ? 0 : 1
        button.layer.borderColor = Self.blue.cgColor
        button.heightAnchor.constraint(equalToConstant: 54).isActive = true
    }

    private func styled(_ field: UITextField, placeholder: String) {
        field.placeholder = placeholder
        field.font = .systemFont(ofSize: 17)
        field.backgroundColor = .white
        field.layer.cornerRadius = 12
        field.layer.borderWidth = 1
        field.layer.borderColor = UIColor(white: 0.89, alpha: 1).cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.heightAnchor.constraint(equalToConstant: 50).isActive = true
    }

    private func text(_ string: String, size: CGFloat, weight: UIFont.Weight, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = string
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.numberOfLines = 0
        label.textAlignment = .center
        return label
    }

    private func buildPairPanel() {
        let muted = UIColor(red: 0.42, green: 0.45, blue: 0.52, alpha: 1)
        let title = text("LocalBeam", size: 30, weight: .bold, color: .black)
        let lead = text("Open LocalBeam on your computer and scan the QR code on its Home screen.",
                        size: 16, weight: .regular, color: muted)
        styled(scanButton, title: "Scan QR code", primary: true)
        scanButton.addTarget(self, action: #selector(scan), for: .touchUpInside)

        let or = text("No camera? Type the address and the 6-digit code shown under the QR code.",
                      size: 14, weight: .regular, color: muted)
        styled(addressField, placeholder: "192.168.1.7:53700")
        addressField.keyboardType = .numbersAndPunctuation
        styled(codeField, placeholder: "6-digit code")
        codeField.keyboardType = .numberPad
        styled(pairButton, title: "Pair", primary: false)
        pairButton.addTarget(self, action: #selector(manualPair), for: .touchUpInside)

        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.font = .systemFont(ofSize: 15)

        let stack = UIStackView(arrangedSubviews: [title, lead, scanButton, or, addressField, codeField, pairButton, statusLabel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(26, after: lead)
        stack.setCustomSpacing(30, after: scanButton)
        stack.translatesAutoresizingMaskIntoConstraints = false
        pairPanel.backgroundColor = Self.page
        pairPanel.keyboardDismissMode = .interactive
        pairPanel.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: pairPanel.contentLayoutGuide.topAnchor, constant: 48),
            stack.bottomAnchor.constraint(equalTo: pairPanel.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: pairPanel.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: pairPanel.frameLayoutGuide.trailingAnchor, constant: -24),
        ])
    }

    private func buildProblemPanel() {
        problemPanel.backgroundColor = Self.page
        problemTitle.font = .systemFont(ofSize: 22, weight: .bold)
        problemTitle.textAlignment = .center
        problemTitle.numberOfLines = 0
        problemDetail.font = .systemFont(ofSize: 16)
        problemDetail.textColor = .darkGray
        problemDetail.textAlignment = .center
        problemDetail.numberOfLines = 0

        let retry = UIButton(type: .system)
        styled(retry, title: "Try again", primary: true)
        retry.addTarget(self, action: #selector(retryLoad), for: .touchUpInside)
        let again = UIButton(type: .system)
        styled(again, title: "Pair with a computer again", primary: false)
        again.addTarget(self, action: #selector(pairAgain), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [problemTitle, problemDetail, retry, again])
        stack.axis = .vertical
        stack.spacing = 14
        stack.setCustomSpacing(28, after: problemDetail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        problemPanel.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: problemPanel.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: problemPanel.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: problemPanel.trailingAnchor, constant: -24),
        ])
    }

    private func show(_ panel: UIView) {
        for candidate in [webView as UIView, pairPanel, problemPanel] { candidate.isHidden = candidate !== panel }
    }

    private func showPair(message: String?) {
        show(pairPanel)
        setBusy(false)
        setStatus(message ?? "", bad: message != nil)
    }

    private func showProblem(title: String, detail: String) {
        problemTitle.text = title
        problemDetail.text = detail
        show(problemPanel)
    }

    private func setStatus(_ string: String, bad: Bool) {
        statusLabel.text = string
        statusLabel.textColor = bad ? UIColor(red: 0.75, green: 0.21, blue: 0.17, alpha: 1) : .darkGray
    }

    private func setBusy(_ busy: Bool) {
        scanButton.isEnabled = !busy
        pairButton.isEnabled = !busy
        scanButton.alpha = busy ? 0.5 : 1
        pairButton.alpha = busy ? 0.5 : 1
    }

    // MARK: - Pairing

    @objc private func scan() {
        let scanner = ScannerViewController()
        scanner.modalPresentationStyle = .fullScreen
        scanner.onCode = { [weak self] text in self?.handleQR(text) }
        present(scanner, animated: true)
    }

    private static func decodeBase64URL(_ string: String) -> Data? {
        var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s)
    }

    private func handleQR(_ text: String) {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https",
              let host = parts.host,
              let secret = parts.queryItems?.first(where: { $0.name == "c" })?.value,
              let fragment = parts.fragment, fragment.hasPrefix("fp="),
              let fingerprint = Self.decodeBase64URL(String(fragment.dropFirst(3))), fingerprint.count == 32 else {
            setStatus("That is not a LocalBeam pairing code. Update LocalBeam on the computer and try again.", bad: true)
            return
        }
        pair(host: host, port: parts.port ?? 53700, fingerprint: fingerprint, secret: secret, code: nil)
    }

    @objc private func manualPair() {
        view.endEditing(true)
        var address = (addressField.text ?? "").trimmingCharacters(in: .whitespaces)
        for prefix in ["https://", "http://"] where address.hasPrefix(prefix) { address.removeFirst(prefix.count) }
        if let slash = address.firstIndex(of: "/") { address = String(address[..<slash]) }
        let code = (codeField.text ?? "").filter { $0.isNumber }
        guard !address.isEmpty else { setStatus("Type the address shown on the computer.", bad: true); return }
        guard code.count == 6 else { setStatus("Type all 6 digits of the code.", bad: true); return }

        var host = address
        var port = 53700
        if let colon = address.lastIndex(of: ":") {
            host = String(address[..<colon])
            guard let p = Int(address[address.index(after: colon)...]) else {
                setStatus("The address should look like 192.168.1.7:53700", bad: true)
                return
            }
            port = p
        }
        // Typed pairing cannot check the computer's identity in advance, so the first connection is trusted
        // and then remembered. Scanning the QR code is the verified way.
        pair(host: host, port: port, fingerprint: nil, secret: nil, code: code)
    }

    private func pair(host: String, port: Int, fingerprint: Data?, secret: String?, code: String?) {
        setBusy(true)
        setStatus("Connecting to the computer…", bad: false)
        let name = UIDevice.current.name
        Task {
            do {
                let result = try await PairingClient.pair(host: host, port: port, expectedFingerprint: fingerprint,
                                                          secret: secret, code: code, deviceName: name)
                await MainActor.run {
                    PairingStore.save(result)
                    self.showWeb(result)
                }
            } catch {
                await MainActor.run {
                    self.setBusy(false)
                    self.setStatus(error.localizedDescription, bad: true)
                }
            }
        }
    }

    private func unpair(message: String?) {
        PairingStore.clear()
        pairing = nil
        webView.loadHTMLString("", baseURL: nil)
        showPair(message: message)
    }

    @objc private func pairAgain() { unpair(message: nil) }

    @objc private func retryLoad() {
        if let pairing = pairing { showWeb(pairing) } else { showPair(message: nil) }
    }

    // MARK: - The paired screens

    private func showWeb(_ pairing: Pairing) {
        self.pairing = pairing
        show(webView)
        let token = pairing.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? pairing.token
        if let url = URL(string: "\(pairing.origin)/app?d=\(token)") { webView.load(URLRequest(url: url)) }
    }

    private func isOurs(_ url: URL) -> Bool {
        guard let pairing = pairing else { return false }
        return url.absoluteString.hasPrefix(pairing.origin + "/") || url.absoluteString == pairing.origin
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        Trust.answer(challenge, caDER: pairing?.caDER, completion: completionHandler)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" { decisionHandler(.allow); return }
        guard isOurs(url) else {
            // Links inside notes open in Safari, not inside LocalBeam.
            decisionHandler(.cancel)
            if url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
            return
        }
        if url.path.isEmpty || url.path == "/" {
            // The computer says this device is no longer paired and sends it to the pairing page.
            decisionHandler(.cancel)
            unpair(message: "This device is no longer paired with that computer. Pair again.")
            return
        }
        let wantsView = (url.query ?? "").contains("view=1")
        if navigationAction.shouldPerformDownload || (url.path == "/d/file" && !wantsView) {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    // "View" opens in a new window on the web; here it opens in place and a swipe goes back.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return } // the load became a download
        if ns.domain == NSURLErrorDomain && (ns.code == NSURLErrorServerCertificateUntrusted || ns.code == NSURLErrorSecureConnectionFailed) {
            showProblem(title: "This is not your paired computer",
                        detail: "The computer at this address could not prove it is the one you paired with. If you reinstalled LocalBeam on the computer, pair again.")
        } else {
            showProblem(title: "Cannot reach the computer",
                        detail: "Check that this device is on the same Wi-Fi as the computer and that LocalBeam is open there.")
        }
    }

    // MARK: - Downloads from the computer

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        Trust.answer(challenge, caDER: pairing?.caDER, completion: completionHandler)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        var target = folder.appendingPathComponent(name)
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        }
        downloadTargets[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // Offer the usual choices: Save to Photos, Save to Files, open in another app.
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file)
        }
        let alert = UIAlertController(title: "Download failed", message: "The file could not be downloaded. Try again.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
