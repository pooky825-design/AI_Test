package com.stockmanager.prototype;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
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
            "ac.stock.naver.com")); // 종목명 검색 (v0.21.1)

    private WebView webView;

    // 백업·복원 (v0.15): 안드로이드 파일 선택 창(저장 위치 선택 / 파일 열기)으로 앱 삭제 후에도 남는 위치에 저장·불러오기
    private static final int REQ_CREATE_DOC = 7001;
    private static final int REQ_OPEN_DOC = 7002;
    private String pendingDocId;
    private byte[] pendingDocData;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 21) getWindow().setStatusBarColor(Color.parseColor("#1F4E79"));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient()); // alert/confirm 대화상자
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
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

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
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

        private void request(final String id, final String url, final String formBody) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    int status = 0;
                    String b64 = "";
                    String error = null;
                    HttpURLConnection c = null;
                    try {
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
