package com.buubit.fmdrops;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
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
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Casca mínima: uma WebView que serve o app (pasta /web do repositório) em https://app.fmdrops/.
 * Os arquivos vêm do APK (assets) ou, se existir, do pacote mais novo baixado pela atualização
 * interna (filesDir/web), o que permite atualizar o app sem reinstalar o APK.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;
    private static final int PATCH_IMAGE = 2, PATCH_PPF = 3, PATCH_OUT = 4, BUILD_OUT = 5, TREE_OUT = 6;
    private Uri jobImage;
    private Object jobPpf;
    private String jobName;
    private Uri patchImage, patchPpf, lastImage;
    private byte[] buildPpf;
    private static final String HOST = "app.fmdrops";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final String UPDATE_PREFIX = "https://github.com/buubit/fmdrops/releases/download/";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private ValueCallback<Uri[]> pending;
    private File bundle;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        bundle = new File(getFilesDir(), "web");
        // Um pacote baixado mais antigo que o próprio APK não serve mais.
        if (bundleBuild() <= shellBuild()) delete(bundle);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#08141a"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                return serve(url.getLastPathSegment());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                // Links externos abrem no navegador do aparelho.
                try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pending != null) pending.onReceiveValue(null);
                pending = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(pick, PICK_FILE);
                } catch (Exception e) {
                    pending = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });
        setContentView(web);
        load();
    }

    private void load() {
        web.loadUrl(HOME);
        if (!bundle.exists()) return;
        // Rede de segurança: se o pacote baixado não iniciar, volta para a versão do APK.
        ui.postDelayed(() -> web.evaluateJavascript("window.__fmBooted === true", ok -> {
            if (!"true".equals(ok) && bundle.exists()) {
                delete(bundle);
                web.loadUrl(HOME);
            }
        }), 8000);
    }

    private WebResourceResponse serve(String name) {
        if (name == null || name.isEmpty()) name = "index.html";
        String mime = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "text/javascript"
                : name.endsWith(".css") ? "text/css" : "application/octet-stream";
        try {
            File f = new File(bundle, name);
            InputStream in = f.isFile() ? new FileInputStream(f) : getAssets().open(name);
            return new WebResourceResponse(mime, "utf-8", in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new java.util.HashMap<String, String>(), new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    private int shellBuild() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    private int bundleBuild() {
        try {
            return Integer.parseInt(new String(readAll(new FileInputStream(new File(bundle, "build"))), StandardCharsets.UTF_8).trim());
        } catch (Exception e) {
            return 0;
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = src.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void delete(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) delete(k);
        f.delete();
    }

    /** Baixa web.json ({build, files:{nome: conteúdo}}) e troca o pacote local. */
    private void installBundle(String address) throws Exception {
        if (!address.startsWith(UPDATE_PREFIX)) throw new Exception("endereço de atualização inválido");
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        if (c.getResponseCode() != 200) throw new Exception("download respondeu " + c.getResponseCode());
        JSONObject json = new JSONObject(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
        JSONObject files = json.getJSONObject("files");
        if (!files.has("index.html") || !files.has("app.js")) throw new Exception("pacote incompleto");

        File tmp = new File(getFilesDir(), "web.new");
        delete(tmp);
        if (!tmp.mkdirs()) throw new Exception("sem espaço para gravar");
        for (Iterator<String> it = files.keys(); it.hasNext(); ) {
            String name = it.next();
            if (!name.matches("[A-Za-z0-9_.-]+")) continue;
            try (FileOutputStream out = new FileOutputStream(new File(tmp, name))) {
                out.write(files.getString(name).getBytes(StandardCharsets.UTF_8));
            }
        }
        try (FileOutputStream out = new FileOutputStream(new File(tmp, "build"))) {
            out.write(String.valueOf(json.getInt("build")).getBytes(StandardCharsets.UTF_8));
        }
        delete(bundle);
        if (!tmp.renameTo(bundle)) throw new Exception("não consegui gravar a atualização");
    }

    private class Bridge {
        /** Versão da casca Android; só muda quando o APK precisa ser reinstalado. */
        @JavascriptInterface
        public int shellVersion() {
            return BuildConfig.SHELL;
        }

        /** Escolhe a imagem do jogo, o .ppf e onde salvar; depois aplica o patch. */
        @JavascriptInterface
        public void applyPatch() {
            ui.post(() -> pick(PATCH_IMAGE));
        }

        /** Grava um .bin novo: a última imagem escolhida no app + o patch gerado pelo editor (base64). */
        @JavascriptInterface
        public void buildImage(String ppfBase64, String suggestedName) {
            if (lastImage == null) {
                js("onPatchError", JSONObject.quote("escolha o .bin do jogo de novo"));
                return;
            }
            buildPpf = android.util.Base64.decode(ppfBase64, android.util.Base64.DEFAULT);
            final Uri img = lastImage;
            final byte[] ppf = buildPpf;
            ui.post(() -> startOutput(img, ppf, suggestedName));
        }

        /** Nome da pasta onde os jogos gerados são gravados ("" se ainda não escolhida). */
        @JavascriptInterface
        public String outputFolder() {
            Uri t = savedTree();
            return t == null ? "" : treeLabel(t);
        }

        @JavascriptInterface
        public void chooseOutputFolder() {
            ui.post(() -> { jobImage = null; askTree(); });
        }

        @JavascriptInterface
        public void applyUpdate(final String address) {
            new Thread(() -> {
                try {
                    installBundle(address);
                    ui.post(MainActivity.this::load);
                } catch (Exception e) {
                    final String msg = JSONObject.quote(String.valueOf(e.getMessage()));
                    ui.post(() -> web.evaluateJavascript("window.onUpdateError && window.onUpdateError(" + msg + ")", null));
                }
            }).start();
        }
    }

    private void pick(int request) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(i, request);
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return "jogo.bin";
    }

    private void js(String fn, String arg) {
        ui.post(() -> web.evaluateJavascript("window." + fn + " && window." + fn + "(" + arg + ")", null));
    }

    private void runJob(final Uri img, final Object ppf, final Uri out, final Uri cue) {
        final String name = displayName(out);
        new Thread(() -> {
            try {
                final long[] lastSent = { 0 };
                PatchJob.Progress pr = f -> {
                    long now = System.currentTimeMillis();
                    if (now - lastSent[0] > 250) { lastSent[0] = now; js("onPatchProgress", String.valueOf(f)); }
                };
                if (ppf instanceof Uri) PatchJob.run(getContentResolver(), img, (Uri) ppf, out, pr);
                else PatchJob.run(getContentResolver(), img, (byte[]) ppf, out, pr);
                if (cue != null) {
                    String sheet = "FILE \"" + name + "\" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n";
                    try (java.io.OutputStream os = getContentResolver().openOutputStream(cue, "wt")) {
                        os.write(sheet.getBytes(StandardCharsets.UTF_8));
                    }
                }
                js("onPatchDone", JSONObject.quote(name));
            } catch (Exception e) {
                try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), out); } catch (Exception ignored) { }
                js("onPatchError", JSONObject.quote(String.valueOf(e.getMessage())));
            }
        }).start();
    }

    private Uri savedTree() {
        String t = getSharedPreferences("fm", MODE_PRIVATE).getString("outTree", null);
        if (t == null) return null;
        Uri u = Uri.parse(t);
        for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(u) && p.isWritePermission()) return u;
        }
        return null;
    }

    private String treeLabel(Uri tree) {
        String id = android.provider.DocumentsContract.getTreeDocumentId(tree);
        return id.contains(":") ? id.substring(id.indexOf(':') + 1) : id;
    }

    private void askTree() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        js("onPatchState", JSONObject.quote("Escolha a pasta de jogos do DuckStation (só na primeira vez)"));
        startActivityForResult(i, TREE_OUT);
    }

    /** Arquivo `name` dentro da pasta: reaproveita se já existir (sobrescreve), senão cria. */
    private Uri fileIn(Uri tree, String name) throws Exception {
        android.content.ContentResolver cr = getContentResolver();
        String dirId = android.provider.DocumentsContract.getTreeDocumentId(tree);
        Uri children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, dirId);
        try (Cursor c = cr.query(children, new String[] {
                android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (name.equals(c.getString(1))) return android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
            }
        }
        Uri dir = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, dirId);
        Uri made = android.provider.DocumentsContract.createDocument(cr, dir, "application/octet-stream", name);
        if (made == null) throw new Exception("não consegui criar " + name);
        return made;
    }

    /** Grava <nome>.bin e <nome>.cue na pasta de jogos escolhida (pergunta a pasta na primeira vez). */
    private void startOutput(Uri img, Object ppf, String name) {
        Uri tree = savedTree();
        if (tree == null) {
            jobImage = img; jobPpf = ppf; jobName = name;
            askTree();
            return;
        }
        jobImage = null;
        try {
            String bin = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            Uri out = fileIn(tree, bin);
            if (img != null && android.provider.DocumentsContract.getDocumentId(out)
                    .equals(android.provider.DocumentsContract.getDocumentId(img))) {
                throw new Exception("o arquivo novo teria o mesmo nome do jogo base; mude alguma opção ou use outra base");
            }
            String real = displayName(out);
            Uri cue = fileIn(tree, real.replaceAll("\\.[^.]*$", "") + ".cue");
            js("onPatchState", JSONObject.quote("Gravando em " + treeLabel(tree) + "…"));
            runJob(img, ppf, out, cue);
        } catch (Exception e) {
            js("onPatchError", JSONObject.quote(String.valueOf(e.getMessage())));
        }
    }

    private void onPatchResult(int request, int result, Intent data) {
        if (result != RESULT_OK || data == null || data.getData() == null) {
            js("onPatchState", JSONObject.quote("cancelado"));
            return;
        }
        Uri uri = data.getData();
        if (request == PATCH_IMAGE) {
            patchImage = uri;
            js("onPatchState", JSONObject.quote("imagem: " + displayName(uri) + ". Agora escolha o arquivo .ppf"));
            pick(PATCH_PPF);
        } else if (request == PATCH_PPF) {
            patchPpf = uri;
            String base = displayName(patchImage).replaceAll("\\.(bin|BIN|iso|img)$", "");
            String mod = displayName(uri).replaceAll("\\.(ppf|PPF)$", "");
            startOutput(patchImage, patchPpf, (mod.equals(base) ? base + " (mod)" : base + " - " + mod) + ".bin");
        } else if (request == TREE_OUT) {
            getContentResolver().takePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getSharedPreferences("fm", MODE_PRIVATE).edit().putString("outTree", uri.toString()).apply();
            js("onOutputFolder", JSONObject.quote(treeLabel(uri)));
            if (jobImage != null) startOutput(jobImage, jobPpf, jobName);
        } else {
            runJob(request == BUILD_OUT ? lastImage : patchImage, request == BUILD_OUT ? buildPpf : patchPpf, uri, null);
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request >= PATCH_IMAGE && request <= BUILD_OUT) { onPatchResult(request, result, data); return; }
        if (request != PICK_FILE || pending == null) return;
        Uri[] uris = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                uris = new Uri[clip.getItemCount()];
                for (int i = 0; i < uris.length; i++) uris[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[] { data.getData() };
            }
        }
        if (uris != null && uris.length == 1) lastImage = uris[0];
        pending.onReceiveValue(uris);
        pending = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
