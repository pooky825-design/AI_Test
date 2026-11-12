package com.stockmanager.prototype;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.accounts.AccountManagerCallback;
import android.accounts.AccountManagerFuture;
import android.accounts.OperationCanceledException;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 주식 관리시스템 프로토타입 (안드로이드)
 * 화면과 업무 로직(PC 버전 server/ 코드를 번들한 mobile-bundle.js)은 WebView 안에서 실행하고,
 * 이 클래스는 WebView가 직접 할 수 없는 일만 브리지(window.AndroidBridge)로 제공한다.
 *  - 외부 시세 출처 호출 (CORS 제약 없이)
 *  - SQLite DB 파일 저장/불러오기 (앱 내부 저장소)
 *  - 엑셀 파일을 기기의 다운로드 폴더에 저장
 */
public class MainActivity extends Activity {

    // 호출을 허용하는 외부 출처 (그 밖의 주소는 차단)
    private static final Set<String> ALLOWED_HOSTS = new HashSet<String>(Arrays.asList(
            "query1.finance.yahoo.com", "query2.finance.yahoo.com", "fchart.stock.naver.com", "www.funetf.co.kr",
            "www.soletf.com", "investments.miraeasset.com",
            "ac.stock.naver.com", // 종목명 검색 (v0.21.1)
            "m.stock.naver.com", // 투자지표·분기 실적 (v0.26.6)
            "oauth2.googleapis.com", "www.googleapis.com", // 구글 드라이브 직접 연결 (v0.27.0)
            "news.google.com")); // 홈 화면 키워드: 언어별 뉴스 (v0.30.1)

    private WebView webView;

    // 클라우드 서버 모드 (v0.25): 서버 주소를 정하면 휴대폰 안의 서버 대신 그 서버 화면을 연다
    private static final String LOCAL_URL = "file:///android_asset/www/index.html";
    private static final String PREFS = "kstock";
    private static final String KEY_SERVER = "serverUrl";
    private volatile String serverUrl = "";   // "" 이면 이 휴대폰 모드
    private volatile boolean pageIsLocal = true; // 지금 화면이 앱 안의 화면(file://)인지. 서버 화면에는 휴대폰 DB·외부 호출을 열지 않는다

