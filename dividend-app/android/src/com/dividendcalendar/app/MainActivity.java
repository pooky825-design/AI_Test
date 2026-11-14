package com.dividendcalendar.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 배당 일정 앱 화면. public/ 의 웹 화면을 WebView로 띄우고,
 * WebView에서 하기 어려운 일(CORS 없는 HTTP 요청, 서비스키 저장, 파일 저장)을
 * window.AndroidBridge 로 제공합니다.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "settings";
    private static final String KEY_SERVICE = "seibro_service_key";
    private static final String API_HOST = "apis.data.go.kr";
    private static final int REQ_SAVE = 1;

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private String pendingFileContent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#f4f6fb"));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 앱 화면 밖의 링크는 외부 브라우저로 엽니다.
                if (url.startsWith("file:///android_asset/")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) { }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private void callJs(final String fn, final String a, final String b, final String c) {
        final String js = "window." + fn + " && window." + fn + "(" + JSONObject.quote(a) + ","
                + JSONObject.quote(b) + "," + JSONObject.quote(c) + ")";
        web.post(new Runnable() {
            @Override public void run() { web.evaluateJavascript(js, null); }
        });
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SAVE) return;
        final String content = pendingFileContent;
        pendingFileContent = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || content == null) return;
        try {
            OutputStream out = getContentResolver().openOutputStream(data.getData());
            out.write(new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF}); // 엑셀 한글 깨짐 방지 BOM
            out.write(content.getBytes("UTF-8"));
            out.close();
            Toast.makeText(this, "저장했습니다.", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "저장 실패: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** JS에서 window.AndroidBridge.xxx() 로 호출 */
    private class Bridge {
        @JavascriptInterface
        public String getServiceKey() {
            return prefs().getString(KEY_SERVICE, "");
        }

        @JavascriptInterface
        public void setServiceKey(String key) {
            prefs().edit().putString(KEY_SERVICE, key == null ? "" : key.trim()).apply();
        }

        /** 공공데이터포털 API만 호출할 수 있습니다. 결과는 window.__nativeHttp(id, status, body) */
        @JavascriptInterface
        public void httpGet(final String id, final String url) {
            pool.execute(new Runnable() {
                @Override public void run() {
                    HttpURLConnection conn = null;
                    try {
                        URL u = new URL(url);
                        if (!"https".equals(u.getProtocol()) || !API_HOST.equals(u.getHost())) {
                            throw new Exception("허용되지 않은 주소입니다.");
                        }
                        conn = (HttpURLConnection) u.openConnection();
                        conn.setConnectTimeout(10000);
                        conn.setReadTimeout(15000);
                        conn.setRequestProperty("Accept", "application/json");
                        int status = conn.getResponseCode();
                        String body = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
                        callJs("__nativeHttp", id, String.valueOf(status), body);
                    } catch (Exception e) {
                        callJs("__nativeHttp", id, "0", String.valueOf(e.getMessage()));
                    } finally {
                        if (conn != null) conn.disconnect();
                    }
                }
            });
        }

        /** 저장 위치를 고르는 시스템 화면을 띄워 텍스트 파일(CSV)을 저장합니다. */
        @JavascriptInterface
        public void saveFile(final String name, final String content) {
            web.post(new Runnable() {
                @Override public void run() {
                    pendingFileContent = content;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("text/csv");
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(i, REQ_SAVE);
                    } catch (Exception e) {
                        pendingFileContent = null;
                        Toast.makeText(MainActivity.this, "파일을 저장할 수 없습니다.", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }
    }
}
