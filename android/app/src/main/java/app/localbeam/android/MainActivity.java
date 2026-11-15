package app.localbeam.android;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;


import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.URLDecoder;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;

/**
 * LocalBeam for Android.
 *
 * Pairing: scan the QR code on the computer (or type its address and code). The QR code carries the
 * fingerprint of the computer's certificate authority. From then on the app only talks to a computer
 * whose certificate was issued by exactly that authority, so no browser warning is involved and nobody
 * else on the Wi-Fi can pose as the computer.
 *
 * After pairing, the app shows the computer's own Send / From computer / Progress pages.
 */
public class MainActivity extends ComponentActivity {
    private static final int DEFAULT_PORT = 53700;
    private static final int BLUE = 0xFF1560E8;
    private static final int TEXT = 0xFF16181D;
    private static final int MUTED = 0xFF6B7385;
    private static final int BAD = 0xFFC0362C;

    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private SharedPreferences prefs;
    private View pairPanel;
    private FrameLayout webPanel;
    private WebView web;
    private TextView banner;
    private TextView status;
    private EditText addressBox;
    private EditText codeBox;
    private Button scanButton;
    private Button pairButton;

    private ValueCallback<Uri[]> fileCallback;
    private X509Certificate caCert;
    private SSLSocketFactory pinnedFactory;
    private String origin; // https://host:port of the paired computer

    private final ActivityResultLauncher<ScanOptions> scanner =
            registerForActivityResult(new ScanContract(), result -> {
                if (result.getContents() != null) handleQr(result.getContents());
            });

    private final ActivityResultLauncher<Intent> filePicker =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (fileCallback == null) return;
                Uri[] picked = null;
                Intent data = result.getData();
                if (result.getResultCode() == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        picked = new Uri[n];
                        for (int i = 0; i < n; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        picked = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(picked);
                fileCallback = null;
            });

