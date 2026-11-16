(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var main = $('main'), sheet = $('sheet'), sheetContent = $('sheetContent');
  var game = null, atlasUrl = '', view = 'cards', query = '', fusFilter = 'all';
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
  function typeOf(id) { return game.cards[id - 1].typeName; }
  function pairRow(a, b) { return '<div class="fuse">' + mini(a) + '<span class="op">+</span>' + mini(b) + '</div>'; }
  function group(list, keyOf) {
    var map = {}, order = [];
    list.forEach(function (f) {
      var k = keyOf(f);
      if (!map[k]) { map[k] = []; order.push(k); }
      map[k].push(f);
    });
    order.sort(function (x, y) { return map[y].length - map[x].length; });
    return order.map(function (k) { return { key: k, items: map[k] }; });
  }
  var GROUP_MIN = 3; // a partir de quantos pares do mesmo tipo vira "Tipo + Tipo"

  // Pares que geram a carta: combinações repetidas viram "Dragão + Trovão"; as específicas mostram as fotos.
  function fusionsToHtml(id) {
    var list = fusionsTo[id] || [];
    if (!list.length) return '';
    var generic = '', specific = '';
    group(list, function (f) {
      var a = typeOf(f[0]), b = typeOf(f[1]);
      return a < b ? a + '|' + b : b + '|' + a;
    }).forEach(function (g) {
      if (g.items.length < GROUP_MIN) { specific += g.items.map(function (f) { return pairRow(f[0], f[1]); }).join(''); return; }
      var t = g.key.split('|');
      generic += '<details class="grp"><summary><span class="types"><b>' + esc(t[0]) + '</b><span class="op">+</span><b>' +
        esc(t[1]) + '</b></span><span class="badge">' + g.items.length + ' pares</span></summary>' +
        g.items.map(function (f) { return pairRow(f[0], f[1]); }).join('') + '</details>';
    });
    return '<h3>Fusões que geram esta carta (' + list.length + ')</h3>' +
      (generic ? '<p class="legend">Toque num tipo para ver os pares exatos (nem toda carta do tipo serve).</p>' : '') +
      generic + specific;
  }

  // O que a carta gera: "+ Trovão = resultado" quando vários do mesmo tipo dão o mesmo resultado.
  function fusionsWithHtml(id) {
    var list = fusionsWith[id] || [];
    if (!list.length) return '';
    var other = function (f) { return f[0] === id ? f[1] : f[0]; };
    var generic = '', specific = '';
    group(list, function (f) { return typeOf(other(f)) + '|' + f[2]; }).forEach(function (g) {
      var res = +g.key.split('|')[1], rc = game.cards[res - 1];
      if (g.items.length < GROUP_MIN) {
        specific += g.items.map(function (f) {
          return '<div class="fuse"><span class="op">+</span>' + mini(other(f)) + '<span class="op">=</span>' + mini(res) + '</div>';
        }).join('');
        return;
      }
      generic += '<details class="grp"><summary><span class="types"><span class="op">+</span><b>' + esc(g.key.split('|')[0]) +
        '</b><span class="op">=</span>' + art(res) + '<span class="t">' + esc(rc.name) + '</span></span><span class="badge">' +
        g.items.length + '</span></summary><div class="fuse"><span class="op">=</span>' + mini(res) + '</div>' +
        g.items.map(function (f) { return '<div class="fuse"><span class="op">+</span>' + mini(other(f)) + '</div>'; }).join('') +
        '</details>';
    });
    return '<h3>Fusões usando esta carta (' + list.length + ')</h3>' + generic + specific;
  }

  function ritualsHtml(id) {
    return (game.rituals || []).filter(function (r) { return r.indexOf(id) >= 0; }).map(function (r) {
      return '<h3>Ritual</h3><div class="ritual"><p class="legend">Carta de ritual</p><div class="fuse">' + mini(r[0]) +
        '</div><p class="legend">Sacrifícios no campo</p>' +
        [r[1], r[2], r[3]].map(function (t) { return '<div class="fuse">' + mini(t) + '</div>'; }).join('') +
        '<p class="legend">Invoca</p><div class="fuse">' + mini(r[4]) + '</div></div>';
    }).join('');
  }

  /* ---------- telas ---------- */

  function render() {
    $('tools').hidden = !game;
    if (!game) return renderEmpty();
    ['cards', 'fusions', 'duelists'].forEach(function (v) {
      $('tab' + v[0].toUpperCase() + v.slice(1)).setAttribute('aria-selected', view === v);
    });
    $('search').placeholder = view === 'duelists' ? 'Buscar duelista' : 'Buscar carta ou número';
    var q = query.trim().toLowerCase();
    var match = function (c) {
      return !q || c.name.toLowerCase().indexOf(q) >= 0 || String(c.id) === q.replace(/^#?0*/, '');
    };
    var tile = function (c, dim) {
      return '<button class="card' + (dim ? ' nodrop' : '') + '" data-card="' + c.id +
        '" aria-label="' + esc(c.name) + '">' + art(c.id) + '<span class="num">' + c.id + '</span></button>';
    };
    if (view === 'cards') {
      var list = game.cards.filter(match);
      main.innerHTML = '<p class="count">' + list.length + ' cartas</p><div class="grid">' +
        list.map(function (c) { return tile(c, !dropsByCard[c.id]); }).join('') + '</div>';
    } else if (view === 'fusions') {
      if (!game.fusions || !game.rituals) {
        main.innerHTML = '<p class="note">Para ver esta área, importe o jogo de novo em ⚙ (os dados salvos são de uma versão antiga do app).</p>';
        return;
      }
      var ritualSet = {};
      game.rituals.forEach(function (r) { ritualSet[r[4]] = 1; });
      var chips = [['all', 'Todas'], ['fusion', 'Fusão'], ['ritual', 'Ritual']];
      var fl = game.cards.filter(function (c) {
        var f = !!fusionsTo[c.id], r = !!ritualSet[c.id];
        return match(c) && (fusFilter === 'fusion' ? f : fusFilter === 'ritual' ? r : f || r);
      });
      main.innerHTML = '<div class="chips">' + chips.map(function (k) {
        return '<button data-fus="' + k[0] + '" aria-pressed="' + (fusFilter === k[0]) + '">' + k[1] + '</button>';
      }).join('') + '</div><p class="count">' + fl.length + ' cartas que podem ser feitas por fusão ou ritual</p>' +
        '<div class="grid">' + fl.map(function (c) { return tile(c); }).join('') + '</div>';
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
        ? (ritualsHtml(id) + fusionsToHtml(id) + fusionsWithHtml(id)) ||
          '<h3>Fusões</h3><p class="meta">Esta carta não participa de nenhuma fusão ou ritual.</p>'
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
      (native && native.applyPatch ? '<h3>Aplicar mod no jogo</h3><p class="meta">Gera um .bin novo com o patch (.ppf) aplicado, para abrir no DuckStation. ' +
        'Você escolhe: 1) o .bin do jogo, 2) o .ppf, 3) onde salvar. O jogo original não é alterado.</p>' +
        '<div id="patch" class="stack"><button id="btnPatch">Aplicar patch .ppf</button></div>' : '') +
      '<h3>Atualização do app</h3><p class="meta">Versão instalada: build ' + BUILD + '</p>' +
      '<div id="update" class="stack"><button id="btnUpdate" class="secondary">Procurar atualização</button></div>');
  }

  var native = window.Android && window.Android.applyUpdate ? window.Android : null;

  function findUpdate() {
    return fetch(RELEASE_API, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('GitHub respondeu ' + r.status);
      return r.json();
    }).then(function (rel) {
      var m = /build\s+(\d+)/i.exec(rel.body || ''), sh = /shell\s+(\d+)/i.exec(rel.body || '');
      var asset = function (re) {
        var a = (rel.assets || []).filter(function (x) { return re.test(x.name); })[0];
        return a ? a.browser_download_url : '';
      };
      var info = { latest: m ? +m[1] : 0, apk: asset(/\.apk$/), web: asset(/^web\.json$/) };
      if (!info.latest || !info.apk) throw new Error('não encontrei a versão na release');
      info.newer = info.latest > BUILD;
      // Dá para atualizar por dentro quando a casca Android instalada ainda serve.
      info.inApp = !!(native && info.web && sh && +sh[1] <= native.shellVersion());
      return info;
    });
  }

  function checkUpdate() {
    var box = $('update');
    box.innerHTML = '<p class="meta">Procurando…</p>';
    findUpdate().then(function (u) {
      if (!$('update')) return;
      if (!u.newer) $('update').innerHTML = '<p class="note">Você já está na versão mais recente (build ' + u.latest + ').</p>';
      else if (u.inApp) $('update').innerHTML = '<p class="note"><b>Build ' + u.latest + ' disponível.</b> Atualiza aqui mesmo, sem baixar APK; os dados importados continuam.</p>' +
        '<button id="btnApply" data-url="' + esc(u.web) + '">Atualizar agora</button>';
      else $('update').innerHTML = '<p class="note"><b>Build ' + u.latest + ' disponível.</b> Esta precisa do APK novo: baixe e abra o arquivo para instalar por cima.</p>' +
        '<a class="btn" href="' + esc(u.apk) + '">Baixar build ' + u.latest + '</a>';
    }).catch(function (e) {
      if ($('update')) $('update').innerHTML = '<p class="error">Não deu para verificar (' + esc(e.message || e) +
        ').</p><button id="btnUpdate" class="secondary">Tentar de novo</button>';
    });
  }

  function patchBox(html) { if ($('patch')) $('patch').innerHTML = html; }
  window.onPatchState = function (msg) {
    patchBox('<p class="meta">' + esc(msg) + '</p>' + (msg === 'cancelado' ? '<button id="btnPatch">Aplicar patch .ppf</button>' : ''));
  };
  window.onPatchProgress = function (f) {
    patchBox('<progress max="1" value="' + f + '"></progress><p class="meta">Gravando… ' + Math.round(f * 100) + '%</p>');
  };
  window.onPatchDone = function (name) {
    patchBox('<p class="note"><b>Pronto!</b> ' + esc(name) + ' foi salvo. No DuckStation, abra esse arquivo (Start File ou atualize a lista de jogos).</p>' +
      '<button id="btnPatch" class="secondary">Aplicar outro patch</button>');
  };
  window.onPatchError = function (msg) {
    patchBox('<p class="error">Não deu certo: ' + esc(msg) + '</p><button id="btnPatch" class="secondary">Tentar de novo</button>');
  };

  window.onUpdateError = function (msg) {
    if ($('update')) $('update').innerHTML = '<p class="error">A atualização falhou (' + esc(msg) +
      ').</p><button id="btnUpdate" class="secondary">Tentar de novo</button>';
  };

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
    else if (/^tab(Cards|Fusions|Duelists)$/.test(t.id)) { view = t.id.slice(3).toLowerCase(); window.scrollTo(0, 0); render(); }
    else if (t.dataset.fus) { fusFilter = t.dataset.fus; render(); }
    else if (t.id === 'btnClear') {
      if (confirm('Apagar as cartas e drops importados?')) clearAll().then(function () { game = null; closeSheet(); render(); });
    }
    else if (t.id === 'btnUpdate') checkUpdate();
    else if (t.id === 'btnPatch') { patchBox('<p class="meta">Escolha o .bin do jogo…</p>'); native.applyPatch(); }
    else if (t.id === 'btnApply') { t.disabled = true; t.textContent = 'Atualizando…'; native.applyUpdate(t.dataset.url); }
    else if (t.id === 'updBadge') { showSettings(); checkUpdate(); }
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
  window.__fmBooted = true;
  // Aviso discreto no topo quando existe versão nova.
  findUpdate().then(function (u) { if (u.newer) $('updBadge').hidden = false; }).catch(function () {});
})();