    private String loadServerUrl() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, "");
    }

    /** https 주소만 허용하고 "https://호스트[:포트]/" 형태로 정리한다. 올바르지 않으면 null */
    private static String normalizeServer(String raw) {
        try {
            String t = raw == null ? "" : raw.trim();
            if (t.isEmpty()) return "";
            if (!t.contains("://")) t = "https://" + t;
            URL u = new URL(t);
            if (!"https".equals(u.getProtocol()) || u.getHost() == null || u.getHost().isEmpty()) return null;
            return "https://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "") + "/";
        } catch (Exception e) {
            return null;
        }
    }

    private boolean isServerUrl(String url) {
        return !serverUrl.isEmpty() && url != null && url.startsWith(serverUrl);
    }

    private void openStart() {
        serverUrl = loadServerUrl();
        webView.loadUrl(serverUrl.isEmpty() ? LOCAL_URL : serverUrl);
    }

    /** 서버에 연결하지 못하면 휴대폰 안의 화면으로 돌아와 안내한다(서버 주소는 그대로 둠) */
    private void showCloudError() {
        main.post(new Runnable() {
            @Override public void run() {
                webView.loadUrl(LOCAL_URL + "#/login?cloudError=1");
            }
        });
    }

    // 백업·복원 (v0.15): 안드로이드 파일 선택 창(저장 위치 선택 / 파일 열기)으로 앱 삭제 후에도 남는 위치에 저장·불러오기
    private static final int REQ_CREATE_DOC = 7001;
    private static final int REQ_OPEN_DOC = 7002;
    // 기기 간 동기화 파일 (v0.26.8): 고른 파일의 권한을 계속 유지해 [동기화] 때마다 같은 파일을 읽고 쓴다
    private static final int REQ_SYNC_CREATE = 7003;
    private static final int REQ_SYNC_OPEN = 7004;
    private static final int REQ_GOOGLE_ACCOUNT = 7005; // 기기 구글 계정 고르기 (v0.27.1)
    private static final int REQ_FILE_CHOOSER = 7006; // <input type="file"> 파일 고르기 (v0.30.41, 프로필 사진 올리기)
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private static final String KEY_GACCT = "gdriveAccount:";
    private static final String DRIVE_SCOPE = "oauth2:https://www.googleapis.com/auth/drive.file";
    private String pendingAcctId;
    private String pendingAcctKey;
    private final java.util.Map<String, String> lastDriveToken = new java.util.HashMap<String, String>();
    private static final String KEY_SYNC = "syncUri:";
    private String pendingSyncKey;
    private String pendingDocId;
    private byte[] pendingDocData;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 21) getWindow().setStatusBarColor(Color.parseColor("#D9600A"));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);
        CookieManager.getInstance().setAcceptCookie(true);
        webView.setWebViewClient(new WebViewClient() {
            // 앱 화면과 연결한 서버 안에서만 이동하고, 다른 주소는 휴대폰 브라우저로 연다
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file:///android_asset/") || isServerUrl(url)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageIsLocal = url != null && url.startsWith("file:///android_asset/");
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (isServerUrl(failingUrl)) showCloudError();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                // 서버가 꺼져 있으면 Caddy 가 502 등을 돌려준다
                if (request.isForMainFrame() && response.getStatusCode() >= 500 && isServerUrl(request.getUrl().toString())) showCloudError();
            }
        });
        // alert/confirm 대화상자 + <input type="file"> 파일 고르기 (v0.30.41: 이게 없으면 사진 올리기가 반응하지 않음)
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    String[] types = params != null ? params.getAcceptTypes() : null;
                    String type = types != null && types.length > 0 && types[0] != null && !types[0].isEmpty() ? types[0] : "*/*";
                    i.setType(type);
                    startActivityForResult(Intent.createChooser(i, "사진 선택"), REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(webView);
        openStart();
    }

    /** JS 콜백: window.__docDone(id, ok, payload) */
    private void docDone(final String id, final boolean ok, final String payload) {
        main.post(new Runnable() {
            @Override public void run() {
                webView.evaluateJavascript("window.__docDone && window.__docDone(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload == null ? "" : payload) + ")", null);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_CHOOSER) {
            android.webkit.ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            if (cb != null) cb.onReceiveValue(resultCode == RESULT_OK && data != null && data.getData() != null ? new Uri[] { data.getData() } : null);
            return;
        }
        if (requestCode == REQ_SYNC_CREATE || requestCode == REQ_SYNC_OPEN) { onSyncPicked(requestCode, resultCode, data); return; }
        if (requestCode == REQ_GOOGLE_ACCOUNT) {
            String id = pendingAcctId;
            String key = pendingAcctKey;
            pendingAcctId = null;
            if (id == null) return;
            String name = resultCode == RESULT_OK && data != null ? data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME) : null;
            if (name == null || name.isEmpty()) { docDone(id, false, "구글 계정 선택을 취소했습니다."); return; }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_GACCT + key, name).apply();
            docDone(id, true, name);
            return;
        }
        if (requestCode != REQ_CREATE_DOC && requestCode != REQ_OPEN_DOC) return;
        final String id = pendingDocId;
        final byte[] bytes = pendingDocData;
        pendingDocId = null;
        pendingDocData = null;
        if (id == null) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) { docDone(id, false, "취소했습니다."); return; }
        final Uri uri = data.getData();
        pool.execute(new Runnable() {
            @Override public void run() {
                try {
                    if (requestCode == REQ_CREATE_DOC) {
                        OutputStream out = getContentResolver().openOutputStream(uri, "w");
                        out.write(bytes);
                        out.close();
                        docDone(id, true, "백업 파일을 저장했습니다.");
                    } else {
                        InputStream in = getContentResolver().openInputStream(uri);
                        ByteArrayOutputStream buf = new ByteArrayOutputStream();
                        byte[] b = new byte[8192];
                        int n;
                        while ((n = in.read(b)) > 0) buf.write(b, 0, n);
                        in.close();
                        docDone(id, true, Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
                    }
                } catch (Exception e) {
                    docDone(id, false, "파일 처리 실패: " + e.getMessage());
                }
            }
        });
    }

    private void onSyncPicked(int requestCode, int resultCode, Intent data) {
        final String id = pendingDocId;
        final String key = pendingSyncKey;
        pendingDocId = null;
        pendingSyncKey = null;
        if (id == null) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) { docDone(id, false, "취소했습니다."); return; }
        Uri uri = data.getData();
        try {
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            docDone(id, false, "이 파일은 계속 읽고 쓸 권한을 받을 수 없습니다. 다른 저장 위치(예: 구글 드라이브)를 골라 주세요.");
            return;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SYNC + key, uri.toString()).apply();
        docDone(id, true, displayName(uri));
    }

    private String displayName(Uri uri) {
        android.database.Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[] { "_display_name" }, null, null, null);
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return uri.getLastPathSegment();
    }

    /**
     * 읽기 전에 클라우드 앱에 서버의 최신 파일을 받아 달라고 요청 (Android 8.0+ ContentResolver.refresh, v0.26.18).
     * 구글 드라이브 앱이 꺼져 있으면 기기에 남은 예전 사본을 주는 경우가 있어서. 지원하지 않는 앱이면 그냥 넘어간다.
     */
    private void refreshDoc(Uri u) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            java.lang.reflect.Method m = ContentResolver.class.getMethod("refresh", Uri.class, Bundle.class, Class.forName("android.os.CancellationSignal"));
            m.invoke(getContentResolver(), u, null, null);
        } catch (Throwable ignored) { }
    }

    private Uri syncUri(String key) {
        String u = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SYNC + key, "");
        return u.isEmpty() ? null : Uri.parse(u);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush(); // 로그인 상태 저장
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private File dbFile() {
        return new File(getFilesDir(), "stock.db");
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    private class Bridge {

        /** 연결한 클라우드 서버 주소 ("" 이면 이 휴대폰 모드) */
        @JavascriptInterface
        public String getServerUrl() {
            return serverUrl.isEmpty() ? loadServerUrl() : serverUrl;
        }

        /** 서버 주소 저장 후 그 서버 화면을 연다. "" 이면 이 휴대폰 모드로. 오류 문구를 돌려주고 성공하면 "" */
        @JavascriptInterface
        public String setServerUrl(String raw) {
            final String url = normalizeServer(raw);
            if (url == null) return "https:// 로 시작하는 올바른 서버 주소를 입력하세요.";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply();
            main.post(new Runnable() {
                @Override public void run() { openStart(); }
            });
            return "";
        }

        /** 외부 출처 GET. 결과는 window.__mobileHttpDone(id, status, base64, error) 로 돌려준다. */
        @JavascriptInterface
        public void httpGet(final String id, final String url) {
            request(id, url, null);
        }

        /** 외부 출처 POST (폼 전송). 결과 전달 방식은 httpGet 과 같다. */
        @JavascriptInterface
        public void httpPost(final String id, final String url, final String formBody) {
            request(id, url, formBody == null ? "" : formBody);
        }

        /**
         * 일반 HTTPS 요청 (v0.27.0, 구글 드라이브): 메서드·헤더(JSON)·본문(base64). 결과 전달은 httpGet 과 같다.
         * HttpURLConnection 은 PATCH 를 못 보내므로 POST + X-HTTP-Method-Override 로 보낸다(구글 API 지원).
         */
        @JavascriptInterface
        public void httpRequest(final String id, final String method, final String url, final String headersJson, final String bodyB64) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    int status = 0;
                    String b64 = "";
                    String error = null;
                    HttpURLConnection c = null;
                    try {
                        if (!pageIsLocal) throw new Exception("서버 화면에서는 사용할 수 없습니다.");
                        URL u = new URL(url);
                        if (!"https".equals(u.getProtocol()) || !ALLOWED_HOSTS.contains(u.getHost())) throw new Exception("허용되지 않은 주소입니다.");
                        c = (HttpURLConnection) u.openConnection();
                        c.setConnectTimeout(15000);
                        c.setReadTimeout(30000);
                        String m = method == null ? "GET" : method.toUpperCase();
                        if ("PATCH".equals(m)) { c.setRequestProperty("X-HTTP-Method-Override", "PATCH"); m = "POST"; }
                        c.setRequestMethod(m);
                        JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                        java.util.Iterator<String> it = h.keys();
                        while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
                        byte[] body = bodyB64 == null || bodyB64.isEmpty() ? null : Base64.decode(bodyB64, Base64.DEFAULT);
                        if (body != null || "POST".equals(m)) {
                            c.setDoOutput(true);
                            OutputStream os = c.getOutputStream();
                            if (body != null) os.write(body);
                            os.close();
                        }
                        status = c.getResponseCode();
                        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                        byte[] out = in == null ? new byte[0] : readAll(in);
                        b64 = Base64.encodeToString(out, Base64.NO_WRAP);
                    } catch (Exception e) {
                        error = e.getMessage() == null ? e.toString() : e.getMessage();
                    } finally {
                        if (c != null) c.disconnect();
                    }
                    final String js = "window.__mobileHttpDone(" + JSONObject.quote(id) + "," + status + ","
                            + JSONObject.quote(b64) + "," + (error == null ? "null" : JSONObject.quote(error)) + ")";
                    main.post(new Runnable() {
                        @Override public void run() { if (webView != null) webView.evaluateJavascript(js, null); }
                    });
                }
            });
        }

        private void request(final String id, final String url, final String formBody) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    int status = 0;
                    String b64 = "";
                    String error = null;
                    HttpURLConnection c = null;
                    try {
                        if (!pageIsLocal) throw new Exception("서버 화면에서는 사용할 수 없습니다.");
                        URL u = new URL(url);
                        if (!"https".equals(u.getProtocol()) || !ALLOWED_HOSTS.contains(u.getHost())) {
                            throw new Exception("허용되지 않은 주소입니다.");
                        }
                        c = (HttpURLConnection) u.openConnection();
                        c.setConnectTimeout(12000);
                        c.setReadTimeout(12000);
                        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) stock-manager-prototype");
                        if (formBody != null) {
                            c.setRequestMethod("POST");
                            c.setDoOutput(true);
                            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
                            OutputStream os = c.getOutputStream();
                            os.write(formBody.getBytes("UTF-8"));
                            os.close();
                        }
                        status = c.getResponseCode();
                        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                        byte[] body = in == null ? new byte[0] : readAll(in);
                        b64 = Base64.encodeToString(body, Base64.NO_WRAP);
                    } catch (Exception e) {
                        error = e.getMessage() == null ? e.toString() : e.getMessage();
                    } finally {
                        if (c != null) c.disconnect();
                    }
                    final String js = "window.__mobileHttpDone(" + JSONObject.quote(id) + "," + status + ","
                            + JSONObject.quote(b64) + "," + (error == null ? "null" : JSONObject.quote(error)) + ")";
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) webView.evaluateJavascript(js, null);
                        }
                    });
                }
            });
        }

        @JavascriptInterface
        public String loadDb() {
            if (!pageIsLocal) return "";
            try {
                File f = dbFile();
                if (!f.exists()) return "";
                return Base64.encodeToString(readAll(new FileInputStream(f)), Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveDb(String b64) {
            if (!pageIsLocal) return;
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                File tmp = new File(getFilesDir(), "stock.db.tmp");
                FileOutputStream out = new FileOutputStream(tmp);
                out.write(data);
                out.getFD().sync();
                out.close();
                if (!tmp.renameTo(dbFile())) throw new Exception("rename failed");
            } catch (Exception e) {
                // 다음 저장 때 다시 시도됨
            }
        }

        /** 백업 파일 저장: 파일 선택 창에서 저장 위치를 고르게 한다 (결과는 window.__docDone). */
        @JavascriptInterface
        public void createDocument(final String name, final String mime, final String b64, final String id) {
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        pendingDocId = id;
                        pendingDocData = Base64.decode(b64, Base64.DEFAULT);
                        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType(mime);
                        i.putExtra(Intent.EXTRA_TITLE, name);
                        startActivityForResult(i, REQ_CREATE_DOC);
                    } catch (Exception e) {
                        pendingDocId = null;
                        docDone(id, false, "저장 창을 열 수 없습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 동기화 파일 고르기 (v0.26.8): create=새로 만들기, 아니면 기존 파일 열기. 결과는 window.__docDone(파일 이름). */
        @JavascriptInterface
        public void syncPick(final String key, final boolean create, final String id) {
            if (!pageIsLocal) { docDone(id, false, "서버 화면에서는 사용할 수 없습니다."); return; }
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        pendingDocId = id;
                        pendingSyncKey = key;
                        Intent i = new Intent(create ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType(create ? "application/json" : "*/*");
                        if (create) i.putExtra(Intent.EXTRA_TITLE, "kstock-sync.json");
                        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                        startActivityForResult(i, create ? REQ_SYNC_CREATE : REQ_SYNC_OPEN);
                    } catch (Exception e) {
                        pendingDocId = null;
                        docDone(id, false, "파일 창을 열 수 없습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 연결된 동기화 파일 이름 (없으면 빈 문자열) */
        @JavascriptInterface
        public String syncName(String key) {
            Uri u = syncUri(key);
            return u == null ? "" : displayName(u);
        }

        @JavascriptInterface
        public void syncUnlink(String key) {
            Uri u = syncUri(key);
            if (u != null) {
                try { getContentResolver().releasePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch (Exception ignored) { }
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_SYNC + key).apply();
        }

        /** 동기화 파일 읽기 → base64 (빈 파일이면 빈 문자열) */
        @JavascriptInterface
        public void syncRead(final String key, final String id) {
            if (!pageIsLocal) { docDone(id, false, "서버 화면에서는 사용할 수 없습니다."); return; }
            pool.execute(new Runnable() {
                @Override public void run() {
                    try {
                        Uri u = syncUri(key);
                        if (u == null) throw new Exception("연결된 동기화 파일이 없습니다.");
                        refreshDoc(u);
                        InputStream in = getContentResolver().openInputStream(u);
                        ByteArrayOutputStream buf = new ByteArrayOutputStream();
                        byte[] b = new byte[8192];
                        int n;
                        while ((n = in.read(b)) > 0) buf.write(b, 0, n);
                        in.close();
                        docDone(id, true, Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
                    } catch (Exception e) {
                        docDone(id, false, "동기화 파일을 읽지 못했습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 동기화 파일을 제공하는 클라우드 앱(구글 드라이브 등)을 연다 → 그 앱이 서버와 동기화 (v0.26.18) */
        @JavascriptInterface
        public boolean syncOpenApp(String key) {
            try {
                Uri u = syncUri(key);
                if (u == null) return false;
                android.content.pm.ProviderInfo pi = getPackageManager().resolveContentProvider(u.getAuthority(), 0);
                String pkg = pi != null ? pi.packageName
                    : (String.valueOf(u.getAuthority()).startsWith("com.google.android.apps.docs") ? "com.google.android.apps.docs" : null);
                if (pkg == null) return false;
                Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
                if (i == null) return false;
                startActivity(i);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /**
         * 기기 구글 계정으로 구글 드라이브 연결 (v0.27.1)
         * 휴대폰에 이미 로그인된 구글 계정 목록에서 고르게 한다(비밀번호·클라이언트 ID 입력 없음). 결과는 window.__docDone(계정 이메일)
         */
        @JavascriptInterface
        public void gdriveAccountPick(final String key, final String id) {
            if (!pageIsLocal) { docDone(id, false, "서버 화면에서는 사용할 수 없습니다."); return; }
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        pendingAcctId = id;
                        pendingAcctKey = key;
                        @SuppressWarnings("deprecation")
                        Intent i = AccountManager.newChooseAccountIntent(null, null, new String[] { "com.google" }, true, null, null, null, null);
                        startActivityForResult(i, REQ_GOOGLE_ACCOUNT);
                    } catch (Exception e) {
                        pendingAcctId = null;
                        docDone(id, false, "구글 계정 선택 창을 열 수 없습니다: " + e.getMessage());
                    }
                }
            });
        }

        /**
         * 구글 공식 계정 선택 창 (v0.30.30): 구글 Play 서비스의 계정 선택 화면(AccountPicker 와 같은 인텐트)을 연다.
         * 휴대폰의 모든 구글 계정이 처음부터 보인다. Play 서비스가 없으면 휴대폰 기본 선택 창으로. 결과는 window.__docDone(계정 이메일)
         */
        @JavascriptInterface
        public void gdriveAccountPickGoogle(final String key, final String id) {
            if (!pageIsLocal) { docDone(id, false, "서버 화면에서는 사용할 수 없습니다."); return; }
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        pendingAcctId = id;
                        pendingAcctKey = key;
                        Intent i = new Intent("com.google.android.gms.common.account.CHOOSE_ACCOUNT");
                        i.setPackage("com.google.android.gms");
                        i.putExtra("allowableAccounts", (ArrayList<Account>) null);
                        i.putExtra("allowableAccountTypes", new String[] { "com.google" });
                        i.putExtra("addAccountOptions", (Bundle) null);
                        String cur = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_GACCT + key, "");
                        i.putExtra("selectedAccount", cur.isEmpty() ? null : new Account(cur, "com.google"));
                        i.putExtra("selectedAccountIsNotClickable", false);
                        i.putExtra("alwaysPromptForAccount", true);
                        i.putExtra("descriptionTextOverride", "K-Stock 동기화 파일을 저장할 구글 계정을 선택하세요");
                        i.putExtra("setGmsCoreAccount", false);
                        i.putExtra("realClientPackage", (String) null);
                        i.putExtra("overrideTheme", 0);
                        i.putExtra("overrideCustomTheme", 0);
                        i.putExtra("hostedDomainFilter", (String) null);
                        if (i.resolveActivity(getPackageManager()) == null) {
                            @SuppressWarnings("deprecation")
                            Intent sys = AccountManager.newChooseAccountIntent(null, null, new String[] { "com.google" }, true, null, null, null, null);
                            i = sys;
                        }
                        startActivityForResult(i, REQ_GOOGLE_ACCOUNT);
                    } catch (Exception e) {
                        pendingAcctId = null;
                        docDone(id, false, "구글 계정 선택 창을 열 수 없습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 연결한 구글 계정 이메일 (없으면 빈 문자열) */
        @JavascriptInterface
        public String gdriveAccount(String key) {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_GACCT + key, "");
        }

        /** 연결 해제: 기억한 계정과 받아 둔 토큰을 지운다 */
        @JavascriptInterface
        public void gdriveUnlink(final String key) {
            final String t = lastDriveToken.remove(key);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_GACCT + key).apply();
            if (t != null) {
                main.post(new Runnable() {
                    @Override public void run() { try { AccountManager.get(MainActivity.this).invalidateAuthToken("com.google", t); } catch (Exception ignored) { } }
                });
            }
        }

        /**
         * 구글 드라이브 접근 토큰 받기: 처음에는 구글의 권한 허용 화면이 뜨고, 이후에는 바로 받는다.
         * renew=true 면 만료된 토큰을 버리고 새로 받는다. 결과는 window.__docDone(토큰)
         */
        @JavascriptInterface
        public void gdriveToken(final String key, final boolean renew, final String id) {
            if (!pageIsLocal) { docDone(id, false, "서버 화면에서는 사용할 수 없습니다."); return; }
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        String name = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_GACCT + key, "");
                        if (name.isEmpty()) { docDone(id, false, "연결한 구글 계정이 없습니다."); return; }
                        AccountManager am = AccountManager.get(MainActivity.this);
                        String old = lastDriveToken.get(key);
                        if (renew && old != null) { am.invalidateAuthToken("com.google", old); lastDriveToken.remove(key); }
                        am.getAuthToken(new Account(name, "com.google"), DRIVE_SCOPE, null, MainActivity.this, new AccountManagerCallback<Bundle>() {
                            @Override public void run(AccountManagerFuture<Bundle> f) {
                                try {
                                    String t = f.getResult().getString(AccountManager.KEY_AUTHTOKEN);
                                    if (t == null || t.isEmpty()) { docDone(id, false, "구글 드라이브 권한을 받지 못했습니다."); return; }
                                    lastDriveToken.put(key, t);
                                    docDone(id, true, t);
                                } catch (OperationCanceledException e) {
                                    docDone(id, false, "구글 드라이브 권한 허용을 취소했습니다.");
                                } catch (Exception e) {
                                    docDone(id, false, "구글 드라이브 권한을 받지 못했습니다: " + e.getMessage()
                                        + " (구글 클라우드 콘솔에 이 앱의 Android 클라이언트(패키지 이름·SHA-1)가 등록되어 있어야 합니다)");
                                }
                            }
                        }, null);
                    } catch (Exception e) {
                        docDone(id, false, "구글 드라이브 권한을 받지 못했습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 동기화 파일 쓰기 (내용 전체를 바꿈) */
        @JavascriptInterface
        public void syncWrite(final String key, final String b64, final String id) {
            if (!pageIsLocal) { docDone(id, false, "서버 화면에서는 사용할 수 없습니다."); return; }
            pool.execute(new Runnable() {
                @Override public void run() {
                    try {
                        Uri u = syncUri(key);
                        if (u == null) throw new Exception("연결된 동기화 파일이 없습니다.");
                        byte[] data = Base64.decode(b64, Base64.DEFAULT);
                        OutputStream out;
                        try { out = getContentResolver().openOutputStream(u, "wt"); } catch (Exception e) { out = getContentResolver().openOutputStream(u, "w"); }
                        out.write(data);
                        out.close();
                        docDone(id, true, "ok");
                    } catch (Exception e) {
                        docDone(id, false, "동기화 파일에 쓰지 못했습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 백업 파일 열기: 파일 선택 창에서 고른 파일 내용을 base64로 돌려준다. */
        @JavascriptInterface
        public void openDocument(final String id) {
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        pendingDocId = id;
                        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("*/*");
                        startActivityForResult(i, REQ_OPEN_DOC);
                    } catch (Exception e) {
                        pendingDocId = null;
                        docDone(id, false, "파일 창을 열 수 없습니다: " + e.getMessage());
                    }
                }
            });
        }

        /** 엑셀 파일을 다운로드 폴더에 저장하고 안내 문구를 돌려준다. */
        @JavascriptInterface
        public String saveFile(String name, String b64, String mime) {
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver cr = getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put("_display_name", name);
                    v.put("mime_type", mime);
                    v.put("relative_path", Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = cr.insert(Uri.parse("content://media/external/downloads"), v);
                    if (uri == null) throw new Exception("파일을 만들 수 없습니다.");
                    OutputStream out = cr.openOutputStream(uri);
                    out.write(data);
                    out.close();
                    return "다운로드 폴더에 저장했습니다: " + name;
                }
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = getFilesDir();
                dir.mkdirs();
                File f = new File(dir, name);
                FileOutputStream out = new FileOutputStream(f);
                out.write(data);
                out.close();
                return "저장했습니다: " + f.getAbsolutePath();
            } catch (Exception e) {
                return "저장 실패: " + e.getMessage();
            }
        }
    }
}
