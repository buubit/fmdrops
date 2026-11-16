(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var main = $('main'), sheet = $('sheet'), sheetContent = $('sheetContent');
  var game = null, atlasUrl = '', view = 'cards', query = '';
  var dropsByCard = null, fusionsTo = null, fusionsWith = null;
  var RELEASE_API = 'https://api.github.com/repos/buubit/fmdrops/releases/tags/latest';
  var BUILD = window.APP_BUILD || 0;
  var RANKS = [['pow', 'S/A POW'], ['bcd', 'B/C/D'], ['tec', 'S/A TEC']];

  /* ---------- armazenamento local (IndexedDB) ---------- */

  function db() {
    return new Promise(function (ok, fail) {
      var r = indexedDB.open('fmdrops', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { fail(r.error); };
    });
  }
  function kv(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, fail) {
        var tx = d.transaction('kv', mode), out = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { ok(out && out.result); };
        tx.onerror = tx.onabort = function () { fail(tx.error); };
      });
    });
  }
  var load = function (k) { return kv('readonly', function (s) { return s.get(k); }); };
  var save = function (k, v) { return kv('readwrite', function (s) { return s.put(v, k); }); };
  var clearAll = function () { return kv('readwrite', function (s) { return s.clear(); }); };

  function perDuel() {
    var n = 1;
    try { n = parseInt(localStorage.getItem('perDuel'), 10) || 1; } catch (e) {}
    return Math.max(1, Math.min(999, n));
  }

  /* ---------- utilidades ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pct(rate) {
    var p = rate / 2048, n = perDuel();
    if (n > 1) p = 1 - Math.pow(1 - p, n);
    p *= 100;
    if (p >= 99.95) return '100%';
    return (p < 1 ? p.toFixed(2) : p.toFixed(1)).replace('.', ',') + '%';
  }
  function art(id) {
    var a = game.atlas, i = id - 1;
    var x = (i % a.cols) / (a.cols - 1) * 100, y = Math.floor(i / a.cols) / (a.rows - 1) * 100;
    return '<span class="art" style="background-image:url(' + atlasUrl + ');background-size:' +
      a.cols * 100 + '% ' + a.rows * 100 + '%;background-position:' + x + '% ' + y + '%"></span>';
  }
  function legend() {
    var n = perDuel();
    return '<p class="legend">' + (n > 1
      ? 'Chance de sair pelo menos uma vez em um duelo com ' + n + ' cartas de drop.'
      : 'Chance por carta dropada.') + '</p>';
  }

  function index() {
    dropsByCard = {};
    game.duelists.forEach(function (d) {
      RANKS.forEach(function (r) {
        d[r[0]].forEach(function (e) {
          var c = dropsByCard[e[0]] || (dropsByCard[e[0]] = {});
          (c[d.id] || (c[d.id] = {}))[r[0]] = e[1];
        });
      });
    });
    fusionsTo = {}; fusionsWith = {};
    (game.fusions || []).forEach(function (f) {
      (fusionsTo[f[2]] || (fusionsTo[f[2]] = [])).push(f);
      (fusionsWith[f[0]] || (fusionsWith[f[0]] = [])).push(f);
      if (f[1] !== f[0]) (fusionsWith[f[1]] || (fusionsWith[f[1]] = [])).push(f);
    });
  }

  function mini(id) {
    var c = game.cards[id - 1];
    return '<button data-card="' + id + '">' + art(id) + '<span class="t">' + esc(c.name) + '</span></button>';
  }
  // kind: 'to' = pares que geram a carta; 'with' = o que a carta gera com outras
  function fusionList(id, kind, all) {
    var list = (kind === 'to' ? fusionsTo : fusionsWith)[id] || [];
    if (!list.length) return '';
    var LIMIT = 30, shown = all ? list : list.slice(0, LIMIT);
    return '<h3>' + (kind === 'to' ? 'Fusões que geram esta carta' : 'Fusões usando esta carta') + ' (' + list.length + ')</h3>' +
      shown.map(function (f) {
        if (kind === 'to') return '<div class="fuse">' + mini(f[0]) + '<span class="op">+</span>' + mini(f[1]) + '</div>';
        var other = f[0] === id ? f[1] : f[0];
        return '<div class="fuse"><span class="op">+</span>' + mini(other) + '<span class="op">=</span>' + mini(f[2]) + '</div>';
      }).join('') +
      (list.length > shown.length ? '<button class="secondary more" data-card="' + id + '" data-all="' + kind +
        '">Mostrar todas (' + list.length + ')</button>' : '');
  }

  /* ---------- telas ---------- */

  function render() {
    $('tools').hidden = !game;
    if (!game) return renderEmpty();
    $('tabCards').setAttribute('aria-selected', view === 'cards');
    $('tabDuelists').setAttribute('aria-selected', view === 'duelists');
    $('search').placeholder = view === 'cards' ? 'Buscar carta ou número' : 'Buscar duelista';
    var q = query.trim().toLowerCase();
    if (view === 'cards') {
      var list = game.cards.filter(function (c) {
        return !q || c.name.toLowerCase().indexOf(q) >= 0 || String(c.id) === q.replace(/^#?0*/, '');
      });
      main.innerHTML = '<p class="count">' + list.length + ' cartas</p><div class="grid">' +
        list.map(function (c) {
          return '<button class="card' + (dropsByCard[c.id] ? '' : ' nodrop') + '" data-card="' + c.id +
            '" aria-label="' + esc(c.name) + '">' + art(c.id) + '<span class="num">' + c.id + '</span></button>';
        }).join('') + '</div>';
    } else {
      main.innerHTML = '<div class="list">' + game.duelists.filter(function (d) {
        return !q || d.name.toLowerCase().indexOf(q) >= 0;
      }).map(function (d) {
        return '<button class="item" data-duelist="' + d.id + '"><span class="n">' + d.id +
          '</span><span class="grow">' + esc(d.name) + '</span></button>';
      }).join('') + '</div>';
    }
  }

  function renderEmpty(msg) {
    main.innerHTML = '<div class="empty"><h2>Importar o jogo</h2>' +
      '<p>Escolha a imagem do seu Forbidden Memories (<b>.bin</b> ou <b>.iso</b>, já extraída do .7z/.zip). ' +
      'O app lê as cartas, as fotos e os drops direto dela. Nada sai do aparelho.</p>' +
      '<div class="actions"><button id="btnImport">Escolher arquivo</button></div>' +
      '<p>Também funciona selecionando juntos os arquivos <b>SLUS_014.11</b> e <b>WA_MRG.MRG</b>.</p>' +
      '<div id="status">' + (msg ? '<p class="error">' + esc(msg) + '</p>' : '') + '</div></div>';
  }

  function openSheet(html) {
    sheetContent.innerHTML = html;
    if (sheet.hidden) { sheet.hidden = false; history.pushState({ sheet: 1 }, ''); }
    sheet.firstElementChild.scrollTop = 0;
  }
  function closeSheet() { if (!sheet.hidden) history.back(); }
  window.addEventListener('popstate', function () { sheet.hidden = true; });

  function showCard(id, all) {
    var c = game.cards[id - 1], drops = dropsByCard[id] || {};
    var rows = Object.keys(drops).map(function (did) {
      var r = drops[did];
      return { d: game.duelists[did - 1], r: r, best: Math.max(r.pow || 0, r.bcd || 0, r.tec || 0) };
    }).sort(function (a, b) { return b.best - a.best; });
    var meta = c.monster
      ? '<b>' + c.atk + '</b> ATK · <b>' + c.def + '</b> DEF<br>' + esc(c.typeName) + ' · nível ' + c.level
      : esc(c.typeName);
    if (c.password) meta += '<br>Senha ' + c.password + (c.cost && c.cost < 999999 ? ' · ' + c.cost + ' estrelas' : '');
    openSheet('<div class="hero">' + art(id) + '<div><h2>' + esc(c.name) + '</h2><div class="meta">#' +
      ('00' + id).slice(-3) + '<br>' + meta + '</div></div></div>' +
      (c.desc ? '<p class="desc">' + esc(c.desc.replace(/\n/g, ' ')) + '</p>' : '') +
      '<h3>Onde dropa</h3>' +
      (rows.length ? legend() + rows.map(function (x) {
        return '<div class="drop"><button class="who" data-duelist="' + x.d.id + '">' + esc(x.d.name) +
          '</button><span class="pills">' + RANKS.map(function (k) {
            return x.r[k[0]] ? '<span class="pill ' + k[0] + '">' + k[1] + ' ' + pct(x.r[k[0]]) + '</span>' : '';
          }).join('') + '</span></div>';
      }).join('') : '<p class="meta">Nenhum duelista dropa esta carta.</p>') +
      (game.fusions
        ? (fusionList(id, 'to', all === 'to') + fusionList(id, 'with', all === 'with')) ||
          '<h3>Fusões</h3><p class="meta">Esta carta não participa de nenhuma fusão.</p>'
        : '<h3>Fusões</h3><p class="note">Para ver as fusões, importe o jogo de novo em ⚙ (os dados salvos são de uma versão antiga do app).</p>'));
  }

  function showDuelist(id, rank) {
    var d = game.duelists[id - 1];
    rank = rank || 'pow';
    openSheet('<h2 style="margin:0 36px 0 0">' + esc(d.name) + '</h2>' +
      '<div class="seg">' + RANKS.map(function (k) {
        return '<button data-duelist="' + id + '" data-rank="' + k[0] + '" aria-pressed="' + (k[0] === rank) +
          '">' + k[1] + ' (' + d[k[0]].length + ')</button>';
      }).join('') + '</div>' + legend() + '<div class="list">' +
      d[rank].map(function (e) {
        var c = game.cards[e[0] - 1];
        return '<button class="item" data-card="' + c.id + '">' + art(c.id) + '<span class="grow">' + esc(c.name) +
          '<small>#' + c.id + (c.monster ? ' · ' + c.atk + '/' + c.def : ' · ' + esc(c.typeName)) +
          '</small></span><span class="rate">' + pct(e[1]) + '</span></button>';
      }).join('') + '</div>');
  }

  function showSettings() {
    openSheet('<h2 style="margin:0 36px 0 0">Configurações</h2>' +
      '<label class="field"><span>Cartas dropadas por duelo<br><small class="meta">Use o valor do seu mod (jogo original: 1).</small></span>' +
      '<input id="perDuel" type="number" min="1" max="999" inputmode="numeric" value="' + perDuel() + '"></label>' +
      '<p class="meta">' + (game ? 'Jogo carregado: ' + esc(game.source || 'arquivos soltos') + ' · ' +
        game.cards.length + ' cartas, ' + game.duelists.length + ' duelistas.' : 'Nenhum jogo importado.') + '</p>' +
      '<div class="stack"><button id="btnImport">Importar outra imagem / mod</button>' +
      (game ? '<button id="btnClear" class="secondary">Apagar dados do app</button>' : '') + '</div>' +
      '<h3>Atualização do app</h3><p class="meta">Versão instalada: build ' + BUILD + '</p>' +
      '<div id="update" class="stack"><button id="btnUpdate" class="secondary">Procurar atualização</button></div>');
  }

  function checkUpdate() {
    var box = $('update');
    box.innerHTML = '<p class="meta">Procurando…</p>';
    fetch(RELEASE_API, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('GitHub respondeu ' + r.status);
      return r.json();
    }).then(function (rel) {
      if (!$('update')) return;
      var m = /build\s+(\d+)/i.exec(rel.body || ''), latest = m ? +m[1] : 0;
      var apk = (rel.assets || []).filter(function (a) { return /\.apk$/.test(a.name); })[0];
      if (!apk || !latest) throw new Error('não encontrei o APK na release');
      $('update').innerHTML = latest > BUILD
        ? '<p class="note"><b>Build ' + latest + ' disponível.</b> Baixe e abra o arquivo para instalar por cima; os dados importados continuam.</p>' +
          '<a class="btn" href="' + esc(apk.browser_download_url) + '">Baixar build ' + latest + '</a>'
        : '<p class="note">Você já está na versão mais recente (build ' + latest + ').</p>';
    }).catch(function (e) {
      if ($('update')) $('update').innerHTML = '<p class="error">Não deu para verificar (' + esc(e.message || e) +
        '). Confira a internet.</p><button id="btnUpdate" class="secondary">Tentar de novo</button>';
    });
  }

  /* ---------- importação ---------- */

  function toPng(rgba, a) {
    var cv = document.createElement('canvas');
    cv.width = a.width; cv.height = a.height;
    var ctx = cv.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), a.width, a.height), 0, 0);
    return new Promise(function (ok, fail) {
      cv.toBlob(function (b) { b ? ok(b) : fail(new Error('Falha ao gerar as imagens.')); }, 'image/png');
    });
  }

  function setGame(g, blob) {
    game = g;
    if (atlasUrl) URL.revokeObjectURL(atlasUrl);
    atlasUrl = URL.createObjectURL(blob);
    index();
  }

  async function importFiles(files) {
    if (!sheet.hidden) closeSheet();
    game = null; render();
    var status = $('status');
    status.innerHTML = '<progress id="prog" max="1" value="0"></progress><p class="meta">Lendo o jogo…</p>';
    try {
      var src = await FM.open(Array.prototype.map.call(files, FM.fromFile));
      var out = await FM.parse(src, function (p) { $('prog').value = p; });
      var total = out.game.duelists.reduce(function (s, d) { return s + d.pow.length + d.bcd.length + d.tec.length; }, 0);
      if (!total) throw new Error('Não encontrei tabelas de drop nesse arquivo. A versão pode não ser a USA (SLUS-01411).');
      var blob = await toPng(out.rgba, out.game.atlas);
      await save('game', out.game);
      await save('atlas', blob);
      setGame(out.game, blob);
      render();
    } catch (e) {
      var saved = await boot(true);
      if (!saved) renderEmpty(e.message || String(e));
      else alert('Não foi possível importar: ' + (e.message || e));
    }
  }

  async function boot(silent) {
    try {
      var g = await load('game'), blob = await load('atlas');
      if (g && blob) { setGame(g, blob); render(); return true; }
    } catch (e) { /* sem dados salvos */ }
    if (!silent) render();
    return false;
  }

  /* ---------- eventos ---------- */

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('button');
    if (!t) { if (ev.target === sheet) closeSheet(); return; }
    if (t.id === 'btnImport') { $('file').value = ''; $('file').click(); }
    else if (t.id === 'btnSettings') showSettings();
    else if (t.id === 'sheetClose') closeSheet();
    else if (t.id === 'tabCards' || t.id === 'tabDuelists') { view = t.id === 'tabCards' ? 'cards' : 'duelists'; render(); }
    else if (t.id === 'btnClear') {
      if (confirm('Apagar as cartas e drops importados?')) clearAll().then(function () { game = null; closeSheet(); render(); });
    }
    else if (t.id === 'btnUpdate') checkUpdate();
    else if (t.dataset.duelist) showDuelist(+t.dataset.duelist, t.dataset.rank);
    else if (t.dataset.card) showCard(+t.dataset.card, t.dataset.all);
  });
  $('file').addEventListener('change', function () { if (this.files.length) importFiles(this.files); });
  $('search').addEventListener('input', function () { query = this.value; render(); });
  document.addEventListener('change', function (ev) {
    if (ev.target.id !== 'perDuel') return;
    try { localStorage.setItem('perDuel', Math.max(1, parseInt(ev.target.value, 10) || 1)); } catch (e) {}
  });

  boot();
})();
