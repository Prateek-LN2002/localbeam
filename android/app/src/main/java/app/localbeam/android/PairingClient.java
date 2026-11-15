package app.localbeam.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * The network side of pairing with a LocalBeam computer.
 *
 * It uses only standard Java classes (nothing from Android), so the same code that runs in the app is
 * tested on an ordinary Java machine against a real LocalBeam engine.
 */
final class PairingClient {
    private PairingClient() { }

    /** What a successful pairing gives the app. */
    static final class Result {
        final String token;
        final String computer;
        final X509Certificate ca;

        Result(String token, String computer, X509Certificate ca) {
            this.token = token;
            this.computer = computer;
            this.ca = ca;
        }
    }

    /** A refusal with a message that can be shown to the person as it is. */
    static final class PairException extends Exception {
        PairException(String message) { super(message); }
    }

    /**
     * Pairs with the computer.
     *
     * @param expectedFingerprint SHA-256 of the computer's CA certificate, read from the QR code. When it is
     *                            null (address and code typed by hand) the first connection is trusted.
     * @param secret              the one-time secret from the QR code, or null
     * @param code                the typed 6-digit code, used when secret is null
     */
    static Result pair(String host, int port, byte[] expectedFingerprint, String secret, String code,
                       String deviceName) throws PairException, IOException, GeneralSecurityException {
        X509Certificate ca = fetchCa(host, port);
        if (expectedFingerprint != null && !MessageDigest.isEqual(fingerprint(ca), expectedFingerprint)) {
            throw new PairException("This computer does not match the QR code, so pairing was stopped.");
        }
        SSLSocketFactory pinned = factoryFor(ca);

        String body = "{" + (secret != null ? "\"secret\":" + quote(secret) : "\"code\":" + quote(code))
                + ",\"name\":" + quote(deviceName) + "}";
        HttpsURLConnection c = (HttpsURLConnection) new URL("https", host, port, "/pair-app").openConnection();
        c.setSSLSocketFactory(pinned);
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = c.getResponseCode();
        String reply = readAll(status < 400 ? c.getInputStream() : c.getErrorStream());
        if (status != 200) throw new PairException(reply.isEmpty() ? "Pairing failed (" + status + ")." : reply);

        String token = jsonString(reply, "token");
        if (token == null || token.isEmpty()) throw new PairException("The computer sent an answer that could not be read.");
        String computer = jsonString(reply, "computer");
        return new Result(token, computer == null ? "" : computer, ca);
    }

    static byte[] fingerprint(X509Certificate ca) throws GeneralSecurityException {
        return MessageDigest.getInstance("SHA-256").digest(ca.getEncoded());
    }

    /**
     * Downloads the computer's CA certificate. This one request accepts any certificate, because the
     * certificate is public and is checked afterwards against the fingerprint from the QR code.
     */
    static X509Certificate fetchCa(String host, int port) throws IOException, GeneralSecurityException {
        TrustManager[] acceptAll = {new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, acceptAll, new SecureRandom());
        HttpsURLConnection c = (HttpsURLConnection) new URL("https", host, port, "/localbeam-ca.crt").openConnection();
        c.setSSLSocketFactory(ctx.getSocketFactory());
        c.setHostnameVerifier((hostname, session) -> true);
        c.setConnectTimeout(8000);
        c.setReadTimeout(10000);
        if (c.getResponseCode() != 200) throw new IOException("The computer did not send its certificate.");
        try (InputStream in = c.getInputStream()) {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
        }
    }

    /** A connection factory that trusts only certificates issued by the paired computer's CA. */
    static SSLSocketFactory factoryFor(X509Certificate ca) throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        store.setCertificateEntry("localbeam-ca", ca);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(store);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), new SecureRandom());
        return ctx.getSocketFactory();
    }

    static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream src = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = src.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8").trim();
        }
    }

    /** Writes a string as a JSON string literal. */
    static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }

    /** Reads one string value out of a flat JSON object such as {"token":"...","computer":"..."}. */
    static String jsonString(String json, String key) {
        int at = json.indexOf("\"" + key + "\"");
        if (at < 0) return null;
        int colon = json.indexOf(':', at + key.length() + 2);
        if (colon < 0) return null;
        int i = colon + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length() || json.charAt(i) != '"') return null;
        StringBuilder out = new StringBuilder();
        for (i++; i < json.length(); i++) {
            char ch = json.charAt(i);
            if (ch == '"') return out.toString();
            if (ch != '\\') { out.append(ch); continue; }
            if (++i >= json.length()) return null;
            char e = json.charAt(i);
            switch (e) {
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u':
                    if (i + 4 >= json.length()) return null;
                    out.append((char) Integer.parseInt(json.substring(i + 1, i + 5), 16));
                    i += 4;
                    break;
                default: out.append(e); // \" \\ \/
            }
        }
        return null;
    }
}
