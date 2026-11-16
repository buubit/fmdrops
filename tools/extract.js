// Extrai cartas, duelistas e drops para JSON.
// uso: node tools/extract.js jogo.bin [saida.json]
//  ou: node tools/extract.js SLUS_014.11 WA_MRG.MRG [saida.json]
const fs = require('fs');
const FM = require('../web/fm.js');
const args = process.argv.slice(2);
const out = /\.json$/i.test(args[args.length - 1] || '') ? args.pop() : 'drops.json';
if (!args.length) { console.error('uso: node tools/extract.js jogo.bin [saida.json]'); process.exit(1); }
const blob = p => {
  const fd = fs.openSync(p, 'r');
  return { name: p, size: fs.fstatSync(fd).size, read: async (a, b) => { const buf = Buffer.alloc(b - a); fs.readSync(fd, buf, 0, b - a, a); return new Uint8Array(buf); } };
};
FM.open(args.map(blob)).then(src => FM.parse(src)).then(({ game }) => {
  fs.writeFileSync(out, JSON.stringify(game));
  const n = game.duelists.reduce((s, d) => s + d.pow.length + d.bcd.length + d.tec.length, 0);
  console.log(`${game.cards.length} cartas, ${game.duelists.length} duelistas, ${n} entradas de drop -> ${out}`);
}).catch(e => { console.error(e.message); process.exit(1); });
