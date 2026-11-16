// Gera uma imagem de CD FALSA (sem conteúdo do jogo) no mesmo formato, para testar o leitor e o app.
// uso: node tools/make-fixture.js saida.bin
const fs = require('fs');
const FM = require('../web/fm.js');
const O = FM.OFF, rev = {};
for (const k in FM.CHARS) if (!(FM.CHARS[k] in rev)) rev[FM.CHARS[k]] = +k;
const enc = s => [...s].map(c => rev[c] ?? 0).concat(0xFF);

const slus = Buffer.alloc(0x1D0000), mrg = Buffer.alloc(0xFB9808 + 722 * 8 + 0x800);
let tp = 0x6000 + 0x800, dp = 0x9F4; // ponteiros de texto
const put = (ptrOff, base, ptr, s) => { slus.writeUInt16LE(ptr, ptrOff); const b = enc(s); Buffer.from(b).copy(slus, base + ptr); return ptr + b.length; };
for (let i = 0; i < 722; i++) {
  const type = i % 24, atk = (i * 7) % 400, def = (i * 3) % 400;
  slus.writeUInt32LE(((type << 26) | (def << 9) | atk) >>> 0, O.slusStats + i * 4);
  slus[O.slusLevelAttr + i] = 1 + (i % 8);
  tp = put(O.slusCardNamePtr + i * 2, O.slusTextBase, tp, `Test Card #${i + 1}`);
  dp = put(O.slusDescPtr + i * 2, O.slusDescBase, dp, `Description of card ${i + 1}.`);
  mrg.writeUInt32LE(i * 10, O.mrgCosts + i * 8);
  mrg.writeUInt32LE(i % 5 ? 0xFFFFFFFE : 0x12345678, O.mrgCosts + i * 8 + 4);
  const im = O.mrgImages + i * O.mrgImageStride;
  for (let p = 0; p < 102 * 96; p++) mrg[im + p] = ((p % 102) + Math.floor(p / 102) + i) & 255;
  for (let c = 0; c < 256; c++) mrg.writeUInt16LE(((c >> 3) << ((i % 3) * 5)) | ((i * 5) & 31) << (((i + 1) % 3) * 5), im + 102 * 96 + c * 2);
}
for (let d = 0; d < 39; d++) {
  tp = put(O.slusDuelistNamePtr + d * 2, O.slusTextBase, tp, `Duelist ${d + 1}`);
  const base = O.mrgDuelists + d * O.mrgDuelistStride;
  [[O.mrgSaPow, 64, 3], [O.mrgBcd, 128, 5], [O.mrgSaTec, 32, 7]].forEach(([off, n, step]) => {
    for (let k = 0; k < n; k++) mrg.writeUInt16LE(2048 / n, base + off + ((d * 11 + k * step) % 700) * 2);
  });
}

// fusões falsas: carta i (1..40) + carta i+k -> carta 100+i+k
{ let fp = 2 + 722 * 2 + 2; const F = O.mrgFusions;
  for (let i = 1; i <= 40; i++) {
    const list = []; for (let k = 1; k <= (i % 4) + 1; k++) list.push([i + k, 100 + i + k]);
    if (i <= 8) for (let k = 1; k <= 6; k++) list.push([i + 24 * k, 300]); // mesmo tipo -> mesma carta
    mrg.writeUInt16LE(fp, F + 2 + (i - 1) * 2); mrg[F + fp++] = list.length;
    for (let j = 0; j < list.length; j += 2) {
      const [a, ra] = list[j], [b, rb] = list[j + 1] || [0, 0];
      mrg[F + fp++] = (a >> 8) | (ra >> 8) << 2 | (b >> 8) << 4 | (rb >> 8) << 6;
      mrg[F + fp++] = a & 255; mrg[F + fp++] = ra & 255; mrg[F + fp++] = b & 255; mrg[F + fp++] = rb & 255;
    }
  }
}
[[700, 10, 11, 12, 650], [701, 20, 21, 22, 651]].forEach((r, i) => r.forEach((v, j) => mrg.writeUInt16LE(v, O.mrgRituals + i * 10 + j * 2)));
const sec = lba => lba * 2352 + 24, files = [];
const SLUS_LBA = 30, MRG_LBA = 1000, total = MRG_LBA + Math.ceil(mrg.length / 2048);
const img = Buffer.alloc(total * 2352);
for (let l = 0; l < total; l++) { img.fill(0xFF, l * 2352 + 1, l * 2352 + 11); img[l * 2352 + 15] = 2; }
const rec = (name, lba, size, dir) => {
  const n = Buffer.from(name, 'latin1'), len = 33 + n.length + ((33 + n.length) % 2), r = Buffer.alloc(len);
  r[0] = len; r.writeUInt32LE(lba, 2); r.writeUInt32LE(size, 10); r[25] = dir ? 2 : 0; r[32] = n.length; n.copy(r, 33); return r;
};
const pvd = Buffer.alloc(2048); pvd[0] = 1; pvd.write('CD001', 1); rec('\0', 20, 2048, true).copy(pvd, 156);
pvd.copy(img, sec(16));
Buffer.concat([rec('\0', 20, 2048, true), rec('\x01', 20, 2048, true), rec('DATA', 21, 2048, true), rec('SLUS_014.11;1', SLUS_LBA, slus.length)]).copy(img, sec(20));
Buffer.concat([rec('\0', 21, 2048, true), rec('\x01', 20, 2048, true), rec('WA_MRG.MRG;1', MRG_LBA, mrg.length)]).copy(img, sec(21));
const lay = (buf, lba) => { for (let o = 0; o < buf.length; o += 2048) buf.copy(img, sec(lba + o / 2048), o, Math.min(o + 2048, buf.length)); };
lay(slus, SLUS_LBA); lay(mrg, MRG_LBA);
fs.writeFileSync(process.argv[2] || 'fixture.bin', img);
