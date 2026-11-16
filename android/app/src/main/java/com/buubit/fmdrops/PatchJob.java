package com.buubit.fmdrops;

import android.content.ContentResolver;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Aplica um patch PPF (v1, v2 ou v3) a uma imagem de CD, gravando uma cópia nova.
 * Se o PPF trouxer os bytes originais (undo, gerado pelo tools/fmmod.py), confere
 * que a imagem de entrada é a certa antes de terminar.
 */
final class PatchJob {
    interface Progress { void update(double fraction); }

    private static final class Rec {
        final long off; final byte[] data; final byte[] orig;
        Rec(long off, byte[] data, byte[] orig) { this.off = off; this.data = data; this.orig = orig; }
    }

    static byte[] readAll(InputStream in) throws Exception {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            for (int n; (n = src.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static List<Rec> parse(byte[] p) throws Exception {
        if (p.length < 56 || p[0] != 'P' || p[1] != 'P' || p[2] != 'F') throw new Exception("o arquivo não é um patch .ppf");
        int version = p[5] + 1;
        List<Rec> recs = new ArrayList<>();
        int i;
        boolean undo = false, wide = version >= 3;
        if (version == 1) {
            i = 56;
        } else if (version == 2) {
            i = 56 + 4 + 1024;
        } else {
            boolean blockCheck = p[57] != 0;
            undo = p[58] != 0;
            i = 60 + (blockCheck ? 1024 : 0);
        }
        int end = p.length;
        // descrição opcional no fim (FILE_ID.DIZ)
        if (version >= 2 && end >= 4 && p[end - 4] == '.' && p[end - 3] == 'D' && p[end - 2] == 'I' && p[end - 1] == 'Z') {
            int lenPos = end - (version == 2 ? 8 : 6);
            int dizLen = version == 2 ? (p[lenPos] & 0xFF) | (p[lenPos + 1] & 0xFF) << 8 | (p[lenPos + 2] & 0xFF) << 16 | (p[lenPos + 3] & 0xFF) << 24
                    : (p[lenPos] & 0xFF) | (p[lenPos + 1] & 0xFF) << 8;
            end = lenPos - dizLen - 18;
        }
        while (i < end) {
            long off = 0;
            int w = wide ? 8 : 4;
            for (int k = w - 1; k >= 0; k--) off = (off << 8) | (p[i + k] & 0xFF);
            i += w;
            int len = p[i++] & 0xFF;
            byte[] data = new byte[len];
            System.arraycopy(p, i, data, 0, len);
            i += len;
            byte[] orig = null;
            if (undo) {
                orig = new byte[len];
                System.arraycopy(p, i, orig, 0, len);
                i += len;
            }
            recs.add(new Rec(off, data, orig));
        }
        recs.sort((a, b) -> Long.compare(a.off, b.off));
        return recs;
    }

    /** Copia `image` para `out` aplicando o patch. Retorna o número de bytes gravados. */
    static long run(ContentResolver cr, Uri image, Uri ppf, Uri out, Progress progress) throws Exception {
        return run(cr, image, readAll(cr.openInputStream(ppf)), out, progress);
    }

    static long run(ContentResolver cr, Uri image, byte[] ppfBytes, Uri out, Progress progress) throws Exception {
        List<Rec> recs = parse(ppfBytes);
        if (recs.isEmpty()) throw new Exception("o patch está vazio");
        long total = -1;
        try (android.content.res.AssetFileDescriptor fd = cr.openAssetFileDescriptor(image, "r")) {
            if (fd != null) total = fd.getLength();
        } catch (Exception ignored) { }
        long last = recs.get(recs.size() - 1).off + recs.get(recs.size() - 1).data.length;
        if (total > 0 && last > total) throw new Exception("este patch não é para esta imagem (ela é menor que o esperado)");

        byte[] buf = new byte[1 << 20];
        long pos = 0;
        int r = 0;
        try (InputStream in = cr.openInputStream(image); OutputStream os = cr.openOutputStream(out, "wt")) {
            if (in == null || os == null) throw new Exception("não consegui abrir os arquivos");
            int n;
            while ((n = readFully(in, buf)) > 0) {
                long chunkEnd = pos + n;
                // recua para pegar registros que começaram no bloco anterior
                while (r > 0 && recs.get(r - 1).off + recs.get(r - 1).data.length > pos) r--;
                for (int k = r; k < recs.size() && recs.get(k).off < chunkEnd; k++) {
                    Rec rec = recs.get(k);
                    for (int j = 0; j < rec.data.length; j++) {
                        long at = rec.off + j;
                        if (at < pos || at >= chunkEnd) continue;
                        int idx = (int) (at - pos);
                        if (rec.orig != null && buf[idx] != rec.orig[j] && buf[idx] != rec.data[j]) {
                            throw new Exception("este patch é para outra versão do jogo (os dados não batem)");
                        }
                        buf[idx] = rec.data[j];
                    }
                }
                while (r < recs.size() && recs.get(r).off + recs.get(r).data.length <= chunkEnd) r++;
                os.write(buf, 0, n);
                pos = chunkEnd;
                if (total > 0) progress.update((double) pos / total);
            }
        }
        if (pos < last) throw new Exception("a imagem terminou antes do fim do patch");
        return pos;
    }

    private static int readFully(InputStream in, byte[] buf) throws Exception {
        int got = 0;
        while (got < buf.length) {
            int n = in.read(buf, got, buf.length - got);
            if (n < 0) break;
            got += n;
        }
        return got;
    }
}
