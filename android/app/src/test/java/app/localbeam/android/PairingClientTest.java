package app.localbeam.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.junit.Assume.assumeTrue;

import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Base64;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;

/**
 * Tests the app's pairing and certificate checks against a real LocalBeam engine.
 *
 * Start an engine first and tell the tests where it is:
 *   LB_UI    the computer-side address, for example http://127.0.0.1:53711
 *   LB_HOST  the address phones use, for example 192.168.1.7
 *   LB_PORT  the https port phones use, for example 53701
 *   LB_OTHER_PORT (optional) the https port of a different LocalBeam, used as an impostor
 * Without LB_UI the tests are skipped.
 */
public class PairingClientTest {
    private static final String UI = System.getenv("LB_UI");
    private static final String HOST = System.getenv("LB_HOST");
    private static final String OTHER_PORT = System.getenv("LB_OTHER_PORT");
    private int port;

    @Before
    public void needsEngine() {
        assumeTrue("no LocalBeam engine given (LB_UI not set)", UI != null && HOST != null && System.getenv("LB_PORT") != null);
        port = Integer.parseInt(System.getenv("LB_PORT"));
    }

    private static String local(String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(UI + path).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        assertEquals("computer-side request " + path, 200, c.getResponseCode());
        return PairingClient.readAll(c.getInputStream());
    }

    private static int deviceCount() throws IOException {
        String state = local("/api/state");
        String devices = state.substring(state.indexOf("\"devices\":["), state.indexOf("\"shares\":"));
        return devices.split("\"tokenHash\"|\"connected\"", -1).length - 1;
    }

    /** The pairing link exactly as the QR code holds it. */
    private static URI qrLink() throws IOException {
        return URI.create(PairingClient.jsonString(local("/api/pair-link?ip=" + HOST), "link"));
    }

    private static String secretOf(URI link) {
        for (String part : link.getRawQuery().split("&")) if (part.startsWith("c=")) return part.substring(2);
        throw new AssertionError("QR link has no secret");
    }

    private static byte[] fingerprintOf(URI link) {
        assertTrue("QR link carries a fingerprint", link.getRawFragment() != null && link.getRawFragment().startsWith("fp="));
        return Base64.getUrlDecoder().decode(link.getRawFragment().substring(3));
    }

    private int stateStatus(SSLSocketFactory factory, int httpsPort, String token) throws IOException {
        HttpsURLConnection c = (HttpsURLConnection) new URL("https", HOST, httpsPort, "/d/state").openConnection();
        c.setSSLSocketFactory(factory);
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        if (token != null) c.setRequestProperty("X-Device-Token", token);
        return c.getResponseCode();
    }

    @Test
    public void qrPairingWithTheRightFingerprintWorks() throws Exception {
        URI link = qrLink();
        assertEquals(32, fingerprintOf(link).length);
        PairingClient.Result r = PairingClient.pair(HOST, port, fingerprintOf(link), secretOf(link), null, "JUnit QR phone");
        assertFalse(r.token.isEmpty());
        assertNotNull(r.ca);
        assertEquals("the paired phone is accepted", 200, stateStatus(PairingClient.factoryFor(r.ca), port, r.token));
    }

    @Test
    public void qrPairingWithAWrongFingerprintIsStoppedBeforeAnythingIsSent() throws Exception {
        URI link = qrLink();
        byte[] wrong = fingerprintOf(link);
        wrong[0] ^= 0x01; // one flipped bit: a different computer
        int before = deviceCount();
        try {
            PairingClient.pair(HOST, port, wrong, secretOf(link), null, "JUnit impostor victim");
            fail("pairing must be refused when the computer does not match the QR code");
        } catch (PairingClient.PairException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("does not match the QR code"));
        }
        assertEquals("no device was paired", before, deviceCount());
        // The secret was never sent, so the same QR code still works with the right fingerprint.
        PairingClient.Result r = PairingClient.pair(HOST, port, fingerprintOf(link), secretOf(link), null, "JUnit after refusal");
        assertFalse(r.token.isEmpty());
    }

    @Test
    public void typedCodePairingWorksAndAWrongCodeIsRefused() throws Exception {
        String code = PairingClient.jsonString(local("/api/state"), "code");
        String wrongCode = code.equals("000000") ? "111111" : "000000";
        try {
            PairingClient.pair(HOST, port, null, null, wrongCode, "JUnit typed");
            fail("a wrong code must be refused");
        } catch (PairingClient.PairException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("code is not right"));
        }
        PairingClient.Result r = PairingClient.pair(HOST, port, null, null, code, "JUnit \"typed\" phone");
        assertFalse(r.token.isEmpty());
        assertEquals(200, stateStatus(PairingClient.factoryFor(r.ca), port, r.token));
    }

    @Test
    public void aTokenFromNowhereIsRefused() throws Exception {
        SSLSocketFactory pinned = PairingClient.factoryFor(PairingClient.fetchCa(HOST, port));
        assertEquals(401, stateStatus(pinned, port, "not-a-real-token"));
        assertEquals(401, stateStatus(pinned, port, null));
    }

    @Test
    public void thePinnedConnectionRefusesADifferentComputer() throws Exception {
        assumeTrue("no second LocalBeam given (LB_OTHER_PORT not set)", OTHER_PORT != null);
        int otherPort = Integer.parseInt(OTHER_PORT);
        SSLSocketFactory pinnedToOurs = PairingClient.factoryFor(PairingClient.fetchCa(HOST, port));
        try {
            stateStatus(pinnedToOurs, otherPort, null);
            fail("a computer with a different certificate authority must be refused");
        } catch (SSLException expected) {
            // refused during the TLS handshake, before any request is sent
        }
        // And the other way round: pinned to the other computer, ours is refused.
        SSLSocketFactory pinnedToOther = PairingClient.factoryFor(PairingClient.fetchCa(HOST, otherPort));
        try {
            stateStatus(pinnedToOther, port, null);
            fail("our computer must be refused by a phone paired with a different one");
        } catch (SSLException expected) {
            // refused
        }
    }

    @Test
    public void jsonHelpersRoundTrip() {
        String tricky = "Asha's \"Pixel\" \\ phone\n";
        String json = "{\"token\":\"abc\",\"computer\":" + PairingClient.quote(tricky) + "}";
        assertEquals("abc", PairingClient.jsonString(json, "token"));
        assertEquals(tricky, PairingClient.jsonString(json, "computer"));
        assertEquals("café", PairingClient.jsonString("{\"computer\":\"caf\\u00e9\"}", "computer"));
    }
}
