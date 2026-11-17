/*
 * Editor de mod dentro do app ("GameShark"): calcula as alterações na imagem .bin
 * e devolve um patch PPF3 (com bytes originais), que a casca Android aplica
 * gravando um .bin novo. Mesma lógica do tools/fmmod.py.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fm.js'));
  else root.FMMod = factory(root.FM);
})(typeof self !== 'undefined' ? self : this, function (FM) {
  'use strict';

  var CARDS = 722, DUELISTS = 39, SECTOR = 2352;
  var DUELIST_BASE = 0xE9B000, DUELIST_STRIDE = 0x1800;
  var POOLS = { deck: 0x0, pow: 0x5B4, bcd: 0xB68, tec: 0x111C };

  // ---- endereços no executável (RAM) e o que se espera encontrar neles
  var CALL_SITE = 0x80021F14, AWARD = 0x80021894, ROUTINE = 0x80060E70;
  var ROUTINE_RETAIL_HEAD = 'c0ffbd272400b3af219880003400b7af';
  var ROUTINE_CODE = 'e8ffbd271400bfaf1000b0af2586000c{N}1024e002838f0000000039006290380063902b1002000300632c' +
    '0200601040200200010004240486000c0000000003004010000000002586000c25204000ffff1026efff0016' +
    '000000001400bf8f1000b08f0800e0031800bd27';
  var STARCHIPS_SITE = 0x80021EDC;   // nop no original; addiu v1,v1,N soma N starchips por duelo
  var LP_SITE = 0x800175D0;          // addiu v0,zero,8000: vida inicial dos dois jogadores
  // Menu do Free Duel (módulo em WA_MRG.MRG): marca os 39 duelistas como liberados e apaga a marca
  // de quem não tem a flag 0x6E0+id. Trocar o "apagar" (sb zero,(v0)) por nop libera todos.
  var FREE_DUEL_SITE = 0xF6D3DC, FREE_DUEL_LOCK = [0x00, 0x00, 0x40, 0xA0];

  // Cartas que ninguém dropa no original -> [carta, duelista, duelista, chance/2048] (S/A POW e S/A TEC)
  var ALL_DROPS = [[7,1,6,24],[17,1,13,24],[18,1,13,24],[22,14,27,10],[28,2,7,24],[37,15,35,10],[51,9,25,16],[52,10,23,16],[56,10,23,24],[57,10,24,10],[60,21,22,16],[62,11,29,24],[63,11,30,16],[64,3,9,24],[67,10,38,10],[69,9,28,10],[72,10,23,24],[92,18,25,16],[217,39,36,10],[235,4,10,24],[252,5,11,24],[278,10,23,24],[284,6,12,24],[288,7,1,24],[299,9,2,24],[318,22,32,10],[348,24,33,10],[351,10,3,24],[352,11,4,24],[353,19,27,16],[354,12,5,24],[355,20,29,16],[356,26,34,10],[357,28,35,10],[358,30,36,10],[359,1,6,24],[360,32,37,10],[361,2,7,24],[362,33,38,10],[363,3,9,24],[364,39,38,10],[365,34,39,10],[369,21,31,16],[374,33,34,10],[380,36,17,10],[428,4,10,24],[429,5,11,24],[489,6,12,24],[499,10,23,24],[537,7,1,24],[541,9,2,24],[545,23,13,16],[554,25,26,16],[555,25,14,16],[562,10,23,24],[603,29,20,24],[628,10,3,24],[640,10,23,24],[644,11,4,24],[667,33,34,10],[669,35,15,10],[670,39,38,10],[689,36,17,10],[696,10,24,10],[701,37,22,10],[702,38,24,10],[703,25,26,10],[704,27,28,10],[705,39,26,10],[706,15,28,10],[708,29,30,10],[709,17,30,10],[710,21,22,10],[711,27,16,16],[715,22,32,10],[716,24,33,10],[717,10,24,10],[718,21,22,10],[719,26,34,10],[720,28,35,10],[721,16,37,10],[722,16,37,10]];
  var MEGAMORPH = 657;
  var MEGAMORPH_POW = [[15, 64], [37, 48], [35, 24], [8, 16]]; // Pegasus, DarkNite, Heishin 2nd, Heishin

  var DIFFICULTY = { facil: -1, normal: 0, dificil: 2, muito: 3 };

  var PRESETS = {
    original: { freeDuel: false, drops: 1, starchips: 0, lp: 8000, allDrops: false, megamorph: false, difficulty: 'normal' },
    drop100: { freeDuel: true, drops: 100, starchips: 0, lp: 8000, allDrops: true, megamorph: true, difficulty: 'normal' },
    facil: { freeDuel: true, drops: 100, starchips: 500, lp: 9999, allDrops: true, megamorph: true, difficulty: 'facil' },
    desafio: { freeDuel: true, drops: 15, starchips: 0, lp: 8000, allDrops: true, megamorph: true, difficulty: 'dificil' }
  };

  // ---- EDC / ECC (CD-ROM Mode 2 Form 1)
  var EDC_LUT = new Uint32Array(256), ECC_F = new Uint8Array(256), ECC_B = new Uint8Array(256);
  (function () {
    for (var i = 0; i < 256; i++) {
      var e = i;
      for (var k = 0; k < 8; k++) e = (e >>> 1) ^ (e & 1 ? 0xD8018001 : 0);
      EDC_LUT[i] = e >>> 0;
      var f = ((i << 1) ^ (i & 0x80 ? 0x11D : 0)) & 0xFF;
      ECC_F[i] = f;
      ECC_B[i ^ f] = i;
    }
  })();

  function edc(buf, start, end) {
    var e = 0;
    for (var i = start; i < end; i++) e = (e >>> 8) ^ EDC_LUT[(e ^ buf[i]) & 0xFF];
    return e >>> 0;
  }

  function eccBlock(src, majorCount, minorCount, majorMult, minorInc, dest, destOff) {
    var size = majorCount * minorCount;
    for (var major = 0; major < majorCount; major++) {
      var index = (major >> 1) * majorMult + (major & 1), a = 0, b = 0;
      for (var minor = 0; minor < minorCount; minor++) {
        var t = src[index];
        index += minorInc;
        if (index >= size) index -= size;
        a ^= t; b ^= t; a = ECC_F[a];
      }
      a = ECC_B[ECC_F[a] ^ b];
      dest[destOff + major] = a;
      dest[destOff + major + majorCount] = a ^ b;
    }
  }

  function fixSector(sec) {
    if (sec[15] !== 2 || (sec[18] & 0x20)) return; // só Mode 2 Form 1
    var e = edc(sec, 0x10, 0x818);
    sec[0x818] = e & 255; sec[0x819] = (e >>> 8) & 255; sec[0x81A] = (e >>> 16) & 255; sec[0x81B] = (e >>> 24) & 255;
    var src = new Uint8Array(4 + 0x8C8 - 0x10);
    src.set(sec.subarray(0x10, 0x8C8), 4);           // endereço zerado no Mode 2
    var p = new Uint8Array(172);
    eccBlock(src, 86, 24, 2, 86, p, 0);
    sec.set(p, 0x81C);
    src.set(p, 4 + 0x81C - 0x10);
    eccBlock(src, 52, 43, 86, 88, sec, 0x8C8);
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2); return s; }
  function fromHex(h) { var o = new Uint8Array(h.length / 2); for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
  function jal(addr) { var v = (0x0C000000 | ((addr >>> 2) & 0x3FFFFFF)) >>> 0; return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]); }
  function same(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  /* ---------- sessão de edição sobre uma imagem ---------- */

  async function open(blob) {
    var src = await FM.openImage(blob);
    if (!src.raw) throw new Error('O editor precisa da imagem .bin (2352 bytes por setor), não de .iso.');
    var slus = await src.slus.read(0, src.slus.size);
    var tAddr = u32(slus, 0x18);
    var ed = {
      src: src, slus: slus, tAddr: tAddr, writes: [],
      tables: {}, exeOff: function (ram) { return ram - tAddr + 0x800; }
    };
    // tabelas dos duelistas (39 x 0x1800)
    ed.duelBlock = await src.mrg.read(DUELIST_BASE, DUELISTS * DUELIST_STRIDE);
    ed.duelBlockOrig = ed.duelBlock.slice();
    ed.freeDuel = await src.mrg.read(FREE_DUEL_SITE, 4);
    ed.caps = capabilities(ed);
    return ed;
  }

  function exeBytes(ed, ram, n) { var o = ed.exeOff(ram); return ed.slus.subarray(o, o + n); }

  function capabilities(ed) {
    var call = exeBytes(ed, CALL_SITE, 4), head = exeBytes(ed, ROUTINE, 16), routine = exeBytes(ed, ROUTINE, 108);
    var tmpl = fromHex(ROUTINE_CODE.replace('{N}', '0000'));
    var installed = same(call, jal(ROUTINE)) || (same(call, jal(AWARD)) && same(routine.subarray(20), tmpl.subarray(20)) && same(routine.subarray(0, 16), tmpl.subarray(0, 16)));
    var drops = null;
    if (same(call, jal(AWARD)) && hex(head) === ROUTINE_RETAIL_HEAD) drops = 1;
    else if (installed) drops = same(call, jal(ROUTINE)) ? u16(routine, 16) + 1 : 1;
    var sc = exeBytes(ed, STARCHIPS_SITE, 4), starchips = null;
    if (u32(sc, 0) === 0) starchips = 0;
    else if (sc[2] === 0x63 && sc[3] === 0x24) starchips = u16(sc, 0);
    var lp = exeBytes(ed, LP_SITE, 4), life = (lp[2] === 0x02 && lp[3] === 0x24) ? u16(lp, 0) : null;
    var fd = ed.freeDuel, freeDuel = null;
    if (same(fd, new Uint8Array(FREE_DUEL_LOCK))) freeDuel = false;
    else if (u32(fd, 0) === 0) freeDuel = true;
    return { drops: drops, starchips: starchips, lp: life, freeDuel: freeDuel, exe: ed.src.slusName };
  }

  function writeExe(ed, ram, bytes) { ed.writes.push({ file: 'slus', off: ed.exeOff(ram), data: bytes }); }

  function table(ed, d, pool) {
    var base = (d - 1) * DUELIST_STRIDE + POOLS[pool], t = new Array(CARDS);
    for (var i = 0; i < CARDS; i++) t[i] = u16(ed.duelBlock, base + i * 2);
    return t;
  }
  function setTable(ed, d, pool, t) {
    var sum = t.reduce(function (a, b) { return a + b; }, 0);
    if (sum !== 2048) throw new Error('tabela somaria ' + sum);
    var base = (d - 1) * DUELIST_STRIDE + POOLS[pool];
    for (var i = 0; i < CARDS; i++) { ed.duelBlock[base + i * 2] = t[i] & 255; ed.duelBlock[base + i * 2 + 1] = t[i] >> 8; }
  }

  // Mesmo algoritmo do fmmod.py: a carta recebe `rate` e o resto é reescalado para fechar 2048.
  function setRate(ed, d, pool, card, rate) {
    var t = table(ed, d, pool), total = 2048, others = total - t[card - 1], target = total - rate;
    var nw = new Array(CARDS).fill(0);
    nw[card - 1] = rate;
    var idx = [], exact = {}, i;
    for (i = 0; i < CARDS; i++) if (i !== card - 1 && t[i]) idx.push(i);
    var keepOne = target >= idx.length;
    idx.forEach(function (i) {
      exact[i] = t[i] * target / others;
      nw[i] = keepOne ? Math.max(1, Math.floor(exact[i])) : Math.floor(exact[i]);
    });
    var diff = target - idx.reduce(function (a, i) { return a + nw[i]; }, 0);
    var order = idx.slice().sort(function (a, b) {
      var fa = exact[a] - Math.floor(exact[a]), fb = exact[b] - Math.floor(exact[b]);
      return diff > 0 ? fb - fa : fa - fb;
    });
    // desempate estável igual ao sorted() do Python
    order = stableSort(idx, function (a, b) {
      var fa = exact[a] - Math.floor(exact[a]), fb = exact[b] - Math.floor(exact[b]);
      return diff > 0 ? (fb - fa) : (fa - fb);
    });
    var k = 0, min = keepOne ? 1 : 0;
    while (diff !== 0 && order.length) {
      var j = order[k % order.length], step = diff > 0 ? 1 : -1;
      if (nw[j] + step >= min) { nw[j] += step; diff -= step; }
      k++;
    }
    setTable(ed, d, pool, nw);
  }
  function stableSort(arr, cmp) {
    return arr.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return cmp(a[0], b[0]) || a[1] - b[1]; })
      .map(function (x) { return x[0]; });
  }

  function cardStats(ed) {
    var out = [];
    for (var i = 0; i < CARDS; i++) {
      var p = u32(ed.slus, 0x1C4A44 + i * 4);
      out.push({ atk: (p & 0x1FF) * 10, monster: ((p >>> 26) & 0x1F) < 20 });
    }
    return out;
  }

  function scaleDecks(ed, n) {
    var st = cardStats(ed);
    for (var d = 1; d <= DUELISTS; d++) {
      var t = table(ed, d, 'deck');
      var w = t.map(function (v, i) { return v * (st[i].monster ? Math.pow(Math.max(st[i].atk, 100) / 1000, n) : 1); });
      var tot = w.reduce(function (a, b) { return a + b; }, 0);
      var nw = t.map(function (v, i) { return v ? Math.max(1, Math.floor(w[i] * 2048 / tot)) : 0; });
      var order = stableSort(t.map(function (v, i) { return i; }).filter(function (i) { return t[i]; }), function (a, b) { return w[b] - w[a]; });
      var k = 0, sum = nw.reduce(function (a, b) { return a + b; }, 0);
      while (sum !== 2048) {
        var i = order[k % order.length];
        if (sum < 2048) { nw[i]++; sum++; } else if (nw[i] > 1) { nw[i]--; sum--; }
        k++;
      }
      setTable(ed, d, 'deck', nw);
    }
  }

  /* ---------- aplicar opções ---------- */

  function apply(ed, o) {
    var c = ed.caps, log = [];
    if (o.drops != null && c.drops != null && o.drops !== c.drops) {
      var n = Math.max(1, Math.min(999, o.drops | 0));
      if (n === 1) {
        writeExe(ed, CALL_SITE, jal(AWARD));
      } else {
        var code = fromHex(ROUTINE_CODE.replace('{N}', hex(new Uint8Array([(n - 1) & 255, (n - 1) >> 8]))));
        writeExe(ed, ROUTINE, code);
        writeExe(ed, CALL_SITE, jal(ROUTINE));
      }
      log.push(n + ' carta(s) por duelo');
    }
    if (o.starchips != null && c.starchips != null && o.starchips !== c.starchips) {
      var s = Math.max(0, Math.min(30000, o.starchips | 0));
      writeExe(ed, STARCHIPS_SITE, s ? new Uint8Array([s & 255, s >> 8, 0x63, 0x24]) : new Uint8Array(4));
      log.push('+' + s + ' starchips por duelo');
    }
    if (o.lp != null && c.lp != null && o.lp !== c.lp) {
      var l = Math.max(100, Math.min(9999, o.lp | 0));
      writeExe(ed, LP_SITE, new Uint8Array([l & 255, l >> 8, 0x02, 0x24]));
      log.push('vida inicial ' + l);
    }
    if (o.allDrops) {
      ALL_DROPS.forEach(function (r) {
        [r[1], r[2]].forEach(function (d) {
          ['pow', 'tec'].forEach(function (pool) { if (table(ed, d, pool)[r[0] - 1] < r[3]) setRate(ed, d, pool, r[0], r[3]); });
        });
      });
      log.push('todas as cartas dropáveis');
    }
    if (o.megamorph) {
      MEGAMORPH_POW.forEach(function (m) { if (table(ed, m[0], 'pow')[MEGAMORPH - 1] < m[1]) setRate(ed, m[0], 'pow', MEGAMORPH, m[1]); });
      log.push('Megamorph em S/A POW');
    }
    if (o.freeDuel != null && c.freeDuel != null && !!o.freeDuel !== c.freeDuel) {
      ed.writes.push({ file: 'mrg', off: FREE_DUEL_SITE, data: o.freeDuel ? new Uint8Array(4) : new Uint8Array(FREE_DUEL_LOCK) });
      log.push(o.freeDuel ? 'todos os duelistas no Free Duel' : 'Free Duel normal');
    }
    var ex = DIFFICULTY[o.difficulty || 'normal'];
    if (ex) { scaleDecks(ed, ex); log.push('decks: ' + o.difficulty); }
    if (!same(ed.duelBlock, ed.duelBlockOrig)) ed.writes.push({ file: 'mrg', off: DUELIST_BASE, data: ed.duelBlock });
    return log;
  }

  /* ---------- gerar o patch (setores inteiros, EDC/ECC recalculado) ---------- */

  async function buildPatch(ed, onProgress) {
    var src = ed.src, dirty = {};
    function touch(file, off, data) {
      var f = file === 'slus' ? src.slusFile : src.mrgFile;
      for (var i = 0; i < data.length;) {
        var lba = f.lba + Math.floor((off + i) / 2048), o = (off + i) % 2048, k = Math.min(data.length - i, 2048 - o);
        (dirty[lba] || (dirty[lba] = [])).push([o, data.subarray(i, i + k)]);
        i += k;
      }
    }
    ed.writes.forEach(function (w) { touch(w.file, w.off, w.data); });
    var lbas = Object.keys(dirty).map(Number).sort(function (a, b) { return a - b; });
    var recs = [], size = 60;
    for (var n = 0; n < lbas.length; n++) {
      var lba = lbas[n], orig = await src.readRaw(lba, 1), sec = orig.slice();
      dirty[lba].forEach(function (p) { sec.set(p[1], src.dataOffset + p[0]); });
      fixSector(sec);
      // registros só onde mudou (até 255 bytes cada), com os bytes originais (undo)
      for (var i = 0; i < SECTOR;) {
        if (sec[i] === orig[i]) { i++; continue; }
        var j = i;
        while (j < SECTOR && j - i < 255 && sec[j] !== orig[j]) j++;
        recs.push([lba * SECTOR + i, sec.slice(i, j), orig.slice(i, j)]);
        size += 9 + 2 * (j - i);
        i = j;
      }
      if (onProgress) onProgress((n + 1) / lbas.length);
    }
    var out = new Uint8Array(size), head = 'PPF30';
    for (var h = 0; h < 5; h++) out[h] = head.charCodeAt(h);
    out[5] = 2;
    var desc = 'FM Drops mod';
    for (h = 0; h < 50; h++) out[6 + h] = h < desc.length ? desc.charCodeAt(h) : 32;
    out[56] = 0; out[57] = 0; out[58] = 1; out[59] = 0;
    var p = 60;
    recs.forEach(function (r) {
      var off = r[0];
      for (var b = 0; b < 8; b++) { out[p + b] = off % 256; off = Math.floor(off / 256); }
      out[p + 8] = r[1].length;
      out.set(r[1], p + 9);
      out.set(r[2], p + 9 + r[1].length);
      p += 9 + 2 * r[1].length;
    });
    return { ppf: out, sectors: lbas.length };
  }

  return { open: open, apply: apply, buildPatch: buildPatch, PRESETS: PRESETS, fixSector: fixSector };
});
