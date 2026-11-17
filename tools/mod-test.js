// Gera um mod com o editor do app (web/mod.js) e grava a imagem resultante.
// uso: node tools/mod-test.js base.bin saida.bin '{"drops":100,...}'
const fs = require('fs'), FMMod = require('../web/mod.js');
require('../web/lang-pt.js');
const [, , input, output, json] = process.argv;
const fd = fs.openSync(input, 'r');
const blob = { name: input, size: fs.fstatSync(fd).size, read: async (a, b) => { const buf = Buffer.alloc(b - a); fs.readSync(fd, buf, 0, b - a, a); return new Uint8Array(buf); } };
(async () => {
  const ed = await FMMod.open(blob);
  console.log('capacidades', ed.caps);
  console.log(FMMod.apply(ed, JSON.parse(json)).join(', '));
  const { ppf, sectors } = await FMMod.buildPatch(ed);
  const img = fs.readFileSync(input);
  let i = 60;
  while (i < ppf.length) {
    let off = 0; for (let b = 7; b >= 0; b--) off = off * 256 + ppf[i + b];
    const n = ppf[i + 8]; const data = ppf.subarray(i + 9, i + 9 + n), orig = ppf.subarray(i + 9 + n, i + 9 + 2 * n);
    if (Buffer.compare(img.subarray(off, off + n), Buffer.from(orig))) throw new Error('undo não bate');
    img.set(data, off); i += 9 + 2 * n;
  }
  fs.writeFileSync(output, img);
  console.log(sectors, 'setores, patch', ppf.length, 'bytes');
})().catch(e => { console.error(e); process.exit(1); });
