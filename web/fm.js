/*
 * Leitor dos dados do Yu-Gi-Oh! Forbidden Memories (SLUS-01411, versão USA).
 * Funciona no navegador (global FM) e no Node (module.exports).
 *
 * Offsets conforme o projeto aberto fmlib-cpp (MIT, Forbidden Memories Coding).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CARDS = 722;
  var DUELISTS = 39;
  var IMG_W = 102, IMG_H = 96;

  var OFF = {
    slusStats: 0x1C4A44,
    slusLevelAttr: 0x1C5B33,
    slusCardNamePtr: 0x1C6002,
    slusDuelistNamePtr: 0x1C6652,
    slusTextBase: 0x1C6800 - 0x6000,
    slusDescPtr: 0x1B0A02,
    slusDescBase: 0x1B11F4 - 0x9F4,
    mrgImages: 0x169000,
    mrgImageStride: 0x3800,
    mrgDuelists: 0xE9B000,
    mrgDuelistStride: 0x1800,
    mrgDeck: 0x0,
    mrgSaPow: 0x5B4,
    mrgBcd: 0xB68,
    mrgSaTec: 0x111C,
    mrgCosts: 0xFB9808,
    mrgFusions: 0xB87800,
    mrgFusionsSize: 0x10000,
    mrgRituals: 0xB97800,
    mrgRitualsSize: 0x800
  };

  var TYPES = ['Dragão', 'Mago', 'Zumbi', 'Guerreiro', 'Besta-Guerreira', 'Besta',
    'Besta Alada', 'Demônio', 'Fada', 'Inseto', 'Dinossauro', 'Réptil', 'Peixe',
    'Serpente Marinha', 'Máquina', 'Trovão', 'Aqua', 'Pyro', 'Rocha', 'Planta',
    'Magia', 'Armadilha', 'Ritual', 'Equipamento'];

  var CHARS = {
    0x18: 'A', 0x2D: 'B', 0x2B: 'C', 0x20: 'D', 0x25: 'E', 0x31: 'F',
    0x29: 'G', 0x23: 'H', 0x1A: 'I', 0x3B: 'J', 0x33: 'K', 0x2A: 'L',
    0x1E: 'M', 0x2C: 'N', 0x21: 'O', 0x2F: 'P', 0x3E: 'Q', 0x26: 'R',
    0x1D: 'S', 0x1C: 'T', 0x35: 'U', 0x39: 'V', 0x22: 'W', 0x46: 'X',
    0x24: 'Y', 0x3F: 'Z', 0x03: 'a', 0x15: 'b', 0x0F: 'c', 0x0C: 'd',
    0x01: 'e', 0x13: 'f', 0x10: 'g', 0x09: 'h', 0x05: 'i', 0x34: 'j',
    0x16: 'k', 0x0A: 'l', 0x0E: 'm', 0x06: 'n', 0x04: 'o', 0x14: 'p',
    0x37: 'q', 0x08: 'r', 0x07: 's', 0x02: 't', 0x0D: 'u', 0x19: 'v',
    0x12: 'w', 0x36: 'x', 0x11: 'y', 0x32: 'z', 0x38: '0', 0x3D: '1',
    0x3A: '2', 0x41: '3', 0x4A: '4', 0x42: '5', 0x4E: '6', 0x45: '7',
    0x57: '8', 0x59: '9', 0x00: ' ', 0x30: '-', 0x3C: '#', 0x43: '&',
    0x0B: '.', 0x1F: ',', 0x17: '!', 0x1B: "'", 0x27: '<', 0x28: '>',
    0x2E: '?', 0x44: '/', 0x48: ':', 0x4B: ')', 0x4C: '(', 0x4F: '$',
    0x50: '*', 0x51: '>', 0x54: '<', 0x40: '"', 0x56: '+', 0x5B: '%'
  };

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function text(buf, pos) {
    var s = '';
    for (var n = 0; pos < buf.length && n < 2000; pos++, n++) {
      var c = buf[pos];
      if (c === 0xFF) break;
      if (c === 0xFE) { s += '\n'; continue; }
      if (c === 0xF8) { pos += 2; continue; } // código de cor/controle + 2 argumentos
      s += CHARS[c] !== undefined ? CHARS[c] : '';
    }
    return s.trim();
  }

  /* ---------- acesso aos arquivos ---------- */

  // "blob" = objeto com .size e .read(inicio, fim) -> Promise<Uint8Array>
  function fromFile(file) {
    return {
      size: file.size, name: file.name,
      read: function (a, b) {
        return file.slice(a, b).arrayBuffer().then(function (x) { return new Uint8Array(x); });
      }
    };
  }

  function wholeFileReader(blob) {
    return { size: blob.size, read: function (off, len) { return blob.read(off, off + len); } };
  }

  var SYNC = [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0];

  // Abre uma imagem de CD (.bin 2352 bytes/setor ou .iso 2048) e localiza os dois arquivos.
  async function openImage(blob) {
    var head = await blob.read(0, 16);
    var raw = SYNC.every(function (v, i) { return head[i] === v; });
    var secSize = raw ? 2352 : 2048;
    var dataOff = raw ? (head[15] === 2 ? 24 : 16) : 0;

    async function sectors(lba, count) {
      var phys = await blob.read(lba * secSize, (lba + count) * secSize);
      if (!raw) return phys;
      var out = new Uint8Array(count * 2048);
      for (var i = 0; i < count; i++) {
        var s = i * secSize + dataOff;
        out.set(phys.subarray(s, s + 2048), i * 2048);
      }
      return out;
    }

    var pvd = await sectors(16, 1);
    if (String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]) !== 'CD001') {
      throw new Error('Não parece uma imagem de CD válida (.bin ou .iso).');
    }

    var all = [];
    async function walk(lba, size, depth, path) {
      var dir = await sectors(lba, Math.ceil(size / 2048));
      var p = 0;
      while (p < size && p < dir.length) {
        var len = dir[p];
        if (len === 0) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
        var ext = u32(dir, p + 2), sz = u32(dir, p + 10), flags = dir[p + 25];
        var nlen = dir[p + 32], name = '';
        for (var i = 0; i < nlen; i++) name += String.fromCharCode(dir[p + 33 + i]);
        name = name.replace(/;\d+$/, '').toUpperCase();
        if (flags & 2) {
          if (name.length > 1 && depth < 4 && ext !== lba) await walk(ext, sz, depth + 1, path + name + '/');
        } else {
          all.push({ lba: ext, size: sz, name: name, path: path + name });
        }
        p += len;
      }
    }
    await walk(u32(pvd, 156 + 2), u32(pvd, 156 + 10), 0, '');

    function pick(test) { return all.filter(test).sort(function (x, y) { return y.size - x.size; })[0]; }
    var found = {};
    // Executável: o que o SYSTEM.CNF manda dar boot; senão, o nome padrão SLUS_xxx.xx.
    var cnf = pick(function (f) { return f.name === 'SYSTEM.CNF'; });
    if (cnf) {
      var raw0 = await sectors(cnf.lba, 1), txt = '';
      for (var c = 0; c < Math.min(cnf.size, 2048); c++) txt += String.fromCharCode(raw0[c]);
      var m = /BOOT\s*=\s*cdrom:\\*([^;\s]+)/i.exec(txt);
      if (m) {
        var boot = m[1].toUpperCase().split('\\').pop();
        found.slus = pick(function (f) { return f.name === boot; });
      }
    }
    if (!found.slus) found.slus = pick(function (f) { return /^S[LC][UEP][SM]_\d{3}\.\d{2}$/.test(f.name); });
    // Dados: WA_MRG.MRG; senão qualquer .MRG; senão o maior arquivo grande o bastante.
    found.mrg = pick(function (f) { return f.name === 'WA_MRG.MRG'; }) ||
      pick(function (f) { return /\.MRG$/.test(f.name); }) ||
      pick(function (f) { return f.size >= OFF.mrgCosts + CARDS * 8 && f !== found.slus; });
    if (!found.slus || !found.mrg) {
      throw new Error('Não achei ' + (!found.slus ? 'o executável (SLUS_014.11) ' : '') +
        (!found.mrg ? 'o WA_MRG.MRG ' : '') + 'dentro da imagem. Arquivos encontrados (' + all.length + '): ' +
        all.slice(0, 40).map(function (f) { return f.path + ' ' + Math.round(f.size / 1024) + 'KB'; }).join(', '));
    }

    function fileReader(f) {
      return {
        size: f.size, name: f.name,
        read: async function (off, len) {
          var out = new Uint8Array(len), done = 0;
          while (done < len) {
            var o = off + done;
            var first = Math.floor(o / 2048);
            var n = Math.min(Math.ceil((o % 2048 + (len - done)) / 2048), 1024);
            var data = await sectors(f.lba + first, n);
            var chunk = data.subarray(o % 2048, Math.min(data.length, o % 2048 + (len - done)));
            out.set(chunk, done);
            done += chunk.length;
          }
          return out;
        }
      };
    }
    return { slus: fileReader(found.slus), mrg: fileReader(found.mrg), slusName: found.slus.name };
  }

  // Aceita: 1 imagem de CD, ou os 2 arquivos soltos (SLUS_014.11 + WA_MRG.MRG).
  async function open(blobs) {
    if (blobs.length === 1) return openImage(blobs[0]);
    var mrg = null, slus = null;
    blobs.forEach(function (b) {
      if (/MRG/i.test(b.name || '') || b.size > 8 * 1024 * 1024) mrg = b; else slus = b;
    });
    if (!mrg || !slus) throw new Error('Selecione a imagem .bin/.iso, ou os arquivos SLUS_014.11 e WA_MRG.MRG.');
    return { slus: wholeFileReader(slus), mrg: wholeFileReader(mrg), slusName: slus.name };
  }

  /* ---------- leitura dos dados ---------- */

  async function parse(src, onProgress) {
    var progress = onProgress || function () {};
    var slus = await src.slus.read(0, src.slus.size);
    if (slus.length < 0x1C6800) throw new Error('Executável do jogo menor que o esperado; versão não suportada.');

    var cards = [];
    for (var i = 0; i < CARDS; i++) {
      var packed = u32(slus, OFF.slusStats + i * 4);
      var la = slus[OFF.slusLevelAttr + i];
      var type = (packed >>> 26) & 0x1F;
      cards.push({
        id: i + 1,
        name: text(slus, OFF.slusTextBase + u16(slus, OFF.slusCardNamePtr + i * 2)) || ('Carta ' + (i + 1)),
        desc: text(slus, OFF.slusDescBase + u16(slus, OFF.slusDescPtr + i * 2)),
        atk: (packed & 0x1FF) * 10,
        def: ((packed >>> 9) & 0x1FF) * 10,
        type: type,
        typeName: TYPES[type] || '?',
        monster: type < 20,
        level: la & 0xF
      });
    }

    var costs = await src.mrg.read(OFF.mrgCosts, CARDS * 8);
    for (i = 0; i < CARDS; i++) {
      cards[i].cost = u32(costs, i * 8);
      var pw = u32(costs, i * 8 + 4);
      cards[i].password = pw === 0xFFFFFFFE ? '' : ('00000000' + pw.toString(16)).slice(-8);
    }
    progress(0.05);

    var block = await src.mrg.read(OFF.mrgDuelists, DUELISTS * OFF.mrgDuelistStride);
    var duelists = [];
    function table(base) {
      var list = [];
      for (var c = 0; c < CARDS; c++) {
        var r = u16(block, base + c * 2);
        if (r) list.push([c + 1, r]);
      }
      list.sort(function (a, b) { return b[1] - a[1] || a[0] - b[0]; });
      return list;
    }
    for (var d = 0; d < DUELISTS; d++) {
      var base = d * OFF.mrgDuelistStride;
      duelists.push({
        id: d + 1,
        name: text(slus, OFF.slusTextBase + u16(slus, OFF.slusDuelistNamePtr + d * 2)) || ('Duelista ' + (d + 1)),
        deck: table(base + OFF.mrgDeck),
        pow: table(base + OFF.mrgSaPow),
        bcd: table(base + OFF.mrgBcd),
        tec: table(base + OFF.mrgSaTec)
      });
    }
    // Fusões: tabela indexada pela carta de menor número; cada bloco de 5 bytes guarda 2 fusões.
    var fz = await src.mrg.read(OFF.mrgFusions, OFF.mrgFusionsSize), fusions = [];
    for (i = 0; i < CARDS; i++) {
      var fp = u16(fz, 2 + i * 2);
      if (!fp) continue;
      var left = fz[fp++];
      if (left === 0) left = 511 - fz[fp++];
      while (left > 0 && fp + 5 <= fz.length) {
        var ctl = fz[fp], b1 = fz[fp + 1], r1 = fz[fp + 2], b2 = fz[fp + 3], r2 = fz[fp + 4];
        fp += 5;
        var m1 = (ctl & 3) << 8 | b1, o1 = (ctl >> 2 & 3) << 8 | r1;
        if (m1 >= 1 && m1 <= CARDS && o1 >= 1 && o1 <= CARDS) fusions.push([i + 1, m1, o1]);
        if (--left <= 0) break;
        var m2 = (ctl >> 4 & 3) << 8 | b2, o2 = (ctl >> 6 & 3) << 8 | r2;
        if (m2 >= 1 && m2 <= CARDS && o2 >= 1 && o2 <= CARDS) fusions.push([i + 1, m2, o2]);
        left--;
      }
    }
    // Rituais: registros de 5 x u16 (carta de ritual, 3 sacrifícios, resultado), terminados por 0.
    var rz = await src.mrg.read(OFF.mrgRituals, OFF.mrgRitualsSize), rituals = [];
    for (var rp = 0; rp + 10 <= rz.length && u16(rz, rp); rp += 10) {
      var rec = [u16(rz, rp), u16(rz, rp + 2), u16(rz, rp + 4), u16(rz, rp + 6), u16(rz, rp + 8)];
      if (rec.every(function (v) { return v >= 1 && v <= CARDS; })) rituals.push(rec);
    }
    progress(0.1);

    // Artes: 102x96 em 8 bits + paleta de 256 cores (BGR555), viram um atlas RGBA.
    var cols = 27, rows = Math.ceil(CARDS / cols);
    var atlas = { width: cols * IMG_W, height: rows * IMG_H, cols: cols, rows: rows, cellW: IMG_W, cellH: IMG_H };
    var rgba = new Uint8Array(atlas.width * atlas.height * 4);
    var batch = 32, pix = IMG_W * IMG_H;
    for (var start = 0; start < CARDS; start += batch) {
      var n = Math.min(batch, CARDS - start);
      var data = await src.mrg.read(OFF.mrgImages + start * OFF.mrgImageStride, n * OFF.mrgImageStride);
      for (var k = 0; k < n; k++) {
        var o = k * OFF.mrgImageStride, card = start + k;
        var cx = (card % cols) * IMG_W, cy = Math.floor(card / cols) * IMG_H;
        for (var y = 0; y < IMG_H; y++) {
          var dst = ((cy + y) * atlas.width + cx) * 4;
          for (var x = 0; x < IMG_W; x++, dst += 4) {
            var col = u16(data, o + pix + data[o + y * IMG_W + x] * 2);
            rgba[dst] = (col & 31) << 3;
            rgba[dst + 1] = ((col >> 5) & 31) << 3;
            rgba[dst + 2] = ((col >> 10) & 31) << 3;
            rgba[dst + 3] = 255;
          }
        }
      }
      progress(0.1 + 0.9 * (start + n) / CARDS);
    }

    return {
      game: { version: 3, source: src.slusName || '', cards: cards, duelists: duelists, fusions: fusions, rituals: rituals, atlas: atlas },
      rgba: rgba
    };
  }

  return {
    CARDS: CARDS, DUELISTS: DUELISTS, OFF: OFF, CHARS: CHARS, TYPES: TYPES,
    fromFile: fromFile, open: open, openImage: openImage, parse: parse
  };
});
