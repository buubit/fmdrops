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
    if (!game && view !== 'mod') return renderEmpty();
    ['cards', 'fusions', 'duelists', 'mod'].forEach(function (v) {
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
    $('search').hidden = view === 'mod';
    if (view === 'mod') return renderMod();
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
      (c.desc ? '<p class="desc">' + esc(modOpts.lang === 'pt' && window.FM_LANG_PT ? window.FM_LANG_PT[id - 1] : c.desc.replace(/\n/g, ' ')) + '</p>' : '') +
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
        'Você escolhe: 1) o .bin do jogo, 2) o .ppf. Ele grava o .bin e o .cue na pasta de jogos. O jogo original não é alterado.</p>' +
        '<div class="stack patchbox"><button id="btnPatch">Aplicar patch .ppf</button></div>' : '') +
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

  function patchBox(html) {
    Array.prototype.forEach.call(document.querySelectorAll('.patchbox'), function (el) { el.innerHTML = html; });
  }
  window.onPatchState = function (msg) {
    patchBox('<p class="meta">' + esc(msg) + '</p>' + (msg === 'cancelado' ? '<button id="btnPatch">Aplicar patch .ppf</button>' : ''));
  };
  window.onPatchProgress = function (f) {
    patchBox('<progress max="1" value="' + f + '"></progress><p class="meta">Gravando… ' + Math.round(f * 100) + '%</p>');
  };
  window.onPatchDone = function (name) {
    patchBox('<p class="note"><b>Pronto!</b> ' + esc(name) + ' e o .cue foram salvos. No DuckStation: menu → <b>Scan For New Games</b>. ' +
      'Use um cartão de memória novo se mudou a base do jogo.</p>');
  };
  window.onOutputFolder = function (label) { var el = $('outFolder'); if (el) el.textContent = label; };
  window.onPatchError = function (msg) {
    patchBox('<p class="error">Não deu certo: ' + esc(msg) + '</p><button id="btnPatch" class="secondary">Tentar de novo</button>');
  };

  window.onUpdateError = function (msg) {
    if ($('update')) $('update').innerHTML = '<p class="error">A atualização falhou (' + esc(msg) +
      ').</p><button id="btnUpdate" class="secondary">Tentar de novo</button>';
  };

  /* ---------- Mod ("GameShark") ---------- */

  var mod = { blob: null, caps: null, ed: null, error: '', busy: false };
  var MOD_DEFAULT = { lang: 'en', cards: {}, rituals: {}, custom: [], starter: null, randomizer: { on: false, seed: 1, decks: false }, dropPool: 'rank', deckLimit: 3, terrain: 'normal', priceDiv: 1, buyAll: false,
    freeDuel: true, drops: 100, starchips: 0, lp: 8000, allDrops: true, megamorph: true, difficulty: 'normal' };
  var modOpts = (function () {
    try { return Object.assign({}, MOD_DEFAULT, JSON.parse(localStorage.getItem('modOpts') || '{}')); } catch (e) { return Object.assign({}, MOD_DEFAULT); }
  })();
  function saveModOpts() { try { localStorage.setItem('modOpts', JSON.stringify(modOpts)); } catch (e) {} }

  function renderMod() {
    var c = mod.caps;
    var head = '<div class="modcard"><h2>Criar meu mod</h2><p class="meta">Escolha as opções e o app grava um <b>.bin novo</b> para abrir no DuckStation. ' +
      'O jogo base não é alterado; dá para gerar quantas versões quiser.</p>';
    if (!mod.blob) {
      main.innerHTML = head + '<div class="stack"><button id="btnModPick">Escolher o .bin do jogo</button></div>' +
        (mod.error ? '<p class="error">' + esc(mod.error) + '</p>' : '') +
        '<p class="meta">Funciona com o jogo original (todas as opções) e com o build Drop 100.</p></div>';
      return;
    }
    if (!c) { main.innerHTML = head + '<p class="meta">Lendo o jogo…</p></div>'; return; }
    var off = function (v) { return v == null ? ' disabled' : ''; };
    var na = function (v) { return v == null ? '<small class="na">não disponível nesta versão do jogo</small>' : ''; };
    var num = function (id, label, help, v, min, max, quick) {
      return '<div class="opt"><label for="' + id + '"><b>' + label + '</b><small>' + help + '</small>' + na(c[id]) + '</label>' +
        '<input id="' + id + '" class="modnum" type="number" inputmode="numeric" min="' + min + '" max="' + max + '" value="' + v + '"' + off(c[id]) + '>' +
        (quick && c[id] != null ? '<div class="quick">' + quick.map(function (q) {
          return '<button data-quick="' + id + '" data-v="' + q + '" aria-pressed="' + (+v === q) + '">' + q + '</button>';
        }).join('') + '</div>' : '') + '</div>';
    };
    var tog = function (id, label, help, avail) {
      var dis = avail === null;
      return '<label class="opt toggle"><span><b>' + label + '</b><small>' + help + '</small>' + (dis ? '<small class="na">não disponível nesta versão do jogo</small>' : '') + '</span>' +
        '<input type="checkbox" class="modtog" id="' + id + '"' + (modOpts[id] && !dis ? ' checked' : '') + (dis ? ' disabled' : '') + '><i></i></label>';
    };
    var diffs = [['facil', 'Fácil'], ['normal', 'Normal'], ['dificil', 'Difícil'], ['muito', 'Muito difícil']];
    var presets = [['original', 'Original'], ['drop100', 'Drop 100'], ['facil', 'Fácil demais'], ['desafio', 'Desafio']];
    main.innerHTML = head + '<p class="meta">Base: <b>' + esc(mod.blob.name || 'jogo') + '</b> (' + esc(c.exe) + ') · ' +
      '<button class="linkbtn" id="btnModPick">trocar</button></p></div>' +
      '<h3>Atalhos</h3><div class="chips">' + presets.map(function (p) { return '<button data-preset="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</div>' +
      randomizerCard() +
      '<h3>Opções</h3>' +
      num('drops', 'Cartas por duelo vencido', 'Original: 1', modOpts.drops, 1, 999, [1, 5, 15, 100]) +
      num('starchips', 'Starchips extras por duelo', 'Somados ao prêmio normal', modOpts.starchips, 0, 30000, [0, 100, 500]) +
      num('lp', 'Vida inicial (os dois jogadores)', 'Original: 8000', modOpts.lp, 100, 9999, [4000, 8000, 9999]) +
      tog('freeDuel', 'Todos os duelistas no Free Duel', 'Liberados desde o início, sem precisar avançar na história', c.freeDuel) +
      tog('allDrops', 'Todas as cartas dropáveis', 'As 82 cartas que ninguém dropa vão para duelistas temáticos') +
      tog('megamorph', 'Megamorph em S/A POW', 'Pegasus, DarkNite e Heishin passam a dropar no POW também') +
      (c.dropPool != null ? segOpt('dropPool', 'Cartas extras do drop vêm de', 'Rank: como o jogo decide. As outras ignoram o rank (só as cartas extras; a carta da tela de resultado segue o rank).',
        [['rank', 'Rank'], ['pow', 'S/A POW'], ['bcd', 'B/C/D'], ['tec', 'S/A TEC']]) : '') +
      num('deckLimit', 'Cópias da mesma carta no deck', 'Original: 3', modOpts.deckLimit, 1, 40, [3, 5, 40]) +
      (c.terrain ? segOpt('terrain', 'Bônus de terreno', 'Quanto o campo soma no ATK/DEF dos tipos favorecidos (original: 500)',
        [['off', 'Nenhum'], ['normal', '500'], ['forte', '1000'], ['max', '1270']]) : '') +
      segOpt('priceDiv', 'Preço das cartas por senha', 'Custo em starchips na loja de senhas',
        [[1, 'Normal'], [2, '÷2'], [5, '÷5'], [10, '÷10'], ['gratis', '1 ★']]) +
      tog('buyAll', 'Vender as cartas "proibidas"', 'Cartas com senha mas preço 999999 (Blue-eyes, Exodia…) passam a custar 99999 antes do desconto') +
      (c.lang ? segOpt('lang', 'Idioma das descrições das cartas', 'Português: as 722 descrições traduzidas (sem acento, o jogo não tem essas letras). Nomes das cartas continuam em inglês.',
        [['en', 'Inglês'], ['pt', 'Português']]) : '') +
      '<h3>Editores</h3><div class="stack">' +
      '<button class="secondary" id="btnEditCards">Editar cartas' + countTag(modOpts.cards) + '</button>' +
      '<button class="secondary" id="btnEditRituals">Editar rituais' + countTag(modOpts.rituals) + '</button>' +
      '<button class="secondary" id="btnCustom">Faça você mesmo: cartas com sua imagem' + countTag(modOpts.custom) + '</button>' +
      (mod.ed && mod.ed.starter ? '<button class="secondary" id="btnStarter">Deck inicial' + (modOpts.starter ? ' <span class="badge">personalizado</span>' : '') + '</button>' : '') +
      '</div>' +
      '<div class="opt"><span><b>Dificuldade dos decks</b><small>Difícil: os duelistas puxam mais os monstros fortes que já têm. Fácil: o contrário.</small></span>' +
      '<div class="seg">' + diffs.map(function (d) {
        return '<button data-diff="' + d[0] + '" aria-pressed="' + (modOpts.difficulty === d[0]) + '">' + d[1] + '</button>';
      }).join('') + '</div></div>' +
      (native && native.outputFolder ? '<p class="meta">Pasta dos jogos: <b id="outFolder">' + (esc(native.outputFolder()) || 'escolhida ao gerar') +
        '</b> · <button class="linkbtn" id="btnOutFolder">trocar</button></p>' : '') +
      '<div class="stack patchbox">' + (mod.busy ? '<p class="meta">Gerando…</p>' :
        '<button id="btnModBuild">' + (native && native.buildImage ? 'Gerar .bin modificado' : 'Baixar patch .ppf') + '</button>') + '</div>';
  }

  function countTag(o) { var n = Object.keys(o || {}).length; return n ? ' <span class="badge">' + n + ' alterado' + (n > 1 ? 's' : '') + '</span>' : ''; }

  function segOpt(id, label, help, items) {
    return '<div class="opt"><span><b>' + label + '</b><small>' + help + '</small></span><div class="seg">' + items.map(function (it) {
      return '<button data-seg="' + id + '" data-v="' + it[0] + '" aria-pressed="' + (String(modOpts[id]) === String(it[0])) + '">' + it[1] + '</button>';
    }).join('') + '</div></div>';
  }

  function randomizerCard() {
    var r = modOpts.randomizer || {};
    return '<div class="rando' + (r.on ? ' on' : '') + '"><div><b>🎲 Randomizer</b><small>' +
      (r.on ? 'Ligado · semente <b>' + r.seed + '</b>. Cada duelista dropa cartas sorteadas e todas as 722 caem de alguém. É como um jogo novo.'
        : 'Sorteia de novo quem dropa o quê. Todas as 722 cartas caem de alguém. Um jogo novo a cada sorteio.') + '</small></div>' +
      '<div class="rando-actions"><button id="btnRando">' + (r.on ? 'Sortear de novo' : 'Randomizar tudo') + '</button>' +
      (r.on ? '<button class="secondary" id="btnRandoOff">Desligar</button>' : '') + '</div>' +
      (r.on ? '<label class="toggle mini"><span>Sortear também os decks dos duelistas (mantém a força de cada um)</span>' +
        '<input type="checkbox" id="randoDecks"' + (r.decks ? ' checked' : '') + '><i></i></label>' : '') + '</div>';
  }

  // ---- seletor de carta (usado pelos editores)
  var picker = null;
  function cardName(id) { return (mod.ed && mod.ed.names[id - 1]) || (game && game.cards[id - 1].name) || ('Carta ' + id); }
  function thumb(id) { return game ? art(id) : '<span class="art noart">' + id + '</span>'; }
  function cardRow(id, attrs, extra) {
    return '<button class="item" ' + attrs + '>' + thumb(id) + '<span class="grow">' + esc(cardName(id)) + '<small>#' + id + (extra ? ' · ' + extra : '') + '</small></span></button>';
  }
  function openPicker(title, onPick) {
    picker = { title: title, onPick: onPick, q: '' };
    renderPicker();
  }
  function renderPicker(keepFocus) {
    var q = picker.q.trim().toLowerCase(), list = [];
    for (var id = 1; id <= 722 && list.length < 80; id++) {
      if (!q || cardName(id).toLowerCase().indexOf(q) >= 0 || String(id) === q) list.push(id);
    }
    var html = '<h2 style="margin:0 36px 8px 0">' + esc(picker.title) + '</h2>' +
      '<input id="pickQ" class="sheet-search" type="search" placeholder="Buscar carta ou número" value="' + esc(picker.q) + '">' +
      '<div class="list" id="pickList">' + list.map(function (id) { return cardRow(id, 'data-pick="' + id + '"'); }).join('') + '</div>';
    if (keepFocus) { $('pickList').outerHTML = '<div class="list" id="pickList">' + list.map(function (id) { return cardRow(id, 'data-pick="' + id + '"'); }).join('') + '</div>'; }
    else openSheet(html);
  }

  // ---- editor de cartas
  var cardSearch = '';
  function showCardEditorList() {
    picker = null;
    var edited = Object.keys(modOpts.cards || {}).map(Number);
    openSheet('<h2 style="margin:0 36px 4px 0">Editor de cartas</h2><p class="meta">ATK, DEF, nível, tipo, atributo e Guardian Stars de qualquer carta.</p>' +
      '<button id="btnPickCard">Escolher carta para editar</button>' +
      (edited.length ? '<h3>Editadas</h3><div class="list">' + edited.map(function (id) {
        var e = modOpts.cards[id];
        return cardRow(id, 'data-editcard="' + id + '"', (e.atk != null ? e.atk : '?') + '/' + (e.def != null ? e.def : '?'));
      }).join('') + '</div>' : '<p class="meta" style="margin-top:12px">Nenhuma carta editada ainda.</p>'));
  }
  function showCardForm(id) {
    picker = null;
    var cur = FMMod.cardInfo(mod.ed, id), e = Object.assign({}, cur, modOpts.cards[id] || {});
    var sel = function (f, names, from) {
      return '<select data-cf="' + f + '">' + names.map(function (n, i) { return '<option value="' + (i + (from || 0)) + '"' + ((i + (from || 0)) === e[f] ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>';
    };
    var numF = function (f, label, max, step) {
      return '<label class="cf"><span>' + label + '</span><input type="number" inputmode="numeric" data-cf="' + f + '" min="0" max="' + max + '" step="' + step + '" value="' + e[f] + '"></label>';
    };
    openSheet('<div class="hero">' + thumb(id) + '<div><h2>' + esc(cardName(id)) + '</h2><div class="meta">#' + id + ' · original: ' + cur.atk + '/' + cur.def + ', ' +
      esc(FMMod.TYPES[cur.type] || '?') + '</div></div></div>' +
      '<div class="cfgrid" data-cardform="' + id + '">' + numF('atk', 'ATK', 5110, 10) + numF('def', 'DEF', 5110, 10) + numF('level', 'Nível', 12, 1) +
      '<label class="cf"><span>Tipo</span>' + sel('type', FMMod.TYPES) + '</label>' +
      '<label class="cf"><span>Atributo</span>' + sel('attr', FMMod.ATTRS) + '</label>' +
      '<label class="cf"><span>Guardian Star 1</span>' + sel('gs1', FMMod.STARS) + '</label>' +
      '<label class="cf"><span>Guardian Star 2</span>' + sel('gs2', FMMod.STARS) + '</label></div>' +
      '<p class="meta">ATK e DEF vão de 0 a 5110, de 10 em 10. Mudar o tipo de monstro para Magia/Armadilha pode deixar a carta sem efeito.</p>' +
      '<div class="stack"><button data-savecard="' + id + '">Salvar</button>' +
      (modOpts.cards[id] ? '<button class="secondary" data-resetcard="' + id + '">Voltar ao original</button>' : '') +
      '<button class="secondary" id="btnEditCards">Voltar</button></div>');
  }
  function saveCardForm(id) {
    var cur = FMMod.cardInfo(mod.ed, id), out = {}, changed = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-cf]'), function (el) {
      var f = el.dataset.cf, v = parseInt(el.value, 10) || 0;
      if (f === 'atk' || f === 'def') v = Math.max(0, Math.min(5110, Math.round(v / 10) * 10));
      if (f === 'level') v = Math.max(0, Math.min(12, v));
      out[f] = v; if (v !== cur[f]) changed = true;
    });
    if (changed) modOpts.cards[id] = out; else delete modOpts.cards[id];
    saveModOpts(); showCardEditorList(); render();
  }

  // ---- editor de rituais
  function showRitualEditor() {
    picker = null;
    var rows = mod.ed.rituals.map(function (r, i) { return (modOpts.rituals && modOpts.rituals[i]) || r; });
    var slot = function (i, j, id, label) {
      return '<button class="rslot" data-rslot="' + i + ':' + j + '">' + thumb(id) + '<span><small>' + label + '</small>' + esc(cardName(id)) + '</span></button>';
    };
    openSheet('<h2 style="margin:0 36px 4px 0">Editor de rituais</h2><p class="meta">Toque numa carta para trocar. São 24 rituais: carta de ritual + 3 sacrifícios no campo = monstro invocado.</p>' +
      rows.map(function (r, i) {
        return '<div class="rcard' + (modOpts.rituals && modOpts.rituals[i] ? ' edited' : '') + '"><div class="rhead"><b>Ritual ' + (i + 1) + '</b>' +
          (modOpts.rituals && modOpts.rituals[i] ? '<button class="linkbtn" data-rreset="' + i + '">voltar ao original</button>' : '') + '</div>' +
          slot(i, 0, r[0], 'Carta de ritual') + '<div class="rtrib">' + slot(i, 1, r[1], 'Sacrifício') + slot(i, 2, r[2], 'Sacrifício') + slot(i, 3, r[3], 'Sacrifício') + '</div>' +
          slot(i, 4, r[4], 'Invoca') + '</div>';
      }).join(''));
  }

  // ---------- Faça você mesmo (carta com imagem própria) ----------
  var draft = null;

  function quantize(rgba, n) {
    var px = [];
    for (var i = 0; i < rgba.length; i += 4) px.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    var boxes = [px.slice()];
    while (boxes.length < n) {
      var bi = -1, best = -1, ch = 0;
      boxes.forEach(function (b, k) {
        if (b.length < 2) return;
        for (var c = 0; c < 3; c++) {
          var mn = 255, mx = 0;
          b.forEach(function (p) { if (p[c] < mn) mn = p[c]; if (p[c] > mx) mx = p[c]; });
          if (mx - mn > best) { best = mx - mn; bi = k; ch = c; }
        }
      });
      if (bi < 0 || best <= 0) break;
      var b = boxes[bi].sort(function (x, y) { return x[ch] - y[ch]; }), mid = b.length >> 1;
      boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
    }
    var pal = boxes.map(function (b) {
      var r = 0, g = 0, bl = 0; b.forEach(function (p) { r += p[0]; g += p[1]; bl += p[2]; });
      return [r / b.length, g / b.length, bl / b.length];
    });
    while (pal.length < n) pal.push([0, 0, 0]);
    var idx = new Uint8Array(px.length);
    px.forEach(function (p, i) {
      var bd = 1e9, bk = 0;
      for (var k = 0; k < pal.length; k++) {
        var dr = p[0] - pal[k][0], dg = p[1] - pal[k][1], db = p[2] - pal[k][2], d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bk = k; }
      }
      idx[i] = bk;
    });
    var clut = new Uint8Array(n * 2);
    pal.forEach(function (c, k) {
      var v = (Math.round(c[0]) >> 3) | ((Math.round(c[1]) >> 3) << 5) | ((Math.round(c[2]) >> 3) << 10);
      if (v === 0) v = 0x0421; // 0x0000 é transparente no PlayStation
      clut[k * 2] = v & 255; clut[k * 2 + 1] = v >> 8;
    });
    return { idx: idx, clut: clut };
  }

  function drawCover(img, w, h) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d'), r = Math.max(w / img.width, h / img.height);
    var sw = w / r, sh = h / r;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
    return { cv: cv, data: ctx.getImageData(0, 0, w, h).data };
  }

  function packArt(img) {
    var big = drawCover(img, 102, 96), small = drawCover(img, 40, 32);
    var a = quantize(big.data, 256), t = quantize(small.data, 64);
    var art = new Uint8Array(0x2640 + 0x200); art.set(a.idx, 0); art.set(a.clut, 0x2640);
    var th = new Uint8Array(0x500 + 0x80); th.set(t.idx, 0); th.set(t.clut, 0x500);
    return { art: toBase64(art), thumb: toBase64(th), preview: big.cv.toDataURL() };
  }

  function packTitle(name) {
    var cv = document.createElement('canvas'); cv.width = 96; cv.height = 14;
    var ctx = cv.getContext('2d'), size = 11;
    ctx.font = 'bold ' + size + 'px Georgia, serif';
    while (ctx.measureText(name).width > 92 && size > 7) { size--; ctx.font = 'bold ' + size + 'px Georgia, serif'; }
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(name, 3, 11);
    var d = ctx.getImageData(0, 0, 96, 14).data, out = new Uint8Array(0x2A0);
    for (var i = 0; i < 96 * 14; i += 2) {
      var a = Math.round(d[i * 4 + 3] / 255 * 7), b = Math.round(d[(i + 1) * 4 + 3] / 255 * 7);
      out[i >> 1] = a | (b << 4);
    }
    return toBase64(out);
  }

  function showCustomList() {
    picker = null;
    var list = modOpts.custom || [];
    openSheet('<h2 style="margin:0 36px 4px 0">Faça você mesmo</h2><p class="meta">Escolha uma imagem (foto sua, desenho, o que quiser), dê nome e atributos, ' +
      'e ela entra no jogo no lugar de uma carta existente, dropando de quem você escolher.</p>' +
      '<button id="btnNewCustom">Criar carta nova</button>' +
      (list.length ? '<h3>Minhas cartas</h3><div class="list">' + list.map(function (cc, i) {
        return '<button class="item" data-custom="' + i + '"><img class="art" src="' + (cc.preview || '') + '" alt=""><span class="grow">' + esc(cc.name || 'Sem nome') +
          '<small>no lugar de #' + cc.slot + ' ' + esc(cardName(cc.slot)) + ' · ' + cc.atk + '/' + cc.def + '</small></span></button>';
      }).join('') + '</div>' : ''));
  }

  function editCustom(i) {
    var cc = i == null ? null : modOpts.custom[i];
    draft = cc ? JSON.parse(JSON.stringify(cc)) : { slot: 0, name: '', desc: '', atk: 2000, def: 1500, level: 5, type: 0, attr: 0, gs1: 1, gs2: 5, drops: [] };
    draft.index = i;
    renderDraft();
  }

  function renderDraft() {
    picker = null;
    var d = draft, room = d.slot ? FMMod.nameRoom(mod.ed, d.slot) : 0, droom = d.slot ? FMMod.descRoom(mod.ed, d.slot) : 0;
    var sel = function (f, names) {
      return '<select data-df="' + f + '">' + names.map(function (n, i) { return '<option value="' + i + '"' + (i === d[f] ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>';
    };
    var numF = function (f, label, max, step) {
      return '<label class="cf"><span>' + label + '</span><input type="number" inputmode="numeric" data-df="' + f + '" min="0" max="' + max + '" step="' + step + '" value="' + d[f] + '"></label>';
    };
    var duels = mod.ed.duelistNames;
    openSheet('<h2 style="margin:0 36px 8px 0">' + (d.index == null ? 'Nova carta' : 'Editar carta') + '</h2>' +
      '<div class="dimg"><button class="dpick" id="btnImg">' + (d.preview ? '<img src="' + d.preview + '" alt="">' : '<span>Toque para escolher a imagem</span>') + '</button>' +
      '<small class="meta">Vira 102×96 com 256 cores (a miniatura 40×32 é feita junto). Fica no formato da carta: corte central.</small></div>' +
      '<h3>No lugar de qual carta?</h3>' +
      (d.slot ? cardRow(d.slot, 'id="btnSlot"', 'toque para trocar') : '<button class="secondary" id="btnSlot">Escolher a carta que será substituída</button>') +
      '<p class="meta">Dica: escolha uma carta que você não usa. Ela some do jogo e a sua entra no lugar (mesmo número, fusões e senha dela).</p>' +
      '<h3>Dados</h3><div class="cfgrid">' +
      '<label class="cf full"><span>Nome' + (d.slot ? ' (até ' + room + ' letras, sem acento)' : '') + '</span><input type="text" data-df="name" maxlength="' + (room || 40) + '" value="' + esc(d.name) + '"></label>' +
      '<label class="cf full"><span>Descrição' + (d.slot ? ' (até ' + droom + ' letras)' : '') + '</span><textarea data-df="desc" rows="2" maxlength="' + (droom || 200) + '">' + esc(d.desc || '') + '</textarea></label>' +
      numF('atk', 'ATK', 5110, 10) + numF('def', 'DEF', 5110, 10) + numF('level', 'Nível', 12, 1) +
      '<label class="cf"><span>Tipo</span>' + sel('type', FMMod.TYPES.slice(0, 20)) + '</label>' +
      '<label class="cf"><span>Atributo</span>' + sel('attr', FMMod.ATTRS.slice(0, 6)) + '</label>' +
      '<label class="cf"><span>Guardian Star 1</span>' + sel('gs1', FMMod.STARS) + '</label>' +
      '<label class="cf"><span>Guardian Star 2</span>' + sel('gs2', FMMod.STARS) + '</label></div>' +
      '<h3>Quem dropa</h3>' + (d.drops.length ? d.drops.map(function (x, k) {
        return '<div class="droprow"><select data-dd="' + k + ':duelist">' + duels.map(function (n, j) { return '<option value="' + (j + 1) + '"' + (j + 1 === x.duelist ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>' +
          '<select data-dd="' + k + ':pool">' + [['pow', 'S/A POW'], ['bcd', 'B/C/D'], ['tec', 'S/A TEC']].map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === x.pool ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>' +
          '<select data-dd="' + k + ':rate">' + [[8, 'Rara'], [32, 'Incomum'], [128, 'Comum'], [512, 'Muito comum']].map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === x.rate ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('') + '</select>' +
          '<button class="ghost" data-ddel="' + k + '" aria-label="Remover">✕</button></div>';
      }).join('') : '<p class="meta">Ninguém ainda.</p>') +
      '<button class="secondary" id="btnAddDrop">+ Adicionar duelista</button>' +
      '<div class="stack" style="margin-top:16px"><button id="btnSaveCustom">Salvar carta</button>' +
      (d.index != null ? '<button class="secondary" id="btnDelCustom">Apagar esta carta</button>' : '') +
      '<button class="secondary" id="btnCustom">Voltar</button></div>');
  }

  function readDraft() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-df]'), function (el) {
      var f = el.dataset.df;
      draft[f] = (f === 'name' || f === 'desc') ? el.value : (parseInt(el.value, 10) || 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-dd]'), function (el) {
      var p = el.dataset.dd.split(':'), x = draft.drops[+p[0]];
      if (x) x[p[1]] = p[1] === 'pool' ? el.value : parseInt(el.value, 10);
    });
  }

  function saveDraft() {
    readDraft();
    var d = draft;
    if (!d.art) return alert('Escolha uma imagem.');
    if (!d.slot) return alert('Escolha a carta que será substituída.');
    if (!FMMod.plain(d.name).trim()) return alert('Dê um nome para a carta.');
    d.atk = Math.max(0, Math.min(5110, Math.round(d.atk / 10) * 10));
    d.def = Math.max(0, Math.min(5110, Math.round(d.def / 10) * 10));
    d.level = Math.max(1, Math.min(12, d.level));
    d.name = FMMod.plain(d.name).slice(0, FMMod.nameRoom(mod.ed, d.slot));
    d.title = packTitle(d.name);
    var idx = d.index; delete d.index;
    modOpts.custom = modOpts.custom || [];
    if (modOpts.custom.some(function (c, i) { return c.slot === d.slot && i !== idx; })) return alert('Já existe uma carta sua no lugar dessa.');
    if (idx == null) modOpts.custom.push(d); else modOpts.custom[idx] = d;
    saveModOpts(); draft = null; showCustomList(); render();
  }

  // ---------- Deck inicial ----------
  var starterDraft = null;
  var GROUP_NAMES = ['Grupo 1', 'Grupo 2', 'Grupo 3', 'Grupo 4', 'Grupo 5', 'Grupo 6', 'Grupo 7'];
  function showStarter() {
    picker = null;
    if (!starterDraft) starterDraft = JSON.parse(JSON.stringify(modOpts.starter || mod.ed.starter));
    var total = starterDraft.reduce(function (a, g) { return a + (g.count | 0); }, 0);
    openSheet('<h2 style="margin:0 36px 4px 0">Deck inicial</h2>' +
      '<p class="meta">O jogo monta o deck do jogo novo sorteando cartas de 7 grupos. Cada grupo tem quantas cartas sorteia e quais podem sair. ' +
      'Para garantir uma carta, deixe ela sozinha num grupo (ex.: 3 sorteios = 3 cópias). Total obrigatório: 40.</p>' +
      '<p class="total ' + (total === 40 ? 'ok' : 'bad') + '">Total: <b>' + total + '</b> / 40</p>' +
      starterDraft.map(function (g, r) {
        return '<div class="sgroup"><div class="shead"><b>' + GROUP_NAMES[r] + '</b><label>sorteia <input type="number" inputmode="numeric" min="0" max="40" data-scount="' + r + '" value="' + g.count + '"></label></div>' +
          '<div class="schips">' + g.cards.map(function (id) {
            return '<span class="schip">' + thumb(id) + '<span>' + esc(cardName(id)) + '</span><button class="ghost" data-sdel="' + r + ':' + id + '" aria-label="Tirar">✕</button></span>';
          }).join('') + '</div><button class="linkbtn" data-sadd="' + r + '">+ adicionar carta</button>' +
          (g.cards.length > 1 ? ' · <button class="linkbtn" data-sclear="' + r + '">esvaziar</button>' : '') + '</div>';
      }).join('') +
      '<div class="stack"><button id="btnSaveStarter">Salvar deck inicial</button>' +
      '<button class="secondary" id="btnStarterReset">Voltar ao original</button></div>');
  }

  async function modPicked(file) {
    mod.blob = FM.fromFile(file); mod.caps = null; mod.error = ''; render();
    try {
      var ed = await FMMod.open(mod.blob);
      mod.caps = ed.caps; mod.ed = ed;
      ['drops', 'starchips', 'lp', 'deckLimit'].forEach(function (k) {
        if (ed.caps[k] == null) modOpts[k] = null; else if (modOpts[k] == null) modOpts[k] = ed.caps[k];
      });
    } catch (e) { mod.blob = null; mod.error = e.message || String(e); }
    render();
  }

  function toBase64(u8) {
    var s = '', chunk = 0x8000;
    for (var i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    return btoa(s);
  }

  async function modBuild() {
    mod.busy = true; render();
    try {
      var ed = await FMMod.open(mod.blob);
      var log = FMMod.apply(ed, modOpts);
      if (!ed.writes.length) throw new Error('nada para mudar: a base já está com essas opções');
      var res = await FMMod.buildPatch(ed);
      var base = (mod.blob.name || 'jogo').replace(/\.(bin|BIN)$/, '').replace(/ - FM Drops.*$/, '');
      var tag = [modOpts.drops > 1 ? modOpts.drops + ' cartas' : '', modOpts.difficulty !== 'normal' ? modOpts.difficulty : ''].filter(Boolean).join(' ');
      var name = base + ' - FM Drops' + (tag ? ' (' + tag + ')' : '') + '.bin';
      mod.busy = false; render();
      patchBox('<p class="meta">' + esc(log.join(' · ')) + '</p>');
      if (native && native.buildImage) native.buildImage(toBase64(res.ppf), name);
      else {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([res.ppf])); a.download = name.replace(/\.bin$/, '.ppf'); a.click();
        patchBox('<p class="note">Patch baixado. Aplique no .bin com um aplicador de PPF.</p>');
      }
    } catch (e) {
      mod.busy = false; render();
      patchBox('<p class="error">' + esc(e.message || String(e)) + '</p><button id="btnModBuild">Tentar de novo</button>');
    }
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
    else if (/^tab(Cards|Fusions|Duelists|Mod)$/.test(t.id)) { view = t.id.slice(3).toLowerCase(); window.scrollTo(0, 0); render(); }
    else if (t.id === 'btnModPick') { $('modFile').value = ''; $('modFile').click(); }
    else if (t.id === 'btnModBuild') modBuild();
    else if (t.id === 'btnOutFolder') native.chooseOutputFolder();
    else if (t.dataset.seg) { var sv = t.dataset.v; modOpts[t.dataset.seg] = /^\d+$/.test(sv) ? +sv : sv; saveModOpts(); render(); }
    else if (t.id === 'btnRando') { modOpts.randomizer = { on: true, seed: 1 + Math.floor(Math.random() * 999999), decks: !!(modOpts.randomizer && modOpts.randomizer.decks) }; saveModOpts(); render(); }
    else if (t.id === 'btnRandoOff') { modOpts.randomizer.on = false; saveModOpts(); render(); }
    else if (t.id === 'btnEditCards') showCardEditorList();
    else if (t.id === 'btnPickCard') openPicker('Qual carta editar?', function (id) { showCardForm(id); });
    else if (t.dataset.editcard) showCardForm(+t.dataset.editcard);
    else if (t.dataset.savecard) saveCardForm(+t.dataset.savecard);
    else if (t.dataset.resetcard) { delete modOpts.cards[+t.dataset.resetcard]; saveModOpts(); showCardEditorList(); render(); }
    else if (t.id === 'btnEditRituals') showRitualEditor();
    else if (t.dataset.rslot) {
      var ij = t.dataset.rslot.split(':').map(Number);
      openPicker(['Carta de ritual', 'Sacrifício 1', 'Sacrifício 2', 'Sacrifício 3', 'Monstro invocado'][ij[1]] + ' · Ritual ' + (ij[0] + 1), function (id) {
        var row = ((modOpts.rituals && modOpts.rituals[ij[0]]) || mod.ed.rituals[ij[0]]).slice();
        row[ij[1]] = id;
        modOpts.rituals = modOpts.rituals || {};
        if (row.join() === mod.ed.rituals[ij[0]].join()) delete modOpts.rituals[ij[0]]; else modOpts.rituals[ij[0]] = row;
        saveModOpts(); showRitualEditor(); render();
      });
    }
    else if (t.dataset.rreset) { delete modOpts.rituals[+t.dataset.rreset]; saveModOpts(); showRitualEditor(); render(); }
    else if (t.id === 'btnCustom') { draft = null; showCustomList(); }
    else if (t.id === 'btnNewCustom') editCustom(null);
    else if (t.dataset.custom) editCustom(+t.dataset.custom);
    else if (t.id === 'btnImg') { readDraft(); $('imgFile').value = ''; $('imgFile').click(); }
    else if (t.id === 'btnSlot') { readDraft(); openPicker('Substituir qual carta?', function (id) { draft.slot = id; renderDraft(); }); }
    else if (t.id === 'btnAddDrop') { readDraft(); draft.drops.push({ duelist: 1, pool: 'pow', rate: 32 }); renderDraft(); }
    else if (t.dataset.ddel) { readDraft(); draft.drops.splice(+t.dataset.ddel, 1); renderDraft(); }
    else if (t.id === 'btnSaveCustom') saveDraft();
    else if (t.id === 'btnDelCustom') { if (confirm('Apagar esta carta?')) { modOpts.custom.splice(draft.index, 1); saveModOpts(); draft = null; showCustomList(); render(); } }
    else if (t.id === 'btnStarter') { starterDraft = null; showStarter(); }
    else if (t.dataset.sadd) { var gr = +t.dataset.sadd; openPicker('Adicionar ao ' + GROUP_NAMES[gr], function (id) {
        if (id > 720) alert('As cartas 721 e 722 não podem entrar no deck inicial.');
        else if (starterDraft[gr].cards.indexOf(id) < 0) starterDraft[gr].cards.push(id);
        showStarter(); }); }
    else if (t.dataset.sdel) { var sp = t.dataset.sdel.split(':').map(Number); starterDraft[sp[0]].cards = starterDraft[sp[0]].cards.filter(function (x) { return x !== sp[1]; }); showStarter(); }
    else if (t.dataset.sclear) { starterDraft[+t.dataset.sclear].cards = []; showStarter(); }
    else if (t.id === 'btnStarterReset') { modOpts.starter = null; starterDraft = null; saveModOpts(); showStarter(); render(); }
    else if (t.id === 'btnSaveStarter') {
      var tot = starterDraft.reduce(function (a, g) { return a + (g.count | 0); }, 0);
      if (tot !== 40) alert('O total de sorteios precisa ser 40 (agora: ' + tot + ').');
      else if (starterDraft.some(function (g) { return !g.cards.length; })) alert('Todo grupo precisa ter pelo menos uma carta.');
      else { modOpts.starter = JSON.stringify(starterDraft) === JSON.stringify(mod.ed.starter) ? null : starterDraft; saveModOpts(); starterDraft = null; closeSheet(); render(); }
    }
    else if (t.dataset.pick && picker) { var cb = picker.onPick; picker = null; cb(+t.dataset.pick); }
    else if (t.dataset.preset) {
      var pr = FMMod.PRESETS[t.dataset.preset];
      Object.keys(pr).forEach(function (k) { if (!(mod.caps && ['drops', 'starchips', 'lp', 'freeDuel'].indexOf(k) >= 0 && mod.caps[k] == null)) modOpts[k] = pr[k]; });
      saveModOpts(); render();
    }
    else if (t.dataset.quick) { modOpts[t.dataset.quick] = +t.dataset.v; saveModOpts(); render(); }
    else if (t.dataset.diff) { modOpts.difficulty = t.dataset.diff; saveModOpts(); render(); }
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
  $('imgFile').addEventListener('change', function () {
    var f = this.files[0]; if (!f || !draft) return;
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () { var p = packArt(img); draft.art = p.art; draft.thumb = p.thumb; draft.preview = p.preview; URL.revokeObjectURL(url); renderDraft(); };
    img.onerror = function () { alert('Não consegui abrir essa imagem.'); };
    img.src = url;
  });
  $('modFile').addEventListener('change', function () { if (this.files.length) modPicked(this.files[0]); });
  $('search').addEventListener('input', function () { query = this.value; render(); });
  document.addEventListener('input', function (ev) { if (ev.target.id === 'pickQ' && picker) { picker.q = ev.target.value; renderPicker(true); } });
  document.addEventListener('change', function (ev) {
    if (ev.target.classList.contains('modnum')) {
      var v = parseInt(ev.target.value, 10), mn = +ev.target.min, mx = +ev.target.max;
      modOpts[ev.target.id] = isNaN(v) ? mn : Math.max(mn, Math.min(mx, v)); saveModOpts(); render(); return;
    }
    if (ev.target.classList.contains('modtog')) { modOpts[ev.target.id] = ev.target.checked; saveModOpts(); return; }
    if (ev.target.dataset && ev.target.dataset.scount != null && starterDraft) { starterDraft[+ev.target.dataset.scount].count = Math.max(0, Math.min(40, parseInt(ev.target.value, 10) || 0)); showStarter(); return; }
    if (ev.target.id === 'randoDecks') { modOpts.randomizer.decks = ev.target.checked; saveModOpts(); return; }
    if (ev.target.id !== 'perDuel') return;
    try { localStorage.setItem('perDuel', Math.max(1, parseInt(ev.target.value, 10) || 1)); } catch (e) {}
  });

  boot();
  window.__fmBooted = true;
  // Aviso discreto no topo quando existe versão nova.
  findUpdate().then(function (u) { if (u.newer) $('updBadge').hidden = false; }).catch(function () {});
})();
