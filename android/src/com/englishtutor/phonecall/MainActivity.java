package com.englishtutor.phonecall;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 전화영어 앱 화면. public/ 의 웹 화면을 WebView로 띄우고,
 * 안드로이드 WebView에는 없는 음성 인식/음성 출력을 window.AndroidBridge 로 제공합니다.
 */
public class MainActivity extends Activity {
    private static final int REQ_MIC = 1;
    private static final String PREFS = "settings";
    private static final String KEY_API = "anthropic_api_key";

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private SpeechRecognizer recognizer;
    private boolean listening = false;
    private boolean pendingListen = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebChromeClient(new WebChromeClient()); // alert() 표시용
        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                if (status != TextToSpeech.SUCCESS) return;
                tts.setLanguage(Locale.US);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { callJs("__nativeTtsDone", id, null); }
                    @Override public void onError(String id) { callJs("__nativeTtsDone", id, null); }
                });
                ttsReady = true;
            }
        });
    }

    /** JS 함수 window[fn](a, b) 를 UI 스레드에서 호출합니다. */
    private void callJs(final String fn, final String a, final String b) {
        final String js = "window." + fn + " && window." + fn + "(" + JSONObject.quote(a == null ? "" : a)
                + "," + JSONObject.quote(b == null ? "" : b) + ")";
        web.post(new Runnable() {
            @Override public void run() { web.evaluateJavascript(js, null); }
        });
    }

    private void speechEvent(String type, String text) {
        callJs("__nativeSpeech", type, text);
    }

    // ---------------- 음성 인식 ----------------

    private void startListeningNow() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            speechEvent("error", "unavailable");
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new Listener());
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-US");
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000);
        listening = true;
        recognizer.startListening(intent);
    }

    private void finishListening() {
        if (!listening) return;
        listening = false;
        speechEvent("end", null);
    }

    private static String first(Bundle results) {
        if (results == null) return "";
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (list == null || list.isEmpty()) ? "" : list.get(0);
    }

    private class Listener implements RecognitionListener {
        @Override public void onReadyForSpeech(Bundle params) { speechEvent("start", null); }
        @Override public void onBeginningOfSpeech() { }
        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int eventType, Bundle params) { }

        @Override public void onPartialResults(Bundle partial) {
            speechEvent("interim", first(partial));
        }

        @Override public void onResults(Bundle results) {
            String text = first(results);
            if (!text.isEmpty()) speechEvent("final", text);
            finishListening();
        }

        @Override public void onError(int error) {
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) speechEvent("error", "not-allowed");
            else if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                speechEvent("error", "code-" + error);
            }
            finishListening();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_MIC) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (pendingListen && granted) startListeningNow();
        else if (!granted) speechEvent("error", "not-allowed");
        pendingListen = false;
    }

    // ---------------- JS 브리지 ----------------

    private class Bridge {
        @JavascriptInterface
        public void speak(final String text, final double rate, final String id) {
            if (!ttsReady) { callJs("__nativeTtsDone", id, null); return; }
            tts.setSpeechRate((float) rate);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (ttsReady) tts.stop();
        }

        @JavascriptInterface
        public void startListening() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (ttsReady) tts.stop();
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        startListeningNow();
                    } else {
                        pendingListen = true;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                }
            });
        }

        @JavascriptInterface
        public void stopListening() {
            runOnUiThread(new Runnable() {
                @Override public void run() { if (recognizer != null && listening) recognizer.stopListening(); }
            });
        }

        @JavascriptInterface
        public String getApiKey() {
            return getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_API, "");
        }

        @JavascriptInterface
        public void setApiKey(String key) {
            SharedPreferences.Editor e = getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
            e.putString(KEY_API, key == null ? "" : key.trim());
            e.apply();
        }
    }

    // ---------------- 생명주기 ----------------

    @Override
    protected void onPause() {
        super.onPause();
        if (ttsReady) tts.stop();
        if (recognizer != null && listening) {
            recognizer.cancel();
            finishListening();
        }
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (recognizer != null) recognizer.destroy();
        web.destroy();
        super.onDestroy();
    }
}
