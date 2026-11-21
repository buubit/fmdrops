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

  // ---- mais endereços
  var DECK_LIMIT_SITE = 0x80033870;  // sltiu v0,v0,3: máximo de cópias da mesma carta no deck
  var TERRAIN_TABLE = 0x800909D4;    // s8[20][6] bônus de terreno por tipo (x10 no jogo)
  var COSTS = 0xFB9808;              // WA_MRG: [u32 custo, u32 senha] x 722
  var RITUALS = 0xB97800;            // WA_MRG: 24 x [ritual, sacrifício x3, resultado] (u16)
  var STATS = 0x1C4A44, LEVEL_ATTR = 0x1C5B33; // SLUS (offset de arquivo)
  var POOL_SITE = 0x30;              // dentro da rotina de drop: "sll a0,v0,1 / addiu a0,zero,1" escolhem a tabela
  var TERRAIN_LEVELS = { off: 0, normal: 50, forte: 100, max: 127 };
  var TYPES = ['Dragão', 'Mago', 'Zumbi', 'Guerreiro', 'Besta-Guerreira', 'Besta', 'Besta Alada', 'Demônio', 'Fada', 'Inseto',
    'Dinossauro', 'Réptil', 'Peixe', 'Serpente Marinha', 'Máquina', 'Trovão', 'Aqua', 'Pyro', 'Rocha', 'Planta',
    'Magia', 'Armadilha', 'Ritual', 'Equipamento'];
  var ATTRS = ['Luz', 'Trevas', 'Terra', 'Água', 'Fogo', 'Vento', 'Magia', 'Armadilha'];
  var STARTER_SETS = [0xF92BD6, 0xFBDBD6]; // deck inicial (2 cópias): 7 x [u16 sorteios][722 u16 pesos], passo 0x5B8
  var STARTER_STRIDE = 0x5B8;
  var ART = 0x169000, ART_STRIDE = 0x3800;  // registro de arte de cada carta no WA_MRG
  var DESC_PTR = 0x1B0A02, DESC_BASE = 0x1B11F4 - 0x9F4, NAME_PTR = 0x1C6002, NAME_BASE = 0x1C6800 - 0x6000;
  var STARS = ['—', 'Sol', 'Lua', 'Vênus', 'Mercúrio', 'Marte', 'Júpiter', 'Saturno', 'Urano', 'Plutão', 'Netuno'];

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
    ed.costs = await src.mrg.read(COSTS, CARDS * 8);
    ed.ritualBlock = await src.mrg.read(RITUALS, 24 * 10);
    var base = 0x1C6800 - 0x6000;
    ed.names = []; ed.duelistNames = [];
    for (var i = 0; i < CARDS; i++) ed.names.push(FM.text(slus, base + u16(slus, 0x1C6002 + i * 2)) || ('Carta ' + (i + 1)));
    for (i = 0; i < DUELISTS; i++) ed.duelistNames.push(FM.text(slus, base + u16(slus, 0x1C6652 + i * 2)) || ('Duelista ' + (i + 1)));
    // deck inicial
    ed.starterBlock = await src.mrg.read(STARTER_SETS[0] - 2, 7 * STARTER_STRIDE);
    var sb2 = await src.mrg.read(STARTER_SETS[1] - 2, 7 * STARTER_STRIDE);
    ed.starter = null;
    var groups = [], total = 0, ok = same(ed.starterBlock, sb2);
    for (i = 0; i < 7 && ok; i++) {
      var o = i * STARTER_STRIDE, cnt = u16(ed.starterBlock, o), sum = 0, cards = [];
      for (var c = 0; c < CARDS; c++) { var w = u16(ed.starterBlock, o + 2 + c * 2); if (w) { cards.push(c + 1); sum += w; } }
      if (sum !== 2048) ok = false;
      total += cnt; groups.push({ count: cnt, cards: cards });
    }
    if (ok && total === 40) ed.starter = groups;
    ed.rituals = [];
    for (i = 0; i < 24; i++) ed.rituals.push([0, 2, 4, 6, 8].map(function (k) { return u16(ed.ritualBlock, i * 10 + k); }));
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
    var dl = exeBytes(ed, DECK_LIMIT_SITE, 4), deckLimit = (dl[2] === 0x42 && dl[3] === 0x2C) ? u16(dl, 0) : null;
    var tt = exeBytes(ed, TERRAIN_TABLE, 120), terrain = null, mags = {};
    for (var i = 0; i < 120; i++) { var v = tt[i] > 127 ? tt[i] - 256 : tt[i]; if (v) mags[Math.abs(v)] = 1; }
    var mk = Object.keys(mags);
    if (mk.length === 1) terrain = +mk[0];
    var pool = null;
    if (drops > 1) {
      var r = exeBytes(ed, ROUTINE + POOL_SITE, 8);
      pool = hex(r) === '4020020001000424' ? 'rank' : (r[2] === 4 && r[3] === 0x24 && r[6] === 4 && r[7] === 0x24) ? ['pow', 'bcd', 'tec'][r[0]] || 'rank' : null;
    }
    return { drops: drops, starchips: starchips, lp: life, freeDuel: freeDuel, deckLimit: deckLimit, terrain: terrain, lang: descRegion(ed) ? 'en' : null,
      dropPool: drops != null ? (pool || 'rank') : null, exe: ed.src.slusName };
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

  function cardInfo(ed, id) {
    var p = u32(ed.slus, STATS + (id - 1) * 4), la = ed.slus[LEVEL_ATTR + id - 1];
    return { atk: (p & 0x1FF) * 10, def: ((p >>> 9) & 0x1FF) * 10, gs1: (p >>> 18) & 15, gs2: (p >>> 22) & 15,
      type: (p >>> 26) & 31, level: la & 15, attr: la >> 4 };
  }

  // ---- texto no formato do jogo
  var ENC = {};
  Object.keys(FM.CHARS).forEach(function (k) { if (!(FM.CHARS[k] in ENC)) ENC[FM.CHARS[k]] = +k; });
  function plain(t) { return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e\n]/g, ''); }
  function encodeText(t) {
    var out = [];
    plain(t).split('').forEach(function (ch) { if (ch === '\n') out.push(0xFE); else if (ch in ENC) out.push(ENC[ch]); });
    return out;
  }
  function strLen(buf, pos) { var n = 0; while (pos + n < buf.length && buf[pos + n] !== 0xFF) n++; return n; }
  function nameRoom(ed, id) { return strLen(ed.slus, NAME_BASE + u16(ed.slus, NAME_PTR + (id - 1) * 2)); }
  function descRoom(ed, id) { return strLen(ed.slus, DESC_BASE + u16(ed.slus, DESC_PTR + (id - 1) * 2)); }
  function descOf(ed, id) { return FM.text(ed.slus, DESC_BASE + u16(ed.slus, DESC_PTR + (id - 1) * 2)); }
  function writeText(ed, ptrTable, base, id, t) {
    var pos = base + u16(ed.slus, ptrTable + (id - 1) * 2), room = strLen(ed.slus, pos);
    var bytes = encodeText(t).slice(0, room);
    var buf = new Uint8Array(room + 1).fill(0xFF);
    buf.set(bytes, 0);
    ed.writes.push({ file: 'slus', off: pos, data: buf });
  }
  function b64(str) {
    if (typeof atob === 'function') { var bin = atob(str), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(str, 'base64'));
  }

  function wrapText(t, w) {
    var lines = [], cur = '';
    plain(t).split(/\s+/).filter(Boolean).forEach(function (word) {
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
    });
    if (cur) lines.push(cur);
    return lines.slice(0, 8).join('\n');
  }

  // Região das descrições: só reorganiza se for um bloco contínuo com as 722 em ordem.
  function descRegion(ed) {
    var starts = [], ends = [];
    for (var i = 0; i < CARDS; i++) { var p = DESC_BASE + u16(ed.slus, DESC_PTR + i * 2); starts.push(p); ends.push(p + strLen(ed.slus, p)); }
    for (i = 1; i < CARDS; i++) if (starts[i] !== ends[i - 1] + 1) return null;
    return { start: starts[0], end: ends[CARDS - 1] + 1 }; // [start, end)
  }

  // Reescreve todas as descrições (tradução + descrições das cartas próprias) no mesmo bloco.
  function repackDescriptions(ed, texts) {
    var reg = descRegion(ed);
    if (!reg) throw new Error('não deu para trocar o idioma nesta versão do jogo (o texto das cartas foi modificado)');
    var size = reg.end - reg.start, buf = new Uint8Array(size).fill(0xFF), pos = 0, ptrs = new Uint8Array(CARDS * 2);
    for (var i = 0; i < CARDS; i++) {
      var enc = encodeText(texts[i]);
      if (pos + enc.length + 1 > size) throw new Error('as descrições não couberam no espaço do jogo');
      buf.set(enc, pos);
      var rel = reg.start + pos - DESC_BASE;
      ptrs[i * 2] = rel & 255; ptrs[i * 2 + 1] = rel >> 8;
      pos += enc.length + 1;
    }
    ed.writes.push({ file: 'slus', off: reg.start, data: buf });
    ed.writes.push({ file: 'slus', off: DESC_PTR, data: ptrs });
  }

  // Carta personalizada: troca arte, miniatura, título desenhado, nome, descrição, atributos e drops de uma carta.
  function applyCustom(ed, cc, log) {
    var id = cc.slot | 0;
    if (!(id >= 1 && id <= CARDS)) return;
    var rec = ART + (id - 1) * ART_STRIDE;
    if (cc.art && cc.thumb) {
      var art = b64(cc.art), th = b64(cc.thumb);   // art: 9792 índices + 512 CLUT; thumb: 1280 + 128
      if (art.length === 0x2640 + 0x200 && th.length === 0x500 + 0x80) {
        ed.writes.push({ file: 'mrg', off: rec, data: art });
        ed.writes.push({ file: 'mrg', off: rec + 0x2AE0, data: th });
        ed.writes.push({ file: 'mrg', off: (id - 1) * 0x800, data: th }); // cópia da miniatura no setor da carta
      }
    }
    if (cc.title) { var tt = b64(cc.title); if (tt.length === 0x2A0) ed.writes.push({ file: 'mrg', off: rec + 0x2840, data: tt }); }
    if (cc.name) writeText(ed, NAME_PTR, NAME_BASE, id, cc.name);
    if (cc.desc != null && cc.desc !== '' && !ed.descRepacked) writeText(ed, DESC_PTR, DESC_BASE, id, cc.desc);
    (cc.drops || []).forEach(function (d) {
      if (d.duelist >= 1 && d.duelist <= DUELISTS && POOLS[d.pool] != null && d.rate > 0 && d.rate < 2048) setRate(ed, d.duelist, d.pool, id, d.rate | 0);
    });
    log.push('carta própria: ' + (cc.name || ('#' + id)));
  }

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Distribui 2048 entre as cartas escolhidas, proporcional aos pesos, nenhuma com 0.
  function normalize(cards, weights) {
    var tot = weights.reduce(function (a, b) { return a + b; }, 0), t = new Array(CARDS).fill(0), fr = [];
    cards.forEach(function (c, i) { var x = weights[i] * 2048 / tot; t[c - 1] = Math.max(1, Math.floor(x)); fr.push([c, x - Math.floor(x)]); });
    var sum = t.reduce(function (a, b) { return a + b; }, 0);
    fr.sort(function (a, b) { return b[1] - a[1]; });
    for (var k = 0; sum !== 2048; k++) {
      var c = fr[k % fr.length][0];
      if (sum < 2048) { t[c - 1]++; sum++; } else if (t[c - 1] > 1) { t[c - 1]--; sum--; }
    }
    return t;
  }

  // Randomizer: cada duelista ganha tabelas de drop sorteadas; toda carta cai de alguém.
  // Com decks: monta decks novos mantendo a força média de cada duelista (a progressão continua fazendo sentido).
  function randomize(ed, seed, decks) {
    var R = rng(seed), seen = new Uint8Array(CARDS + 1), st = cardStats(ed);
    function pick(n, pool) {
      var chosen = {}, out = [];
      while (out.length < n && out.length < pool.length) {
        var c = pool[Math.floor(R() * pool.length)];
        if (!chosen[c]) { chosen[c] = 1; out.push(c); }
      }
      return out;
    }
    var all = []; for (var i = 1; i <= CARDS; i++) all.push(i);
    for (var d = 1; d <= DUELISTS; d++) {
      ['pow', 'bcd', 'tec'].forEach(function (pool) {
        var cards = pick(30 + Math.floor(R() * 60), all);
        var w = cards.map(function () { return 1 + Math.floor(Math.pow(R(), 2) * 63); });
        cards.forEach(function (c) { seen[c] = 1; });
        setTable(ed, d, pool, normalize(cards, w));
      });
    }
    for (i = 1; i <= CARDS; i++) if (!seen[i]) {
      var dd = 1 + Math.floor(R() * DUELISTS), pp = ['pow', 'bcd', 'tec'][Math.floor(R() * 3)];
      setRate(ed, dd, pp, i, 8);
    }
    if (!decks) return;
    var monsters = all.filter(function (c) { return st[c - 1].monster && st[c - 1].atk > 0; });
    var others = all.filter(function (c) { return !st[c - 1].monster; });
    for (d = 1; d <= DUELISTS; d++) {
      var t = table(ed, d, 'deck'), mw = 0, ms = 0;
      t.forEach(function (v, i) { if (v && st[i].monster) { mw += v; ms += v * st[i].atk; } });
      var avg = mw ? ms / mw : 1200, near = [];
      for (var spread = 400; near.length < 40; spread += 300)
        near = monsters.filter(function (c) { return Math.abs(st[c - 1].atk - avg) <= spread; });
      var deckCards = pick(26 + Math.floor(R() * 10), near).concat(pick(8 + Math.floor(R() * 8), others));
      setTable(ed, d, 'deck', normalize(deckCards, deckCards.map(function () { return 1 + Math.floor(R() * 8); })));
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
    if (o.randomizer && o.randomizer.on) {
      randomize(ed, o.randomizer.seed >>> 0, !!o.randomizer.decks);
      log.push('Randomizer (semente ' + o.randomizer.seed + (o.randomizer.decks ? ', com decks' : '') + ')');
    }
    if (o.allDrops && !(o.randomizer && o.randomizer.on)) {
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
    // tabela de drop das cartas extras (rotina instalada)
    var finalDrops = o.drops != null && c.drops != null ? Math.max(1, o.drops | 0) : c.drops;
    if (finalDrops > 1 && o.dropPool && c.dropPool != null && (o.dropPool !== c.dropPool || (o.drops !== c.drops))) {
      var code = o.dropPool === 'rank' ? fromHex('4020020001000424') :
        (function (k) { return new Uint8Array([k, 0, 4, 0x24, k, 0, 4, 0x24]); })({ pow: 0, bcd: 1, tec: 2 }[o.dropPool]);
      writeExe(ed, ROUTINE + POOL_SITE, code);
      if (o.dropPool !== 'rank') log.push('cartas extras sempre de ' + { pow: 'S/A POW', bcd: 'B/C/D', tec: 'S/A TEC' }[o.dropPool]);
    }
    if (o.deckLimit != null && c.deckLimit != null && o.deckLimit !== c.deckLimit) {
      var dl = Math.max(1, Math.min(40, o.deckLimit | 0));
      writeExe(ed, DECK_LIMIT_SITE, new Uint8Array([dl, 0, 0x42, 0x2C]));
      log.push('até ' + dl + ' cópias por carta no deck');
    }
    if (o.terrain && c.terrain != null && TERRAIN_LEVELS[o.terrain] !== c.terrain) {
      var tt = exeBytes(ed, TERRAIN_TABLE, 120).slice(), lv = TERRAIN_LEVELS[o.terrain];
      // sem bônus nenhum não dá para voltar (o desenho da tabela some), então "off" só zera na cópia gerada
      for (var i = 0; i < 120; i++) { var v = tt[i] > 127 ? tt[i] - 256 : tt[i]; if (v) tt[i] = (v > 0 ? lv : 256 - lv) & 255; }
      if (c.terrain > 0) { writeExe(ed, TERRAIN_TABLE, tt); log.push('bônus de terreno ' + (lv * 10)); }
    }
    if ((o.priceDiv && o.priceDiv !== 1) || o.buyAll) {
      var costs = ed.costs.slice(), div = o.priceDiv || 1;
      for (i = 0; i < CARDS; i++) {
        var cost = u32(costs, i * 8), pw = u32(costs, i * 8 + 4);
        if (cost >= 999999) { if (!o.buyAll || pw === 0xFFFFFFFE) continue; cost = 99999; }
        cost = div === 'gratis' ? 1 : Math.max(1, Math.floor(cost / div));
        costs[i * 8] = cost & 255; costs[i * 8 + 1] = (cost >> 8) & 255; costs[i * 8 + 2] = (cost >> 16) & 255; costs[i * 8 + 3] = (cost >>> 24) & 255;
      }
      ed.writes.push({ file: 'mrg', off: COSTS, data: costs });
      log.push('preço das senhas ' + (div === 'gratis' ? '1 starchip' : (div === 1 ? 'normal' : '÷' + div)) + (o.buyAll ? ', proibidas à venda' : ''));
    }
    if (o.lang === 'pt') {
      var PT = (typeof window !== 'undefined' && window.FM_LANG_PT) || (typeof globalThis !== 'undefined' && globalThis.FM_LANG_PT);
      if (!PT || PT.length !== CARDS) throw new Error('tradução não carregada');
      var texts = PT.map(function (t) { return wrapText(t, 20); });
      (o.custom || []).forEach(function (cc) { if (cc && cc.slot && cc.desc) texts[cc.slot - 1] = wrapText(cc.desc, 20); });
      repackDescriptions(ed, texts);
      ed.descRepacked = true;
      log.push('descrições em português');
    }
    // cartas personalizadas: os atributos entram junto com as edições de carta
    var cardEdits = Object.assign({}, o.cards || {});
    (o.custom || []).forEach(function (cc) {
      if (!cc || !cc.slot) return;
      cardEdits[cc.slot] = { atk: cc.atk, def: cc.def, level: cc.level, type: cc.type, attr: cc.attr, gs1: cc.gs1, gs2: cc.gs2 };
      applyCustom(ed, cc, log);
    });
    if (o.starter && ed.starter) {
      var total = o.starter.reduce(function (a, g) { return a + (g.count | 0); }, 0);
      var valid = o.starter.length === 7 && total === 40 && o.starter.every(function (g) {
        return g.cards.length && g.cards.every(function (x) { return x >= 1 && x <= 720; });
      });
      if (!valid) throw new Error('deck inicial inválido: são 7 grupos, todos com cartas, somando 40 sorteios (cartas 721 e 722 não entram)');
      var blk = new Uint8Array(ed.starterBlock);
      o.starter.forEach(function (g, r) {
        var off = r * STARTER_STRIDE, t = normalize(g.cards, g.cards.map(function () { return 1; }));
        blk[off] = g.count & 255; blk[off + 1] = g.count >> 8;
        for (var c = 0; c < CARDS; c++) { blk[off + 2 + c * 2] = t[c] & 255; blk[off + 3 + c * 2] = t[c] >> 8; }
      });
      if (!same(blk, ed.starterBlock)) {
        STARTER_SETS.forEach(function (base) { ed.writes.push({ file: 'mrg', off: base - 2, data: blk }); });
        log.push('deck inicial personalizado');
      }
    }
    var nCards = 0;
    Object.keys(cardEdits).forEach(function (k) {
      var id = +k, e = cardEdits[k], cur = cardInfo(ed, id);
      var v = {}; ['atk', 'def', 'gs1', 'gs2', 'type', 'level', 'attr'].forEach(function (f) { v[f] = e[f] != null ? e[f] : cur[f]; });
      var packed = ((Math.min(5110, Math.max(0, v.atk)) / 10) & 0x1FF) | (((Math.min(5110, Math.max(0, v.def)) / 10) & 0x1FF) << 9) |
        ((v.gs1 & 15) << 18) | ((v.gs2 & 15) << 22) | ((v.type & 31) << 26);
      packed >>>= 0;
      ed.writes.push({ file: 'slus', off: STATS + (id - 1) * 4, data: new Uint8Array([packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, packed >>> 24]) });
      ed.writes.push({ file: 'slus', off: LEVEL_ATTR + id - 1, data: new Uint8Array([(v.level & 15) | ((v.attr & 15) << 4)]) });
      nCards++;
    });
    var nc = Object.keys(o.cards || {}).length; if (nc) log.push(nc + ' carta(s) editada(s)');
    var rb = ed.ritualBlock.slice(), nr = 0;
    Object.keys(o.rituals || {}).forEach(function (k) {
      var row = o.rituals[k];
      if (!row || row.length !== 5 || +k >= 24 || row.some(function (x) { return !(x >= 1 && x <= CARDS); })) return;
      row.forEach(function (x, j) { rb[+k * 10 + j * 2] = x & 255; rb[+k * 10 + j * 2 + 1] = x >> 8; });
      nr++;
    });
    if (nr && !same(rb, ed.ritualBlock)) { ed.writes.push({ file: 'mrg', off: RITUALS, data: rb }); log.push(nr + ' ritual(is) editado(s)'); }
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
    var recs = [], size = 60, secs = [];
    for (var n = 0; n < lbas.length; n++) {
      var lba = lbas[n], orig = await src.readRaw(lba, 1), sec = orig.slice();
      dirty[lba].forEach(function (p) { sec.set(p[1], src.dataOffset + p[0]); });
      fixSector(sec);
      secs.push([lba * SECTOR, sec]);
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
    return { ppf: out, sectors: lbas.length, secs: secs };
  }

  return { open: open, apply: apply, buildPatch: buildPatch, PRESETS: PRESETS, fixSector: fixSector, cardInfo: cardInfo,
    TYPES: TYPES, ATTRS: ATTRS, STARS: STARS, TERRAIN_LEVELS: TERRAIN_LEVELS,
    nameRoom: nameRoom, descRoom: descRoom, descOf: descOf, plain: plain, descRegion: descRegion };
});