    // ---------------------------------------------------------------- screen setup

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("localbeam", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF4F5F7);
        // Keep content clear of the status bar, navigation bar and keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        pairPanel = buildPairPanel();
        webPanel = buildWebPanel();
        root.addView(pairPanel, match());
        root.addView(webPanel, match());
        setContentView(root);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webPanel.getVisibility() == View.VISIBLE && web.canGoBack()) web.goBack();
                else finish();
            }
        });

        if (prefs.contains("token")) showWeb();
        else showPair(null);

        // Test hooks, only in debug builds: stand in for the camera and the keyboard.
        if (BuildConfig.DEBUG && !prefs.contains("token")) {
            String qr = getIntent().getStringExtra("qr");
            String addr = getIntent().getStringExtra("addr");
            String code = getIntent().getStringExtra("code");
            if (qr != null) handleQr(qr);
            else if (addr != null && code != null) {
                addressBox.setText(addr);
                codeBox.setText(code);
                manualPair();
            }
        }
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(14));
        if (stroke != 0) d.setStroke(dp(1), stroke);
        return d;
    }

    private TextView label(String text, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private LinearLayout.LayoutParams row(int topMarginDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(topMarginDp);
        return p;
    }

    private Button bigButton(String text, boolean primary) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(17);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(primary ? Color.WHITE : BLUE);
        b.setBackground(rounded(primary ? BLUE : Color.WHITE, primary ? 0 : BLUE));
        b.setPadding(dp(16), dp(16), dp(16), dp(16));
        b.setStateListAnimator(null);
        return b;
    }

    private EditText field(String hint, int inputType) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(inputType);
        e.setTextSize(17);
        e.setTextColor(TEXT);
        e.setSingleLine(true);
        e.setBackground(rounded(Color.WHITE, 0xFFE4E7EC));
        e.setPadding(dp(14), dp(14), dp(14), dp(14));
        return e;
    }

    private View buildPairPanel() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(24), dp(36), dp(24), dp(24));

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(dp(72), dp(72));
        ip.gravity = Gravity.CENTER_HORIZONTAL;
        col.addView(icon, ip);

        TextView title = label("LocalBeam", 30, TEXT, true);
        title.setGravity(Gravity.CENTER);
        col.addView(title, row(12));

        TextView lead = label("Open LocalBeam on your computer and scan the QR code on its Home screen.", 16, MUTED, false);
        lead.setGravity(Gravity.CENTER);
        col.addView(lead, row(8));

        scanButton = bigButton("Scan QR code", true);
        scanButton.setOnClickListener(v -> {
            ScanOptions o = new ScanOptions();
            o.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
            o.setPrompt("Point the camera at the QR code on the computer");
            o.setBeepEnabled(false);
            o.setOrientationLocked(false);
            scanner.launch(o);
        });
        col.addView(scanButton, row(28));

        TextView or = label("No camera? Type the address and the 6-digit code shown under the QR code.", 14, MUTED, false);
        col.addView(or, row(32));

        addressBox = field("192.168.1.7:53700", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        col.addView(addressBox, row(10));
        codeBox = field("6-digit code", InputType.TYPE_CLASS_NUMBER);
        col.addView(codeBox, row(10));

        pairButton = bigButton("Pair", false);
        pairButton.setOnClickListener(v -> manualPair());
        col.addView(pairButton, row(14));

        status = label("", 15, MUTED, false);
        status.setGravity(Gravity.CENTER);
        col.addView(status, row(18));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(col);
        return scroll;
    }

    private FrameLayout buildWebPanel() {
        FrameLayout panel = new FrameLayout(this);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " LocalBeamApp/" + BuildConfig.VERSION_NAME);
        web.setWebViewClient(new PinnedClient());
        web.setWebChromeClient(new FileChooserClient());
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) ->
                download(url, contentDisposition, mimeType, length));
        panel.addView(web, match());

        banner = label("", 14, Color.WHITE, false);
        banner.setBackgroundColor(0xE6162136);
        banner.setPadding(dp(16), dp(10), dp(16), dp(10));
        banner.setVisibility(View.GONE);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.gravity = Gravity.TOP;
        panel.addView(banner, bp);
        return panel;
    }

    private void showPair(String message) {
        webPanel.setVisibility(View.GONE);
        pairPanel.setVisibility(View.VISIBLE);
        setBusy(false);
        setStatus(message == null ? "" : message, message != null);
    }

    private void setStatus(String text, boolean bad) {
        status.setText(text);
        status.setTextColor(bad ? BAD : MUTED);
    }

    private void setBusy(boolean busy) {
        scanButton.setEnabled(!busy);
        pairButton.setEnabled(!busy);
        scanButton.setAlpha(busy ? 0.5f : 1f);
        pairButton.setAlpha(busy ? 0.5f : 1f);
    }

    private void fail(String message) {
        ui.post(() -> {
            setBusy(false);
            setStatus(message, true);
        });
    }

    // ---------------------------------------------------------------- pairing

    private void handleQr(String text) {
        try {
            Uri u = Uri.parse(text.trim());
            String host = u.getHost();
            int port = u.getPort() > 0 ? u.getPort() : DEFAULT_PORT;
            String secret = u.getQueryParameter("c");
            String fragment = u.getEncodedFragment();
            byte[] fingerprint = null;
            if (fragment != null && fragment.startsWith("fp=")) {
                fingerprint = Base64.decode(fragment.substring(3), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            }
            if (!"https".equals(u.getScheme()) || host == null || secret == null
                    || fingerprint == null || fingerprint.length != 32) {
                setStatus("That is not a LocalBeam pairing code. Update LocalBeam on the computer and try again.", true);
                return;
            }
            pair(host, port, fingerprint, secret, null);
        } catch (RuntimeException e) {
            setStatus("That is not a LocalBeam pairing code.", true);
        }
    }

    private void manualPair() {
        String address = addressBox.getText().toString().trim()
                .replaceFirst("^https?://", "").replaceAll("/.*$", "");
        String code = codeBox.getText().toString().replaceAll("\\D", "");
        if (address.isEmpty()) { setStatus("Type the address shown on the computer.", true); return; }
        if (code.length() != 6) { setStatus("Type all 6 digits of the code.", true); return; }
        String host = address;
        int port = DEFAULT_PORT;
        int colon = address.lastIndexOf(':');
        if (colon > 0) {
            host = address.substring(0, colon);
            try { port = Integer.parseInt(address.substring(colon + 1)); } catch (NumberFormatException e) {
                setStatus("The address should look like 192.168.1.7:53700", true);
                return;
            }
        }
        // Typed pairing cannot check the computer's identity in advance, so the first connection is trusted
        // and then remembered. Scanning the QR code is the verified way.
        pair(host, port, null, null, code);
    }

    private void pair(String host, int port, byte[] expectedFingerprint, String secret, String code) {
        setBusy(true);
        setStatus("Connecting to the computer…", false);
        final String name = deviceName();
        io.execute(() -> {
            try {
                PairingClient.Result result = PairingClient.pair(host, port, expectedFingerprint, secret, code, name);
                prefs.edit()
                        .putString("host", host)
                        .putInt("port", port)
                        .putString("token", result.token)
                        .putString("ca", Base64.encodeToString(result.ca.getEncoded(), Base64.NO_WRAP))
                        .putString("computer", result.computer)
                        .apply();
                ui.post(this::showWeb);
            } catch (PairingClient.PairException e) {
                fail(e.getMessage());
            } catch (SSLException e) {
                fail("Could not make a secure connection to the computer.");
            } catch (IOException e) {
                fail("Cannot reach the computer. Check that the phone is on the same Wi-Fi and LocalBeam is open.");
            } catch (Exception e) {
                fail("Pairing failed. " + e.getMessage());
            }
        });
    }

    private String deviceName() {
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        if (model.isEmpty()) return "Android phone";
        if (maker.isEmpty() || model.toLowerCase().startsWith(maker.toLowerCase())) return model;
        return Character.toUpperCase(maker.charAt(0)) + maker.substring(1) + " " + model;
    }

    private void unpair(String message) {
        prefs.edit().clear().apply();
        web.loadUrl("about:blank");
        web.clearHistory();
        showPair(message);
    }

    // ---------------------------------------------------------------- the paired screens

    private void showWeb() {
        try {
            byte[] der = Base64.decode(prefs.getString("ca", ""), Base64.NO_WRAP);
            caCert = (X509Certificate) CertificateFactory.getInstance("X.509")
                    .generateCertificate(new ByteArrayInputStream(der));
            pinnedFactory = PairingClient.factoryFor(caCert);
        } catch (Exception e) {
            unpair("The saved pairing could not be read. Pair again.");
            return;
        }
        origin = "https://" + prefs.getString("host", "") + ":" + prefs.getInt("port", DEFAULT_PORT);
        pairPanel.setVisibility(View.GONE);
        webPanel.setVisibility(View.VISIBLE);
        web.loadUrl(origin + "/app?d=" + Uri.encode(prefs.getString("token", "")));
    }

    private void showProblem(String title, String detail) {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='font-family:sans-serif;background:#F4F5F7;color:#16181D;padding:40px 24px;text-align:center'>"
                + "<h2>" + title + "</h2><p style='color:#6B7385'>" + detail + "</p>"
                + "<p><a href='localbeam://retry' style='display:block;background:#1560E8;color:#fff;padding:15px;"
                + "border-radius:12px;text-decoration:none;font-weight:bold;margin-top:28px'>Try again</a></p>"
                + "<p><a href='localbeam://unpair' style='display:block;color:#1560E8;padding:12px'>Pair with a computer again</a></p>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private class PinnedClient extends WebViewClient {
        /**
         * The computer's certificate is not from a public authority, so the system flags it. We accept it
         * only when it was issued by the CA saved at pairing, is within its dates, and is for this address.
         */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            try {
                boolean ours = error.getUrl() != null && error.getUrl().startsWith(origin + "/");
                boolean onlyUntrusted = !error.hasError(SslError.SSL_IDMISMATCH) && !error.hasError(SslError.SSL_EXPIRED)
                        && !error.hasError(SslError.SSL_NOTYETVALID) && !error.hasError(SslError.SSL_DATE_INVALID)
                        && !error.hasError(SslError.SSL_INVALID);
                Bundle saved = SslCertificate.saveState(error.getCertificate());
                byte[] der = saved == null ? null : saved.getByteArray("x509-certificate");
                if (ours && onlyUntrusted && der != null && caCert != null) {
                    X509Certificate leaf = (X509Certificate) CertificateFactory.getInstance("X.509")
                            .generateCertificate(new ByteArrayInputStream(der));
                    leaf.checkValidity();
                    leaf.verify(caCert.getPublicKey()); // throws unless our CA signed it
                    handler.proceed();
                    return;
                }
            } catch (Exception e) {
                // fall through to refusing the connection
            }
            handler.cancel();
            showProblem("This is not your paired computer",
                    "The computer at this address could not prove it is the one you paired with. "
                            + "If you reinstalled LocalBeam on the computer, pair again.");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String url = u.toString();
            if ("localbeam".equals(u.getScheme())) {
                if ("unpair".equals(u.getHost())) unpair(null);
                else showWeb();
                return true;
            }
            if (url.startsWith(origin + "/")) {
                // The computer says this phone is no longer paired and sends it to the pairing page.
                String path = u.getPath();
                if (path == null || path.equals("/")) {
                    unpair("This phone is no longer paired with that computer. Pair again.");
                    return true;
                }
                return false;
            }
            // Links inside notes open in the phone's browser, not inside LocalBeam.
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no browser */ }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && request.getUrl().toString().startsWith(origin + "/")) {
                showProblem("Cannot reach the computer",
                        "Check that the phone is on the same Wi-Fi as the computer and that LocalBeam is open there.");
            }
        }
    }

    private class FileChooserClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                filePicker.launch(Intent.createChooser(pick, "Choose files to send"));
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    // ---------------------------------------------------------------- downloads from the computer

    private void setBanner(String text) {
        ui.post(() -> {
            banner.setText(text == null ? "" : text);
            banner.setVisibility(text == null ? View.GONE : View.VISIBLE);
        });
    }

    private static String fileNameFrom(String contentDisposition, String url, String mimeType) {
        if (contentDisposition != null) {
            Matcher star = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
            if (star.find()) {
                try { return URLDecoder.decode(star.group(1), "UTF-8"); } catch (Exception e) { /* use the next form */ }
            }
            Matcher plain = Pattern.compile("filename=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
            if (plain.find()) return plain.group(1);
        }
        return URLUtil.guessFileName(url, contentDisposition, mimeType);
    }

    private void download(String url, String contentDisposition, String mimeType, long length) {
        if (!url.startsWith(origin + "/") || pinnedFactory == null) return;
        io.execute(() -> {
            Uri item = null;
            ContentResolver resolver = getContentResolver();
            String name = fileNameFrom(contentDisposition, url, mimeType);
            try {
                HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
                c.setSSLSocketFactory(pinnedFactory);
                c.setConnectTimeout(8000);
                c.setReadTimeout(30000);
                if (c.getResponseCode() != 200) throw new IOException("status " + c.getResponseCode());
                long total = c.getContentLengthLong();

                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                if (mimeType != null && !mimeType.isEmpty()) values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LocalBeam");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (item == null) throw new IOException("no place to save");

                try (InputStream in = c.getInputStream(); OutputStream out = resolver.openOutputStream(item)) {
                    if (out == null) throw new IOException("cannot write");
                    byte[] buf = new byte[256 * 1024];
                    long done = 0;
                    long shownAt = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - shownAt > 400) {
                            shownAt = now;
                            setBanner("Downloading " + name + (total > 0 ? "  " + (done * 100 / total) + "%" : ""));
                        }
                    }
                    if (total > 0 && done != total) throw new IOException("incomplete");
                }
                ContentValues finished = new ContentValues();
                finished.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(item, finished, null, null);
                setBanner(null);
                ui.post(() -> Toast.makeText(this, "Saved " + name + " to Downloads/LocalBeam", Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                if (item != null) resolver.delete(item, null, null);
                setBanner(null);
                ui.post(() -> Toast.makeText(this, "Could not download " + name + ". Try again.", Toast.LENGTH_LONG).show());
            }
        });
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        super.onDestroy();
    }
}
