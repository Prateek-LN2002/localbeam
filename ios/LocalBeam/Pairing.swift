import CryptoKit
import Foundation
import Security

/// What the app remembers about the paired computer.
struct Pairing: Codable {
    var host: String
    var port: Int
    var token: String
    var caDER: Data      // the computer's certificate authority, pinned at pairing
    var computer: String

    var origin: String { "https://\(host):\(port)" }
}

enum PairingStore {
    private static let key = "localbeam.pairing"

    static func load() -> Pairing? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    static func save(_ pairing: Pairing) {
        if let data = try? JSONEncoder().encode(pairing) { UserDefaults.standard.set(data, forKey: key) }
    }

    static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}

enum Trust {
    /// True only when the server's certificate was issued by exactly this CA, is in date, and is for `host`.
    static func isTrusted(_ trust: SecTrust, host: String, caDER: Data) -> Bool {
        guard let ca = SecCertificateCreateWithData(nil, caDER as CFData) else { return false }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        guard SecTrustSetAnchorCertificates(trust, [ca] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else { return false }
        var error: CFError?
        return SecTrustEvaluateWithError(trust, &error)
    }

    /// Answers a TLS challenge. Certificate checks can be slow, so this runs off the main thread.
    static func answer(_ challenge: URLAuthenticationChallenge, caDER: Data?,
                       completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completion(.performDefaultHandling, nil)
            return
        }
        guard let caDER = caDER else {
            completion(.cancelAuthenticationChallenge, nil)
            return
        }
        let host = challenge.protectionSpace.host
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = isTrusted(trust, host: host, caDER: caDER)
            DispatchQueue.main.async {
                if ok { completion(.useCredential, URLCredential(trust: trust)) }
                else { completion(.cancelAuthenticationChallenge, nil) }
            }
        }
    }
}

struct PairError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Fetches the computer's CA certificate. This one request accepts any certificate: the certificate is
/// public, and it is checked afterwards against the fingerprint from the QR code.
private final class AcceptAnyDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

/// A session that only talks to a computer whose certificate comes from the pinned CA.
final class PinnedDelegate: NSObject, URLSessionDelegate {
    let caDER: Data
    init(caDER: Data) { self.caDER = caDER }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        Trust.answer(challenge, caDER: caDER, completion: completionHandler)
    }
}

enum PairingClient {
    private struct Reply: Decodable {
        let token: String
        let computer: String?
    }

    static func derFromPEM(_ data: Data) -> Data? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let body = text
            .components(separatedBy: .newlines)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        return Data(base64Encoded: body)
    }

    /// `expectedFingerprint` comes from the QR code. It is nil when the address and code were typed in,
    /// in which case the first connection is trusted and then remembered.
    static func pair(host: String, port: Int, expectedFingerprint: Data?, secret: String?, code: String?,
                     deviceName: String) async throws -> Pairing {
        let unreachable = PairError(message: "Cannot reach the computer. Check that this device is on the same Wi-Fi, that LocalBeam is open on the computer, and that Local Network access is allowed for LocalBeam in Settings.")

        guard let caURL = URL(string: "https://\(host):\(port)/localbeam-ca.crt"),
              let pairURL = URL(string: "https://\(host):\(port)/pair-app") else {
            throw PairError(message: "That address does not look right.")
        }

        let fetch = URLSession(configuration: .ephemeral, delegate: AcceptAnyDelegate(), delegateQueue: nil)
        defer { fetch.finishTasksAndInvalidate() }
        let pem: Data
        do {
            let (data, response) = try await fetch.data(from: caURL)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw unreachable }
            pem = data
        } catch { throw unreachable }

        guard let der = derFromPEM(pem), SecCertificateCreateWithData(nil, der as CFData) != nil else {
            throw PairError(message: "The computer sent a certificate that could not be read.")
        }
        let fingerprint = Data(SHA256.hash(data: der))
        if let expected = expectedFingerprint, expected != fingerprint {
            throw PairError(message: "This computer does not match the QR code, so pairing was stopped.")
        }

        // A separate session, so this request is checked against the pinned CA from its first byte.
        let pinned = URLSession(configuration: .ephemeral, delegate: PinnedDelegate(caDER: der), delegateQueue: nil)
        defer { pinned.finishTasksAndInvalidate() }
        var request = URLRequest(url: pairURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["name": deviceName]
        if let secret = secret { body["secret"] = secret } else { body["code"] = code ?? "" }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do { (data, response) = try await pinned.data(for: request) } catch {
            throw PairError(message: "Could not make a secure connection to the computer.")
        }
        guard let http = response as? HTTPURLResponse else { throw unreachable }
        guard http.statusCode == 200 else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw PairError(message: text.isEmpty ? "Pairing failed (\(http.statusCode))." : text)
        }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        return Pairing(host: host, port: port, token: reply.token, caDER: der, computer: reply.computer ?? "")
    }
}
