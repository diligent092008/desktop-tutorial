/* 조일ver1 — 화면 로직 */
(function () {
  'use strict';

  var API_URL = (window.JOIL_CONFIG && window.JOIL_CONFIG.API_URL) || '';
  var DEMO = !API_URL;
  var app = document.getElementById('app');

  var state = {
    token: storage('get', 'joil-token'),
    user: null,
    pub: null,
    view: 'calc',
    calc: { origin: '', dest: '', dieselMode: null, dieselPrice: '', baseTon: null, tons: null, result: null },
    hist: { days: 30, type: '', userId: '', q: '', logs: null, users: null, detail: null, detailData: null },
    quotes: { q: '', status: '', list: null, detail: null, detailData: null },
    an: null,
    bulk: { mode: 'one', origin: '', dests: '', pairsText: '', results: [], running: false, cancel: false, page: 0, sort: 'no', search: '', filter: 'all', detail: true, meta: null, opts: null },
    admin: { tab: 'basic', settings: null, keys: null, tariff: null, tariffDirty: false, settingsDirty: false, page: 0, users: null, logs: null }
  };

  /* ───────── 도구 ───────── */

  function storage(op, key, value) {
    try {
      if (op === 'get') return sessionStorage.getItem(key);
      if (op === 'set') sessionStorage.setItem(key, value);
      if (op === 'del') sessionStorage.removeItem(key);
    } catch (e) { /* 사생활 보호 모드 등 */ }
    return null;
  }
  function local(op, key, value) {
    try {
      if (op === 'get') return JSON.parse(localStorage.getItem(key) || 'null');
      if (op === 'set') localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 무시 */ }
    return null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function won(n) { return n == null || n === '' ? '–' : Number(n).toLocaleString('ko-KR'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  /** 메뉴 권한: quote(견적 계산·조회기록·견적모음) / analysis(매출매입 분석) / admin */
  function can(perm) {
    var u = state.user; if (!u) return false;
    if (u.role === 'admin') return true;
    return (u.perms || ['quote']).indexOf(perm) !== -1;
  }
  function defaultView() { return can('quote') ? 'calc' : can('analysis') ? 'analysis' : 'none'; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* 서버 요청
   * - 조회성 요청(READ)은 오류·지연 시 1번 자동 재시도, 같은 요청이 동시에 겹치면 하나로 합침
   * - 저장·변경 요청은 중복 실행을 막기 위해 재시도하지 않음
   */
  var READ_ACTIONS = ['me', 'publicSettings', 'dieselPrice', 'admin.bootstrap', 'admin.getSettings', 'admin.getTariff', 'admin.listUsers', 'admin.getLogs', 'admin.cacheInfo', 'history.list', 'history.get', 'quotes.list', 'quotes.get', 'analysis.index', 'analysis.load', 'analysis.accessLog', 'admin.dieselHistory'];
  var TIMEOUT_MS = 25000;
  var inflight = {};

  function sendOnce(req) {
    if (DEMO) return window.JoilDemo.call(req);
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, /^(quoteBatch|admin\.saveTariff|analysis\.upload|analysis\.load)$/.test(req.action) ? 120000 : TIMEOUT_MS) : null;
    // 캐시·쿠키가 끼어들지 않도록: 매번 고유 주소, 캐시 사용 안 함, 쿠키 안 보냄
    return fetch(API_URL + (API_URL.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now() + Math.random().toString(36).slice(2, 6), {
      method: 'POST', body: JSON.stringify(req), cache: 'no-store', credentials: 'omit', redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw retryable('서버 연결 오류 (' + res.status + ')');
        return res.text();
      })
      .then(function (text) {
        try { return JSON.parse(text); } catch (e) {
          throw retryable('서버가 잠시 응답하지 못했습니다. 잠시 후 다시 시도하세요.');
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw retryable('서버 응답이 너무 늦습니다. 잠시 후 다시 시도하세요.');
        if (err && /Failed to fetch|NetworkError|Load failed/.test(err.message)) throw retryable('서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.');
        throw err;
      })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        if (!data.ok) throw new Error(data.error || '알 수 없는 오류');
        return data;
      }, function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
  }

  function retryable(msg) { var e = new Error(msg); e.retry = true; return e; }

  function api(action, payload) {
    var req = Object.assign({ action: action, token: state.token }, payload || {});
    var isRead = READ_ACTIONS.indexOf(action) !== -1;
    var key = isRead ? JSON.stringify(req) : null;
    if (key && inflight[key]) return inflight[key];

    var p = sendOnce(req).catch(function (err) {
      if (!isRead || !err.retry) throw err;
      return new Promise(function (r) { setTimeout(r, 900); }).then(function () { return sendOnce(req); });
    });
    p = p.catch(function (err) {
      var msg = (err && err.message) || String(err);
      if (/알 수 없는 요청/.test(msg)) msg = '서버 코드가 예전 버전입니다. 관리자가 Apps Script 코드를 최신으로 바꾸고 새 버전으로 배포해야 합니다. (SETUP.md "업데이트가 나왔을 때")';
      if (/로그인이 만료|로그인이 필요|사용이 중지/.test(msg) && action !== 'login') {
        clearSession();
        toast(msg, 'err');
        render();
      }
      throw new Error(msg);
    });
    if (key) {
      inflight[key] = p;
      var clear = function () { delete inflight[key]; };
      p.then(clear, clear);
    }
    return p;
  }


  function toast(msg, type) {
    var box = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'ok');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('leave'); setTimeout(function () { el.remove(); }, 300); }, type === 'err' ? 4200 : 2600);
  }

  function modal(opts) {
    var wrap = document.createElement('div');
    wrap.className = 'backdrop';
    wrap.innerHTML =
      '<div class="modal ' + (opts.wide ? 'wide' : '') + '" role="dialog" aria-modal="true">' +
      '<div class="head"><div class="eyebrow">' + esc(opts.eyebrow || '안내') + '</div><h2>' + esc(opts.title) + '</h2></div>' +
      '<div class="body">' + opts.body + '</div>' +
      '<div class="foot">' + (opts.foot || '<button class="btn btn-primary" data-close>확인</button>') + '</div></div>';
    document.body.appendChild(wrap);
    function close() { wrap.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape' && !opts.locked) close(); }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap && !opts.locked) close();
      if (e.target.closest('[data-close]')) close();
    });
    if (opts.onMount) opts.onMount(wrap.querySelector('.modal'), close);
    var first = wrap.querySelector('input, textarea, select');
    if (first) setTimeout(function () { first.focus(); }, 60);
    return close;
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + esc(label || '처리 중…');
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  function countUp(el, target) {
    if (target == null) return;
    var start = performance.now(), dur = 650;
    function step(t) {
      var p = Math.min(1, (t - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = won(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step); else el.textContent = won(target);
    }
    requestAnimationFrame(step);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  function downloadCsv(filename, rows) {
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        c = c == null ? '' : String(c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\r\n');
    saveBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  function saveBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /* ───────── 세션 ───────── */

  function clearSession() {
    state.token = null; state.user = null; state.pub = null;
    state.admin = { tab: 'basic', loaded: false, settings: null, keys: null, tariff: null, tariffDirty: false, settingsDirty: false, page: 0, users: null, logs: null, cache: null };
    state.calc.result = null;
    state.calc.baseTon = null;
    state.bulk.results = []; state.bulk.meta = null; state.bulk.cancel = true; state.bulk.recordId = null;
    state.calc.recordId = null;
    state.hist = { days: 30, type: '', userId: '', q: '', logs: null, users: null, detail: null, detailData: null };
    state.quotes = { q: '', status: '', list: null, detail: null, detailData: null };
    state.an = newAnState();
    storage('del', 'joil-token');
  }

  function afterLogin(settings) {
    return (settings ? Promise.resolve({ settings: settings }) : api('publicSettings')).then(function (r) {
      state.pub = r.settings;
      var saved = local('get', 'joil-tons');
      state.calc.tons = Array.isArray(saved) ? saved.filter(function (t) { return state.pub.tons.indexOf(t) !== -1; }) : state.pub.tons.slice();
      if (!state.calc.tons.length) state.calc.tons = state.pub.tons.slice();
      state.calc.dieselMode = state.pub.fuelMode === 'auto' ? 'auto' : 'manual';
      state.calc.dieselPrice = state.pub.manualPrice;
      state.calc.baseTon = state.pub.tons.indexOf(state.calc.baseTon) !== -1 ? state.calc.baseTon : state.pub.baseTon;
      render();
      if (state.user.mustChange) openChangePassword(true);
    });
  }

  /* ───────── 렌더 ───────── */

  function navItems() {
    var items = [];
    if (can('quote')) items.push(['calc', '단건 계산'], ['bulk', '대량 계산'], ['history', '조회기록'], ['quotes', '견적모음']);
    if (can('analysis')) items.push(['analysis', '분석']);
    if (state.user.role === 'admin') items.push(['admin', '관리자']);
    return items;
  }

  function render() {
    if (!state.user) return renderLogin();
    if (state.pub && !navItems().some(function (n) { return n[0] === state.view; })) state.view = defaultView();
    if (!state.pub) { app.innerHTML = '<div class="login-wrap"><div class="muted">불러오는 중…</div></div>'; return; }
    app.innerHTML =
      '<header class="topbar"><div class="stripe-bar"></div><div class="row">' +
      '<div class="brand"><span class="logo"></span>조일ver1</div>' +
      '<nav class="nav">' +
      navItems().map(function (n) { return '<button data-view="' + n[0] + '" class="' + (state.view === n[0] ? 'on' : '') + '">' + n[1] + '</button>'; }).join('') +
      '</nav><div class="spacer"></div>' +
      '<div class="user-chip">' + (DEMO ? '<span class="badge region">데모</span>' : '') +
      (state.user.role === 'admin' ? '<span class="role-badge">ADMIN</span>' : '') +
      '<span class="avatar">' + esc(String(state.user.name || state.user.id).charAt(0)) + '</span>' +
      '<span class="name">' + esc(state.user.name) + '</span>' +
      '<button class="btn btn-ghost btn-sm" data-act="pw">비밀번호</button>' +
      '<button class="btn btn-sm" data-act="logout">로그아웃</button></div>' +
      '</div></header><main id="main"></main>';

    $$('.nav button').forEach(function (b) {
      b.onclick = function () {
        if (state.view === 'admin' && b.dataset.view !== 'admin' && (state.admin.tariffDirty || state.admin.settingsDirty || (state.admin.anMap && state.admin.anMap.dirty) || (state.admin.anRules && state.admin.anRules.dirty)) &&
          !confirm('저장하지 않은 관리자 변경사항이 있습니다. 이동할까요? (변경사항은 화면에 남아 있습니다)')) return;
        // 같은 메뉴를 다시 누르면 상세 화면에서 목록으로
        if (state.view === b.dataset.view) {
          if (state.view === 'history') { state.hist.detail = null; state.hist.logs = null; }
          if (state.view === 'quotes') { state.quotes.detail = null; state.quotes.list = null; }
        }
        if (b.dataset.view === 'history' && state.view !== 'history') state.hist.logs = null;
        state.view = b.dataset.view; render();
      };
    });
    $('[data-act="logout"]').onclick = function () {
      api('logout').catch(function () { });
      clearSession(); render();
    };
    $('[data-act="pw"]').onclick = function () { openChangePassword(false); };

    if (state.view === 'none') {
      $('#main').innerHTML = '<div class="card empty"><div><div class="big-stripes"></div><h3>사용할 수 있는 메뉴가 없어요</h3><p class="muted" style="margin:0">관리자에게 메뉴 권한을 요청하세요.</p></div></div>';
      return;
    }
    if (state.view === 'admin' && state.user.role === 'admin') renderAdmin();
    else if (state.view === 'analysis') renderAnalysis();
    else if (state.view === 'bulk') renderBulk();
    else if (state.view === 'history') renderHistory();
    else if (state.view === 'quotes') renderQuotes();
    else renderCalc();
  }

  /* ───────── 로그인 ───────── */

  function renderLogin() {
    app.innerHTML =
      '<div class="login-wrap"><div class="card login-card"><div class="stripe-bar"></div><div class="inner">' +
      '<div class="brand-big"><span class="logo"></span><div><h1>조일ver1</h1><p>운임 견적 계산기</p></div></div>' +
      (DEMO ? '<div class="demo-banner"><b>데모 모드</b><span>서버가 연결되지 않아 임의 단가로 동작합니다.<br>아이디 <b>admin</b> / 비밀번호 <b>demo1234</b></span></div>' : '') +
      '<form id="loginForm">' +
      '<div class="field"><label for="lid">아이디</label><input class="input" id="lid" autocomplete="username" required></div>' +
      '<div class="field"><label for="lpw">비밀번호</label><input class="input" id="lpw" type="password" autocomplete="current-password" required></div>' +
      '<div class="section-gap"></div>' +
      '<button class="btn btn-primary btn-lg" type="submit">로그인</button>' +
      '<p class="hint" style="text-align:center;margin:16px 0 0">계정이 없으면 관리자에게 발급을 요청하세요.</p>' +
      '</form></div></div></div>';
    $('#lid').focus();
    $('#loginForm').onsubmit = function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('button[type=submit]');
      busy(btn, true, '확인 중…');
      api('login', { id: $('#lid').value, password: $('#lpw').value }).then(function (r) {
        state.token = r.token; state.user = r.user;
        storage('set', 'joil-token', r.token);
        state.view = defaultView();
        return afterLogin(r.settings);
      }).catch(function (err) {
        busy(btn, false);
        toast(err.message, 'err');
        $('#lpw').value = ''; $('#lpw').focus();
      });
    };
  }

  function openChangePassword(forced) {
    modal({
      eyebrow: forced ? '첫 로그인' : '계정',
      title: forced ? '새 비밀번호를 설정하세요' : '비밀번호 변경',
      locked: forced,
      body:
        (forced ? '<p class="muted small" style="margin:0 0 14px">임시 비밀번호로 로그인했습니다. 계속하려면 비밀번호를 바꿔 주세요.</p>' : '') +
        '<div class="field"><label>현재 비밀번호</label><input class="input" type="password" id="pwCur" autocomplete="current-password"></div>' +
        '<div class="field"><label>새 비밀번호</label><input class="input" type="password" id="pwNew" autocomplete="new-password"><span class="hint">영문 + 숫자 포함 8자 이상</span></div>' +
        '<div class="field"><label>새 비밀번호 확인</label><input class="input" type="password" id="pwNew2" autocomplete="new-password"></div>',
      foot: (forced ? '' : '<button class="btn" data-close>취소</button>') + '<button class="btn btn-primary" id="pwSave">변경</button>',
      onMount: function (m, close) {
        $('#pwSave', m).onclick = function () {
          var a = $('#pwNew', m).value, b = $('#pwNew2', m).value;
          if (a !== b) return toast('새 비밀번호가 서로 다릅니다.', 'err');
          var btn = this;
          busy(btn, true);
          api('changePassword', { current: $('#pwCur', m).value, next: a }).then(function () {
            var wasForced = state.user.mustChange;
            state.user.mustChange = false;
            close(); toast('비밀번호를 변경했습니다.');
            if (wasForced) render();
          }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
        };
      }
    });
  }

  /* ───────── 견적 공통 입력 (단건·대량 공용) ───────── */

  function optionsHtml() {
    var c = state.calc;
    return '<div class="row-between" style="margin-bottom:10px"><div class="eyebrow" style="margin:0">Milk-run · 밀크런 기준</div>' +
      '<span class="hint">' + (state.pub.roundTrip ? '왕복' : '편도') + ' 기준</span></div>' +
      '<div class="opt-grid">' +
      '<div class="field"><label for="baseTon">기준 톤수</label><select class="input" id="baseTon">' + state.pub.tons.map(function (t) {
        return '<option' + (t === c.baseTon ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>경유가</label><div class="segmented" id="dieselSeg"><button type="button" data-m="auto" class="' + (c.dieselMode === 'auto' ? 'on' : '') + '">자동</button><button type="button" data-m="manual" class="' + (c.dieselMode === 'manual' ? 'on' : '') + '">직접</button></div></div>' +
      '</div>' +
      '<div class="field ' + (c.dieselMode === 'manual' ? '' : 'hidden') + '" id="dieselField"><input class="input num" id="dieselPrice" type="number" min="0" step="1" value="' + esc(c.dieselPrice) + '" placeholder="원/L" aria-label="경유가 원/L"><span class="hint">원/L 기준 · 밀크런 유류비 계산에만 쓰입니다</span></div>' +
      '<p class="hint ' + (c.dieselMode === 'auto' ? '' : 'hidden') + '" id="dieselHint" style="margin:-4px 0 14px">관리자 설정의 자동 조회(오피넷) 또는 기본값을 사용합니다.</p>' +
      '<div class="row-between" style="margin-bottom:10px"><div class="eyebrow" style="margin:0">Tonnage · 표시할 톤수</div>' +
      '<div><button type="button" class="btn btn-ghost btn-sm" id="tonAll">전체</button><button type="button" class="btn btn-ghost btn-sm" id="tonNone">해제</button></div></div>' +
      '<div class="chips" id="tonChips">' + state.pub.tons.map(function (t) {
        return '<button type="button" class="chip ' + (c.tons.indexOf(t) !== -1 ? 'on' : '') + '" data-t="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div>';
  }

  function bindOptions(onTonsChange) {
    var c = state.calc;
    $('#baseTon').onchange = function () { c.baseTon = this.value; };
    $('#dieselPrice').oninput = function () { c.dieselPrice = this.value; };
    $$('#dieselSeg button').forEach(function (b) {
      b.onclick = function () {
        c.dieselMode = b.dataset.m;
        $$('#dieselSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $('#dieselField').classList.toggle('hidden', c.dieselMode !== 'manual');
        $('#dieselHint').classList.toggle('hidden', c.dieselMode !== 'auto');
      };
    });
    function setTons(list) {
      c.tons = list;
      local('set', 'joil-tons', list);
      $$('#tonChips .chip').forEach(function (ch) { ch.classList.toggle('on', list.indexOf(ch.dataset.t) !== -1); });
      onTonsChange();
    }
    $$('#tonChips .chip').forEach(function (ch) {
      ch.onclick = function () {
        var t = ch.dataset.t, list = c.tons.slice(), i = list.indexOf(t);
        if (i === -1) list.push(t); else list.splice(i, 1);
        setTons(state.pub.tons.filter(function (x) { return list.indexOf(x) !== -1; }));
      };
    });
    $('#tonAll').onclick = function () { setTons(state.pub.tons.slice()); };
    $('#tonNone').onclick = function () { setTons([]); };
  }

  function quoteOptions() {
    var c = state.calc;
    return { dieselMode: c.dieselMode, dieselPrice: Number(c.dieselPrice), baseTon: c.baseTon };
  }

  function checkOptions() {
    var c = state.calc;
    if (c.dieselMode === 'manual' && !(Number(c.dieselPrice) > 0)) { toast('경유가를 입력하세요.', 'err'); return false; }
    return true;
  }

  function regionText(r) {
    return r.regionHits.length ? r.regionHits.map(function (h) { return h.point.replace('지', '') + '·' + h.name + ' ' + won(h.amount); }).join(', ') : '';
  }

  /* ───────── 엑셀 (.xlsx) ───────── */

  var xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { xlsxLoading = null; reject(new Error('엑셀 기능을 불러오지 못했습니다. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  /** sheets: [{ name, rows: [[...]], widths: [..], moneyFrom: 헤더 다음 줄부터 숫자 칸에 #,##0 }] */
  function downloadXlsx(filename, sheets) {
    return loadXlsx().then(function (X) {
      var wb = X.utils.book_new();
      sheets.forEach(function (sh) {
        var ws = X.utils.aoa_to_sheet(sh.rows);
        if (sh.widths) ws['!cols'] = sh.widths.map(function (w) { return { wch: w }; });
        Object.keys(ws).forEach(function (addr) {
          if (addr.charAt(0) === '!') return;
          var cell = ws[addr];
          if (cell.t === 'n' && Math.abs(cell.v) >= 1000) cell.z = '#,##0';
        });
        X.utils.book_append_sheet(wb, ws, sh.name);
      });
      // writeFile 대신 직접 내려받기 링크를 만들어 파일 이름이 확실히 적용되도록
      var data = X.write(wb, { bookType: 'xlsx', type: 'array' });
      saveBlob(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
    });
  }

  /* ───────── 단건 계산 ───────── */

  function renderCalc() {
    var c = state.calc;
    $('#main').innerHTML =
      '<div class="calc-grid">' +
      '<form class="card" id="calcForm" autocomplete="off">' +
      '<div class="eyebrow">Route · 경로</div><h2 style="margin-bottom:18px">단건 견적</h2>' +
      '<div class="route-inputs">' +
      '<div class="field"><label for="origin"><span class="pin from"></span>상차지</label><input class="input" id="origin" placeholder="예) 경기 평택시 포승읍 평택항로 …" value="' + esc(c.origin) + '"></div>' +
      '<button type="button" class="swap-btn" id="swap" title="상차지·하차지 바꾸기" aria-label="상차지와 하차지 바꾸기">⇅</button>' +
      '<div class="field"><label for="dest"><span class="pin to"></span>하차지</label><input class="input" id="dest" placeholder="예) 부산 강서구 녹산산단 …" value="' + esc(c.dest) + '"></div>' +
      '</div><div class="section-gap"></div>' +
      optionsHtml() +
      '<div class="section-gap"></div><div class="section-gap"></div>' +
      '<button class="btn btn-accent btn-lg" type="submit" id="calcBtn">견적 계산하기</button>' +
      '</form>' +
      '<div id="result"></div></div>';

    $('#origin').oninput = function () { c.origin = this.value; };
    $('#dest').oninput = function () { c.dest = this.value; };
    $('#swap').onclick = function () {
      var o = c.origin; c.origin = c.dest; c.dest = o;
      $('#origin').value = c.origin; $('#dest').value = c.dest;
    };
    bindOptions(function () { if (c.result) renderResult(false); });

    $('#calcForm').onsubmit = function (e) {
      e.preventDefault();
      if (!c.origin.trim() || !c.dest.trim()) return toast('상차지와 하차지를 모두 입력하세요.', 'err');
      if (!checkOptions()) return;
      var btn = $('#calcBtn');
      busy(btn, true, '경로 조회 중…');
      api('quote', Object.assign({ origin: c.origin, dest: c.dest }, quoteOptions()))
        .then(function (r) {
          if (!r.result.milkrun) throw new Error('서버 코드가 예전 버전입니다. 관리자가 Apps Script 코드를 최신으로 바꾸고 새 버전으로 배포해야 합니다. (SETUP.md "업데이트가 나왔을 때")');
          c.result = r.result; c.recordId = r.recordId || null; renderResult(true);
        })
        .catch(function (err) { toast(err.message, 'err'); })
        .then(function () { busy(btn, false); });
    };

    if (c.result) renderResult(false); else renderEmpty();
  }

  function renderEmpty() {
    $('#result').innerHTML =
      '<div class="card empty" style="--i:1"><div><div class="big-stripes"></div>' +
      '<h3>주소를 넣고 계산해 보세요</h3>' +
      '<p class="muted" style="margin:0">톤수별 운임과 밀크런 유류비·통행료가 한 번에 나옵니다.<br>여러 곳을 한꺼번에 계산하려면 위쪽 <b>대량 계산</b>을 이용하세요.</p>' +
      (DEMO ? '<p class="hint" style="margin-top:14px">데모 모드: 서울, 평택, 부산, 강릉, 목포 같은 도시명으로 시험할 수 있어요.</p>' : '') +
      '</div></div>';
  }

  function milkrunCard(r, i) {
    var m = r.milkrun;
    return '<div class="card milkrun" style="--i:' + i + '">' +
      '<div class="row-between" style="margin-bottom:14px;flex-wrap:wrap"><div><div class="eyebrow">Milk-run · 밀크런</div>' +
      '<h3>기준 ' + esc(m.ton) + ' · ' + (m.roundTrip ? '왕복' : '편도') + '</h3></div>' +
      '<div class="mr-total"><span class="k">유류비 + 통행료</span><span class="num" data-total="' + m.total + '">' + won(m.total) + '</span><span class="small">원</span></div></div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">운행 거리</div><div class="v num">' + m.distanceKm + '<span class="small"> km</span></div></div>' +
      '<div class="stat"><div class="k">연비</div><div class="v num">' + m.kmPerL + '<span class="small"> km/L</span></div><div class="s">' + m.liters + 'L 소모</div></div>' +
      '<div class="stat"><div class="k">경유가</div><div class="v num">' + won(m.dieselPrice) + '<span class="small"> 원/L</span></div><div class="s">' + esc(r.dieselSource || '') + '</div></div>' +
      '<div class="stat"><div class="k">유류비</div><div class="v num">' + won(m.fuel) + '<span class="small"> 원</span></div></div>' +
      '<div class="stat"><div class="k">통행료 (' + m.tollClass + '종)</div><div class="v num">' + won(m.toll) + '<span class="small"> 원</span></div></div>' +
      '</div></div>';
  }

  function renderResult(animate) {
    renderSingleView(state.calc.result, $('#result'), {
      tons: state.calc.tons, animate: animate, recordId: state.calc.recordId, emptyHint: '왼쪽에서 톤수를 골라 주세요.'
    });
  }

  /**
   * 단건 결과 화면 (계산 직후 · 조회기록 상세 · 견적모음 상세 공용)
   * opts: { tons, animate, recordId(있으면 "견적으로 저장" 버튼), emptyHint }
   */
  function renderSingleView(r, box, opts) {
    var rows = r.rows.filter(function (row) { return opts.tons.indexOf(row.ton) !== -1; });
    var regionHtml = r.regionHits.length
      ? r.regionHits.map(function (h) { return '<span class="badge region">' + esc(h.point.replace('지', '')) + '·' + esc(h.name) + ' +' + won(h.amount) + '</span>'; }).join('')
      : '<span class="muted">없음</span>';
    var dirHtml = r.direction === '하행'
      ? '<span class="badge down">▼ 하행' + (r.downhillApplied ? ' +' + r.downhillPercent + '%' : '') + '</span>' + (r.downhillApplied ? '' : '<div class="s">할증 미적용</div>')
      : '<span class="badge up">▲ 상행</span>';

    var html =
      '<div class="card summary" style="--i:0">' +
      '<div class="route"><div class="place"><div class="lbl"><span class="pin from"></span>상차지</div><div class="addr">' + esc(r.origin.address) + '</div></div>' +
      '<div class="arrow">→</div>' +
      '<div class="place"><div class="lbl"><span class="pin to"></span>하차지</div><div class="addr">' + esc(r.dest.address) + '</div></div></div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">거리</div><div class="v num">' + r.distanceKm + '<span class="small"> km</span></div><div class="s">요금 기준 ' + r.km + 'km</div></div>' +
      '<div class="stat"><div class="k">방향</div><div class="v" style="font-size:15px">' + dirHtml + '</div></div>' +
      '<div class="stat wide"><div class="k">지역 할증 (합산 ' + won(r.regionTotal) + '원)</div><div class="v" style="font-size:14px;font-weight:600">' + regionHtml + '</div></div>' +
      '</div></div>';

    if (r.overMax) {
      html += '<div class="over-max" style="margin-top:16px;animation:rise .45s var(--ease) both"><h3>' + r.maxKm + 'km 초과 — 별도 문의</h3>' +
        '<p class="muted" style="margin:0">요금 기준 거리 ' + r.km + 'km는 타리프 범위를 넘어 톤수별 자동 견적을 낼 수 없습니다. (밀크런 정보는 아래 참고)</p></div>';
    } else {
      html +=
        '<div class="card" style="--i:1;margin-top:16px">' +
        '<div class="row-between" style="margin-bottom:14px;flex-wrap:wrap"><div><div class="eyebrow">Quote · 톤수별 견적</div><h3>' + rows.length + '개 톤수</h3></div>' +
        '<div class="actions">' + (opts.recordId ? '<button class="btn btn-sm btn-primary" data-act="saveQuote">견적으로 저장</button>' : '') +
        '<button class="btn btn-sm" data-act="copy">회신 문구 복사</button><button class="btn btn-sm" data-act="xlsx">엑셀 저장</button></div></div>' +
        (rows.length ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>톤수</th><th>타리프</th><th>지역할증</th><th>하행할증</th><th>합계</th>' +
          '</tr></thead><tbody>' + rows.map(function (row, i) {
            return '<tr style="--i:' + i + '"><td class="ton">' + esc(row.ton) + '</td>' +
              '<td class="num">' + won(row.tariff) + '</td>' +
              '<td class="num">' + won(row.region) + '</td>' +
              '<td class="num">' + won(row.downhill) + '</td>' +
              '<td class="total"><span class="num" data-total="' + row.total + '">' + won(row.total) + '</span></td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted" style="margin:0">선택된 톤수가 없습니다. ' + esc(opts.emptyHint || '') + '</p>') +
        '<p class="hint" style="margin:14px 0 0">합계 = 타리프 + 지역할증 + 하행할증 (금액 단위 반올림 적용) · 유류비·통행료는 아래 밀크런에 따로 표시</p>' +
        '</div>';
    }
    html += '<div style="margin-top:16px">' + milkrunCard(r, 2) + '</div>';

    box.innerHTML = html;
    if (!opts.animate) $$('.card, tr', box).forEach(function (el) { el.style.animation = 'none'; });
    else $$('[data-total]', box).forEach(function (el) { countUp(el, Number(el.dataset.total)); });

    var copyBtn = $('[data-act="copy"]', box), xBtn = $('[data-act="xlsx"]', box), sBtn = $('[data-act="saveQuote"]', box);
    if (sBtn) sBtn.onclick = function () { openSaveQuote(opts.recordId, { name: '', client: '' }); };
    if (copyBtn) copyBtn.onclick = function () {
      copyText(quoteText(r, rows)).then(function () { toast('회신 문구를 복사했습니다.'); });
    };
    if (xBtn) xBtn.onclick = function () {
      var m = r.milkrun;
      var head = ['상차지', '하차지', '거리(km)', '요금기준(km)', '방향', '지역할증 내역', '톤수', '타리프', '지역할증', '하행할증', '합계'];
      var body = rows.map(function (row) {
        return [r.origin.address, r.dest.address, r.distanceKm, r.km, r.direction, regionText(r), row.ton, row.tariff, row.region, row.downhill, row.total];
      });
      var mr = [['밀크런 기준 톤수', m.ton], ['편도/왕복', m.roundTrip ? '왕복' : '편도'], ['운행 거리(km)', m.distanceKm], ['연비(km/L)', m.kmPerL],
        ['경유가(원/L)', m.dieselPrice], ['유류비', m.fuel], ['통행료(' + m.tollClass + '종)', m.toll], ['유류비+통행료', m.total]];
      busy(xBtn, true, '만드는 중…');
      downloadXlsx('조일ver1_견적_' + (opts.fileDate || today()) + '.xlsx', [
        { name: '톤수별 견적', rows: [head].concat(body), widths: [34, 34, 9, 10, 6, 26, 7, 11, 10, 10, 11] },
        { name: '밀크런', rows: [['항목', '값']].concat(mr), widths: [18, 14] }
      ]).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(xBtn, false); });
    };
  }

  function quoteText(r, rows) {
    var lines = [
      '[운임 견적] ' + today(),
      '상차지: ' + r.origin.address,
      '하차지: ' + r.dest.address,
      '운행거리: 약 ' + r.distanceKm + 'km',
      ''
    ];
    rows.forEach(function (row) { lines.push('· ' + row.ton + ': ' + won(row.total) + '원'); });
    if (state.pub.quoteFooter) { lines.push(''); lines.push(state.pub.quoteFooter); }
    return lines.join('\n');
  }

  /* ───────── 대량 계산 ───────── */

  var BULK_CHUNK = 20;      // 한 번 요청에 보내는 경로 수
  var BULK_PARALLEL = 3;    // 동시에 보내는 요청 수
  var BULK_PAGE = 100;      // 결과 표 한 페이지 줄 수

  function parseBulk() {
    var b = state.bulk;
    var pairs = [], bad = 0;
    function lines(text) { return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean); }
    if (b.mode === 'one') {
      var o = b.origin.trim();
      lines(b.dests).forEach(function (d) {
        var cell = d.split('\t').filter(function (x) { return x.trim(); });
        d = (cell.length ? cell[cell.length - 1] : d).trim();
        if (/^(하차지|도착지|주소)$/.test(d)) return;
        pairs.push({ origin: o, dest: d });
      });
    } else {
      lines(b.pairsText).forEach(function (l, i) {
        var cells = l.split('\t').map(function (x) { return x.trim(); }).filter(Boolean);
        if (cells.length < 2 && l.indexOf('|') !== -1) cells = l.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
        if (i === 0 && cells.length >= 2 && /상차|출발/.test(cells[0]) && /하차|도착/.test(cells[1])) return;
        if (cells.length < 2) { bad++; return; }
        pairs.push({ origin: cells[cells.length - 2], dest: cells[cells.length - 1] });
      });
    }
    return { pairs: pairs, bad: bad };
  }

  function renderBulk() {
    var b = state.bulk, c = state.calc;
    $('#main').innerHTML =
      '<div class="card" id="bulkForm">' +
      '<div class="row-between" style="flex-wrap:wrap;margin-bottom:18px"><div><div class="eyebrow">Batch · 대량 계산</div><h2>여러 경로 한 번에 계산</h2>' +
      '<p class="muted small" style="margin:6px 0 0">최대 <b>' + won(state.pub.maxRows) + '건</b> · 한 번 조회한 주소와 경로는 저장돼서 다음부터 더 빨라집니다.</p></div>' +
      '<div class="segmented" id="modeSeg"><button type="button" data-m="one" class="' + (b.mode === 'one' ? 'on' : '') + '">상차지 1곳 → 여러 하차지</button><button type="button" data-m="pairs" class="' + (b.mode === 'pairs' ? 'on' : '') + '">상·하차지 2열 붙여넣기</button></div></div>' +
      '<div class="bulk-grid"><div>' +
      (b.mode === 'one'
        ? '<div class="field"><label for="bOrigin"><span class="pin from"></span>상차지</label><input class="input" id="bOrigin" value="' + esc(b.origin) + '" placeholder="예) 경기 평택시 포승읍 평택항로 …"></div>' +
          '<div class="field"><label for="bDests"><span class="pin to"></span>하차지 목록 <span class="muted">(한 줄에 하나, 엑셀 열 복사 가능)</span></label><textarea class="input" id="bDests" placeholder="부산 강서구 녹산산단321로 …&#10;대구 달서구 성서공단로 …&#10;광주 광산구 하남산단 …">' + esc(b.dests) + '</textarea></div>'
        : '<div class="field"><label for="bPairs">엑셀에서 <b>상차지 · 하차지</b> 두 열을 복사해 붙여넣으세요</label><textarea class="input" id="bPairs" placeholder="경기 평택시 …&#9;부산 강서구 …&#10;인천 서구 …&#9;대구 달서구 …">' + esc(b.pairsText) + '</textarea>' +
          '<span class="hint">칸 구분은 탭(엑셀 복사) 또는 | 기호 · 첫 줄이 "상차지/하차지" 제목이면 건너뜁니다</span></div>') +
      '<p class="hint" id="bulkCount" style="margin:-4px 0 0"></p>' +
      '</div><div>' + optionsHtml() +
      '<div class="section-gap"></div><div class="section-gap"></div>' +
      '<div class="actions"><button class="btn btn-accent btn-lg" id="bulkRun" style="flex:1">대량 계산 시작</button>' +
      '<button class="btn btn-lg hidden" id="bulkStop" style="flex:0 0 auto;width:auto">중지</button></div>' +
      '</div></div>' +
      '<div id="bulkProgress" class="progress-wrap hidden"><div class="progress"><div class="bar" id="bulkBar"></div></div><div class="row-between small"><span id="bulkProgText"></span><span class="muted" id="bulkEta"></span></div></div>' +
      '</div>' +
      '<div id="bulkResult" style="margin-top:16px"></div>';

    $$('#modeSeg button').forEach(function (btn) {
      btn.onclick = function () { if (b.running) return; b.mode = btn.dataset.m; renderBulk(); };
    });
    if (b.mode === 'one') {
      $('#bOrigin').oninput = function () { b.origin = this.value; updateCount(); };
      $('#bDests').oninput = function () { b.dests = this.value; updateCount(); };
    } else {
      $('#bPairs').oninput = function () { b.pairsText = this.value; updateCount(); };
    }
    bindOptions(function () { if (b.results.length) renderBulkResult(); });
    $('#bulkRun').onclick = function () { startBulk(); };
    $('#bulkStop').onclick = function () { b.cancel = true; this.disabled = true; this.textContent = '중지하는 중…'; };

    function updateCount() {
      var p = parseBulk(), max = Number(state.pub.maxRows) || 1000;
      $('#bulkCount').innerHTML = p.pairs.length
        ? '<b>' + won(p.pairs.length) + '건</b> 인식' + (p.bad ? ' · <span style="color:var(--red)">형식 오류 ' + p.bad + '줄 제외</span>' : '') +
          (p.pairs.length > max ? ' · <span style="color:var(--red)">최대 ' + won(max) + '건을 넘었습니다</span>' : '')
        : (p.bad ? '<span style="color:var(--red)">상차지와 하차지 두 칸이 있는 줄이 없습니다</span>' : '');
    }
    updateCount();
    setRunning(b.running);
    if (b.results.length) renderBulkResult();
  }

  function setRunning(on) {
    var run = $('#bulkRun'), stop = $('#bulkStop');
    if (!run) return;
    run.disabled = on;
    run.innerHTML = on ? '<span class="spinner"></span>계산 중…' : '대량 계산 시작';
    stop.classList.toggle('hidden', !on);
    $('#bulkProgress').classList.toggle('hidden', !on && !state.bulk.results.length);
    $$('#bulkForm input, #bulkForm textarea, #bulkForm select').forEach(function (el) { el.disabled = on; });
  }

  function startBulk() {
    var b = state.bulk;
    if (b.running) return;
    var p = parseBulk(), max = Number(state.pub.maxRows) || 1000;
    if (b.mode === 'one' && !b.origin.trim()) return toast('상차지를 입력하세요.', 'err');
    if (!p.pairs.length) return toast('계산할 경로가 없습니다.', 'err');
    if (p.pairs.length > max) return toast('최대 ' + won(max) + '건까지 계산할 수 있습니다.', 'err');
    if (!checkOptions()) return;
    b.results = p.pairs.map(function (pair, i) { return { no: i + 1, origin: pair.origin, dest: pair.dest, status: 'wait' }; });
    b.page = 0; b.search = ''; b.sort = 'no';
    b.opts = quoteOptions();
    b.meta = null;
    b.recordId = 'B' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    runBulk(b.results.slice(), true);
  }

  function retryFailed() {
    var b = state.bulk;
    var rows = b.results.filter(function (r) { return r.status !== 'ok'; });
    if (!rows.length) return;
    rows.forEach(function (r) { r.status = 'wait'; r.error = null; });
    runBulk(rows, false);
  }

  function runBulk(rows, isNew) {
    var b = state.bulk;
    var chunks = [];
    for (var i = 0; i < rows.length; i += BULK_CHUNK) chunks.push(rows.slice(i, i + BULK_CHUNK));
    b.running = true; b.cancel = false;
    b.startedAt = Date.now();
    var done = 0, next = 0, total = rows.length;
    setRunning(true);
    $('#bulkResult').innerHTML = '';
    progress();

    function progress() {
      var pct = total ? Math.round(done / total * 100) : 0;
      var bar = $('#bulkBar'); if (!bar) return;
      bar.style.width = pct + '%';
      var ok = b.results.filter(function (r) { return r.status === 'ok'; }).length;
      var fail = b.results.filter(function (r) { return r.status === 'error'; }).length;
      $('#bulkProgText').innerHTML = '<b>' + won(done) + '</b> / ' + won(total) + '건 (' + pct + '%) · 성공 ' + won(ok) + ' · 실패 ' + won(fail);
      var sec = (Date.now() - b.startedAt) / 1000;
      $('#bulkEta').textContent = done && done < total ? '남은 시간 약 ' + Math.max(1, Math.round(sec / done * (total - done))) + '초' : (done >= total ? Math.round(sec) + '초 걸림' : '');
    }

    function worker(loop) {
      if (b.cancel || next >= chunks.length) return Promise.resolve();
      var idx = next++;
      var chunk = chunks[idx];
      var payload = Object.assign({
        pairs: chunk.map(function (r) { return { no: r.no, origin: r.origin, dest: r.dest }; }),
        batch: { id: b.recordId, index: isNew ? idx : -1, total: chunks.length, count: b.results.length }
      }, b.opts);
      return api('quoteBatch', payload).then(function (res) {
        b.meta = b.meta || { diesel: res.diesel, baseTon: res.baseTon };
        res.items.forEach(function (it, j) {
          var row = chunk[j];
          if (it.error) { row.status = 'error'; row.error = it.error; row.result = null; }
          else { row.status = 'ok'; row.error = null; row.result = it.result; }
        });
      }).catch(function (err) {
        chunk.forEach(function (row) { row.status = 'error'; row.error = err.message; });
        if (/로그인|사용이 중지|관리자/.test(err.message)) b.cancel = true;
      }).then(function () {
        done += chunk.length;
        progress();
        return loop ? worker(true) : null;
      });
    }

    // 첫 묶음을 먼저 보내서(조회 기록 1줄) 끝나면 나머지를 동시에
    var first = worker(false);
    first.then(function () {
      var ws = [];
      for (var k = 0; k < BULK_PARALLEL; k++) ws.push(worker(true));
      return Promise.all(ws);
    }).then(function () {
      b.running = false;
      rows.forEach(function (r) { if (r.status === 'wait') { r.status = 'error'; r.error = '중지됨'; } });
      if (state.view !== 'bulk') return;
      setRunning(false);
      progress();
      renderBulkResult(true);
      var fail = b.results.filter(function (r) { return r.status !== 'ok'; }).length;
      toast(b.cancel ? '계산을 중지했습니다.' : fail ? '완료 · 실패 ' + fail + '건은 다시 시도할 수 있어요.' : '모든 경로를 계산했습니다.', fail && !b.cancel ? 'err' : 'ok');
    });
  }

  function bulkView(b) {
    var q = (b.search || '').trim();
    var list = b.results.filter(function (r) {
      if (b.filter === 'fail' && r.status === 'ok') return false;
      if (!q) return true;
      var t = r.origin + ' ' + r.dest + (r.result ? ' ' + r.result.origin.address + ' ' + r.result.dest.address : '');
      return t.indexOf(q) !== -1;
    });
    var key = b.sort || 'no';
    var dist = function (r) { return r.result ? r.result.distanceKm : Infinity; };
    list.sort(function (x, y) {
      if (key === 'kmAsc') return dist(x) - dist(y);
      if (key === 'kmDesc') return (y.result ? y.result.distanceKm : -1) - (x.result ? x.result.distanceKm : -1);
      if (key === 'mrDesc') return (y.result ? y.result.milkrun.total : -1) - (x.result ? x.result.milkrun.total : -1);
      return x.no - y.no;
    });
    return list;
  }

  function renderBulkResult(animate) {
    var box = $('#bulkResult');
    if (!box) return;
    renderBulkView(state.bulk, box, {
      live: true, animate: animate, tons: state.calc.tons, roundTrip: state.pub.roundTrip, recordId: state.bulk.recordId,
      emptyHint: '표시할 톤수를 위에서 골라 주세요.'
    });
  }

  /**
   * 대량 결과 표 (계산 직후 · 조회기록 상세 · 견적모음 상세 공용)
   * b: { results, meta, page, sort, search, filter, detail, running }
   * opts: { live(실패 재계산 가능), animate, tons, roundTrip, recordId, emptyHint, fileDate, who }
   */
  function renderBulkView(b, box, opts) {
    var again = function () { renderBulkView(b, box, Object.assign({}, opts, { animate: false })); };
    var all = b.results;
    var okRows = all.filter(function (r) { return r.status === 'ok'; });
    var fail = all.length - okRows.length;
    var avg = okRows.length ? Math.round(okRows.reduce(function (s, r) { return s + r.result.distanceKm; }, 0) / okRows.length) : 0;
    var tons = opts.tons;
    var detail = b.detail !== false;
    var list = bulkView(b);
    var pages = Math.max(1, Math.ceil(list.length / BULK_PAGE));
    if (b.page >= pages) b.page = 0;
    var pageRows = list.slice(b.page * BULK_PAGE, (b.page + 1) * BULK_PAGE);
    var meta = b.meta || {};
    var mrTon = meta.baseTon || '';
    var perTon = detail ? 3 : 1;

    var head1 = '<tr><th class="sticky c0" rowspan="2">#</th><th class="sticky c1" rowspan="2">하차지</th><th rowspan="2" class="left">상차지</th>' +
      '<th rowspan="2">거리</th><th rowspan="2" class="left">방향</th><th rowspan="2" class="left">지역할증</th>' +
      '<th colspan="3" class="grp mr">밀크런 · ' + esc(mrTon) + ' ' + (opts.roundTrip ? '왕복' : '편도') + '</th>' +
      tons.map(function (t) { return '<th colspan="' + perTon + '" class="grp">' + esc(t) + '</th>'; }).join('') + '</tr>';
    var head2 = '<tr><th class="mr">유류비</th><th class="mr">통행료</th><th class="mr">합계</th>' +
      tons.map(function () { return detail ? '<th>타리프</th><th>하행</th><th>합계</th>' : '<th>합계</th>'; }).join('') + '</tr>';
    var colCount = 9 + tons.length * perTon;

    var body = pageRows.map(function (row) {
      var start = '<td class="sticky c0 muted num">' + row.no + '</td>';
      if (row.status !== 'ok') {
        return '<tr class="err">' + start + '<td class="sticky c1"><div class="addr-in">' + esc(row.dest) + '</div></td>' +
          '<td class="left"><div class="addr-in">' + esc(row.origin) + '</div></td>' +
          '<td colspan="' + (colCount - 3) + '" class="left err-msg">⚠ ' + esc(row.error || '대기 중') + '</td></tr>';
      }
      var r = row.result, m = r.milkrun;
      var byTon = {};
      r.rows.forEach(function (x) { byTon[x.ton] = x; });
      return '<tr>' + start +
        '<td class="sticky c1"><div class="addr">' + esc(r.dest.address) + '</div>' + (r.dest.address !== row.dest ? '<div class="addr-in">' + esc(row.dest) + '</div>' : '') + '</td>' +
        '<td class="left"><div class="addr">' + esc(r.origin.address) + '</div></td>' +
        '<td class="num">' + r.distanceKm + '<span class="muted small">km</span></td>' +
        '<td class="left">' + (r.direction === '하행' ? '<span class="badge down">▼ 하행' + (r.downhillApplied ? ' ' + r.downhillPercent + '%' : '') + '</span>' : '<span class="badge up">▲ 상행</span>') + '</td>' +
        '<td class="left small">' + (r.regionHits.length ? r.regionHits.map(function (h) { return '<span class="badge region">' + esc(h.point.replace('지', '')) + '·' + esc(h.name) + ' ' + won(h.amount) + '</span>'; }).join('') : '<span class="muted">–</span>') + '</td>' +
        '<td class="num mr">' + won(m.fuel) + '</td><td class="num mr">' + won(m.toll) + '</td><td class="num mr strong">' + won(m.total) + '</td>' +
        tons.map(function (t) {
          var x = byTon[t];
          if (r.overMax) return '<td colspan="' + perTon + '" class="muted small">별도 문의</td>';
          if (!x) return '<td colspan="' + perTon + '">–</td>';
          return detail
            ? '<td class="num">' + won(x.tariff) + '</td><td class="num">' + won(x.downhill) + '</td><td class="num strong total-cell">' + won(x.total) + '</td>'
            : '<td class="num strong total-cell">' + won(x.total) + '</td>';
        }).join('') + '</tr>';
    }).join('');

    box.innerHTML =
      '<div class="card" style="--i:0">' +
      '<div class="row-between" style="flex-wrap:wrap;margin-bottom:14px"><div><div class="eyebrow">Result · 대량 결과</div>' +
      '<h3>' + won(all.length) + '건 · <span style="color:var(--green)">성공 ' + won(okRows.length) + '</span>' + (fail ? ' · <span style="color:var(--red)">실패 ' + won(fail) + '</span>' : '') + '</h3>' +
      '<p class="muted small" style="margin:4px 0 0">평균 거리 ' + won(avg) + 'km' + (meta.diesel ? ' · 경유가 ' + won(meta.diesel.price) + '원/L (' + esc(meta.diesel.source) + ')' : '') + ' · 지역할증은 톤수별 합계에 포함</p></div>' +
      '<div class="actions">' + (opts.live && fail && !b.running ? '<button class="btn btn-sm btn-danger" data-act="retry">실패 ' + won(fail) + '건 다시 계산</button>' : '') +
      (opts.recordId && !b.running ? '<button class="btn btn-sm" data-act="saveQuote">견적으로 저장</button>' : '') +
      '<button class="btn btn-sm btn-primary" data-act="xlsx"' + (okRows.length ? '' : ' disabled') + '>엑셀 다운로드</button></div></div>' +
      '<div class="toolbar">' +
      '<input class="input input-sm" data-el="search" placeholder="주소 검색" value="' + esc(b.search || '') + '" style="max-width:240px">' +
      '<select class="input input-sm" data-el="sort" style="width:auto"><option value="no">입력 순서</option><option value="kmAsc">거리 가까운 순</option><option value="kmDesc">거리 먼 순</option><option value="mrDesc">밀크런 금액 큰 순</option></select>' +
      '<div class="segmented" data-el="filter"><button type="button" data-f="all" class="' + (b.filter !== 'fail' ? 'on' : '') + '">전체</button><button type="button" data-f="fail" class="' + (b.filter === 'fail' ? 'on' : '') + '">실패만</button></div>' +
      '<label class="toggle" style="margin-left:auto"><input type="checkbox" data-el="detail"' + (detail ? ' checked' : '') + '><span class="track"></span>톤수별 상세</label>' +
      '</div>' +
      (tons.length ? '' : '<p class="hint" style="margin:0 0 10px">' + esc(opts.emptyHint || '') + '</p>') +
      '<div class="bulk-table"><table class="data bulk"><thead>' + head1 + head2 + '</thead><tbody>' + (body || '<tr><td colspan="' + colCount + '" class="left muted" style="padding:24px">조건에 맞는 결과가 없습니다.</td></tr>') + '</tbody></table></div>' +
      (pages > 1 ? '<div class="pager" style="margin-top:12px">' + Array.apply(null, { length: pages }).map(function (_, p) {
        return '<button data-p="' + p + '" class="' + (p === b.page ? 'on' : '') + '">' + (p * BULK_PAGE + 1) + '–' + Math.min(list.length, (p + 1) * BULK_PAGE) + '</button>';
      }).join('') + '</div>' : '') +
      '</div>';

    if (!opts.animate) $$('.card', box).forEach(function (el) { el.style.animation = 'none'; });
    var sortEl = $('[data-el="sort"]', box);
    sortEl.value = b.sort || 'no';
    sortEl.onchange = function () { b.sort = this.value; b.page = 0; again(); };
    var st;
    $('[data-el="search"]', box).oninput = function () {
      var v = this.value; clearTimeout(st);
      st = setTimeout(function () { b.search = v; b.page = 0; again(); var el = $('[data-el="search"]', box); el.focus(); el.setSelectionRange(v.length, v.length); }, 250);
    };
    $$('[data-el="filter"] button', box).forEach(function (x) { x.onclick = function () { b.filter = x.dataset.f; b.page = 0; again(); }; });
    $('[data-el="detail"]', box).onchange = function () { b.detail = this.checked; again(); };
    $$('.pager button', box).forEach(function (x) { x.onclick = function () { b.page = Number(x.dataset.p); again(); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
    var rt = $('[data-act="retry"]', box); if (rt) rt.onclick = retryFailed;
    var sv = $('[data-act="saveQuote"]', box); if (sv) sv.onclick = function () { openSaveQuote(opts.recordId, { name: '', client: '' }); };
    $('[data-act="xlsx"]', box).onclick = function () { exportBulk(this, b, opts); };
  }

  function exportBulk(btn, b, opts) {
    var tons = opts.tons, meta = b.meta || {};
    var head = ['No', '상차지(입력)', '하차지(입력)', '상차지(찾은 주소)', '하차지(찾은 주소)', '거리(km)', '요금기준(km)', '방향', '하행할증(%)', '지역할증 내역', '지역할증 합계',
      '밀크런 기준톤수', '편도/왕복', '밀크런 거리(km)', '경유가(원/L)', '유류비', '통행료', '유류비+통행료'];
    tons.forEach(function (t) { head.push(t + ' 타리프', t + ' 하행할증', t + ' 합계'); });
    head.push('오류');
    var rows = b.results.slice().sort(function (x, y) { return x.no - y.no; }).map(function (row) {
      if (row.status !== 'ok') {
        var e = [row.no, row.origin, row.dest];
        while (e.length < head.length - 1) e.push('');
        e.push(row.error || '');
        return e;
      }
      var r = row.result, m = r.milkrun, byTon = {};
      r.rows.forEach(function (x) { byTon[x.ton] = x; });
      var out = [row.no, row.origin, row.dest, r.origin.address, r.dest.address, r.distanceKm, r.km, r.direction, r.downhillPercent, regionText(r), r.regionTotal,
        m.ton, m.roundTrip ? '왕복' : '편도', m.distanceKm, m.dieselPrice, m.fuel, m.toll, m.total];
      tons.forEach(function (t) {
        var x = byTon[t];
        if (r.overMax || !x) out.push('별도 문의', '', ''); else out.push(x.tariff, x.downhill, x.total);
      });
      out.push('');
      return out;
    });
    var widths = [5, 28, 28, 30, 30, 9, 10, 6, 9, 26, 10, 12, 8, 12, 10, 10, 10, 12].concat(tons.reduce(function (a) { return a.concat([11, 10, 11]); }, [])).concat([30]);
    var ok = b.results.filter(function (r) { return r.status === 'ok'; }).length;
    var cond = [['항목', '값'], ['조회 일시', opts.when || new Date().toLocaleString('ko-KR')], ['조회자', opts.who || (state.user.name + ' (' + state.user.id + ')')],
      ['전체 건수', b.results.length], ['성공', ok], ['실패', b.results.length - ok],
      ['밀크런 기준 톤수', meta.baseTon || ''], ['편도/왕복', opts.roundTrip ? '왕복' : '편도'],
      ['경유가(원/L)', meta.diesel ? meta.diesel.price : ''], ['경유가 출처', meta.diesel ? meta.diesel.source : ''],
      ['비고', '톤수별 합계 = 타리프 + 지역할증 + 하행할증 / 유류비·통행료는 밀크런 기준 톤수로 별도 계산']];
    busy(btn, true, '만드는 중…');
    downloadXlsx('조일ver1_대량견적_' + (opts.fileDate || today()) + '_' + b.results.length + '건.xlsx', [
      { name: '대량 견적', rows: [head].concat(rows), widths: widths },
      { name: '조건', rows: cond, widths: [16, 60] }
    ]).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
  }

  /* ───────── 견적으로 저장 ───────── */

  var QUOTE_STATUS = ['작성', '제출', '수주', '미수주'];

  function statusPill(st) {
    return '<span class="qstatus s-' + (QUOTE_STATUS.indexOf(st) + 1) + '">' + esc(st || '작성') + '</span>';
  }

  function quoteFieldsHtml(q) {
    return '<div class="field"><label>견적명 <span style="color:var(--red)">*</span></label><input class="input" data-f="name" maxlength="100" value="' + esc(q.name || '') + '" placeholder="예) A견적 · 평택→전국 5톤"></div>' +
      '<div class="field"><label>거래처</label><input class="input" data-f="client" maxlength="100" value="' + esc(q.client || '') + '" placeholder="예) 쿠팡, 삼다수"></div>' +
      '<div class="field"><label>진행 상태</label><div class="segmented" data-f="status">' + QUOTE_STATUS.map(function (st) {
        return '<button type="button" data-v="' + st + '" class="' + ((q.status || '작성') === st ? 'on' : '') + '">' + st + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>메모</label><textarea class="input memo" data-f="memo" maxlength="2000" placeholder="조건, 특이사항, 제출 금액 등">' + esc(q.memo || '') + '</textarea></div>';
  }

  function bindQuoteFields(root) {
    $$('[data-f="status"] button', root).forEach(function (b) {
      b.onclick = function () { $$('[data-f="status"] button', root).forEach(function (x) { x.classList.toggle('on', x === b); }); };
    });
    return function () {
      var on = $('[data-f="status"] button.on', root);
      return { name: $('[data-f="name"]', root).value.trim(), client: $('[data-f="client"]', root).value.trim(), memo: $('[data-f="memo"]', root).value, status: on ? on.dataset.v : '작성' };
    };
  }

  function openSaveQuote(recordId, defaults) {
    modal({
      eyebrow: '견적모음', title: '견적으로 저장',
      body: '<p class="muted small" style="margin:0 0 14px">지금 보이는 결과(그때 금액 그대로)를 견적모음에 보관합니다. 기간 제한 없이 남아요.</p>' + quoteFieldsHtml(defaults || {}),
      foot: '<button class="btn" data-close>취소</button><button class="btn btn-primary" id="qSave">저장</button>',
      onMount: function (m, close) {
        var read = bindQuoteFields(m);
        $('#qSave', m).onclick = function () {
          var f = read();
          if (!f.name) return toast('견적명을 입력하세요.', 'err');
          var btn = this; busy(btn, true, '저장 중…');
          api('quotes.save', Object.assign({ recordId: recordId }, f)).then(function () {
            close();
            state.quotes.list = null;
            toast('견적모음에 저장했습니다.');
          }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
        };
      }
    });
  }

  /* ───────── 스냅샷 보기 (조회기록·견적모음 상세 공용) ───────── */

  function snapshotInfoHtml(meta) {
    return '<div class="snap-info">' +
      '<span><b>조회</b> ' + esc(meta.at) + '</span>' +
      '<span><b>조회자</b> ' + esc(meta.user ? meta.user.name + ' (' + meta.user.id + ')' : '') + '</span>' +
      '<span><b>밀크런</b> ' + esc(meta.baseTon || '') + ' · ' + (meta.roundTrip ? '왕복' : '편도') + '</span>' +
      '<span><b>경유가</b> ' + (meta.diesel ? won(meta.diesel.price) + '원/L (' + esc(meta.diesel.source) + ')' : '–') + '</span>' +
      '</div>';
  }

  /** 스냅샷 본문을 box에 그립니다. 금액은 저장 당시 그대로. */
  function renderSnapshot(meta, items, box, holder, recordId) {
    var tons = meta.tons || state.pub.tons;
    var fileDate = String(meta.at || '').slice(0, 10) || today();
    if (meta.type === '단건') {
      var it = items[0];
      if (!it || !it.result) { box.innerHTML = '<div class="card muted">결과가 없습니다.</div>'; return; }
      renderSingleView(it.result, box, { tons: tons, animate: false, recordId: recordId, fileDate: fileDate });
      return;
    }
    if (!holder.bulk) {
      holder.bulk = {
        results: items.map(function (x) { return { no: x.no, origin: x.origin, dest: x.dest, status: x.result ? 'ok' : 'error', result: x.result, error: x.error }; }),
        meta: { baseTon: meta.baseTon, diesel: meta.diesel }, page: 0, sort: 'no', search: '', filter: 'all', detail: true, running: false
      };
    }
    renderBulkView(holder.bulk, box, {
      live: false, animate: false, tons: tons, roundTrip: meta.roundTrip, recordId: recordId, fileDate: fileDate,
      when: meta.at, who: meta.user ? meta.user.name + ' (' + meta.user.id + ')' : ''
    });
  }

  /** 그때 경로 그대로 현재 단가로 다시 계산 → 단건/대량 화면으로 이동해서 바로 실행 */
  function recalcNow(meta, items) {
    if (meta.type === '단건') {
      var it = items[0];
      state.calc.origin = it.origin; state.calc.dest = it.dest;
      if (state.pub.tons.indexOf(meta.baseTon) !== -1) state.calc.baseTon = meta.baseTon;
      state.calc.result = null;
      state.view = 'calc'; render();
      $('#calcForm').requestSubmit ? $('#calcForm').requestSubmit() : $('#calcBtn').click();
      return;
    }
    var b = state.bulk;
    if (b.running) return toast('대량 계산이 진행 중입니다. 끝난 뒤 다시 시도하세요.', 'err');
    b.mode = 'pairs';
    b.pairsText = items.map(function (x) { return x.origin + '\t' + x.dest; }).join('\n');
    if (state.pub.tons.indexOf(meta.baseTon) !== -1) state.calc.baseTon = meta.baseTon;
    b.results = [];
    state.view = 'bulk'; render();
    startBulk();
  }

  /* ───────── 조회기록 ───────── */

  function renderHistory() {
    var h = state.hist;
    if (h.detail) return renderHistoryDetail();
    var isAdmin = state.user.role === 'admin';
    $('#main').innerHTML =
      '<div class="card">' +
      '<div class="row-between" style="flex-wrap:wrap;margin-bottom:14px"><div><div class="eyebrow">History · 조회기록</div><h2>' + (isAdmin ? '전체 조회기록' : '내 조회기록') + '</h2>' +
      '<p class="muted small" style="margin:6px 0 0">상세보기에서 그때 결과를 그대로 다시 볼 수 있어요. 상세 내용은 조회 후 <b>' + esc(state.pub.retentionDays || 90) + '일</b>간 보관되고, 견적모음에 저장하면 계속 남습니다.</p></div>' +
      '<button class="btn btn-sm" id="hReload">새로고침</button></div>' +
      '<div class="toolbar">' +
      '<div class="segmented" id="hDays">' + [[7, '7일'], [30, '30일'], [90, '90일'], [0, '전체']].map(function (d) {
        return '<button type="button" data-d="' + d[0] + '" class="' + (h.days === d[0] ? 'on' : '') + '">' + d[1] + '</button>';
      }).join('') + '</div>' +
      '<select class="input input-sm" id="hType" style="width:auto"><option value="">단건+대량</option><option value="단건">단건</option><option value="대량">대량</option></select>' +
      (isAdmin ? '<select class="input input-sm" id="hUser" style="width:auto"><option value="">전체 사용자</option>' + (h.users || []).map(function (u) {
        return '<option value="' + esc(u.id) + '">' + esc(u.name) + ' (' + esc(u.id) + ')</option>';
      }).join('') + '</select>' : '') +
      '<input class="input input-sm" id="hSearch" placeholder="주소·이름 검색 후 Enter" value="' + esc(h.q) + '" style="max-width:260px">' +
      '</div><div id="hList"></div></div>';

    $('#hType').value = h.type;
    if (isAdmin) $('#hUser').value = h.userId;
    $$('#hDays button').forEach(function (b) { b.onclick = function () { h.days = Number(b.dataset.d); loadHistory(); }; });
    $('#hType').onchange = function () { h.type = this.value; loadHistory(); };
    if (isAdmin) $('#hUser').onchange = function () { h.userId = this.value; loadHistory(); };
    $('#hSearch').onkeydown = function (e) { if (e.key === 'Enter') { h.q = this.value.trim(); loadHistory(); } };
    $('#hReload').onclick = function () { loadHistory(); };
    if (h.logs) drawHistoryList(); else loadHistory();
  }

  function loadHistory() {
    var h = state.hist;
    $$('#hDays button').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.d) === h.days); });
    var list = $('#hList'); if (list) list.innerHTML = '<p class="muted"><span class="spinner dark"></span> 불러오는 중…</p>';
    api('history.list', { days: h.days, type: h.type, userId: h.userId, q: h.q }).then(function (r) {
      h.logs = r.logs;
      if (r.users) {
        var hadUsers = !!h.users; h.users = r.users;
        if (!hadUsers && state.view === 'history' && !h.detail) return renderHistory();
      }
      if (state.view === 'history' && !h.detail) drawHistoryList();
    }).catch(function (err) {
      var l = $('#hList'); if (l) l.innerHTML = '<p style="color:var(--red)">' + esc(err.message) + '</p>';
    });
  }

  function drawHistoryList() {
    var h = state.hist, isAdmin = state.user.role === 'admin';
    var list = $('#hList'); if (!list) return;
    if (!h.logs.length) { list.innerHTML = '<p class="muted" style="margin:18px 0 4px">조건에 맞는 기록이 없습니다.</p>'; return; }
    list.innerHTML = '<div class="table-wrap"><table class="data hist"><thead><tr><th>일시</th>' + (isAdmin ? '<th class="left">사용자</th>' : '') +
      '<th class="left">종류</th><th class="left">상차지</th><th class="left">하차지</th><th>거리</th><th></th></tr></thead><tbody>' +
      h.logs.map(function (l, i) {
        var type = l.type || (/^대량/.test(l.note || '') ? '대량' : '단건');
        return '<tr style="--i:' + Math.min(i, 20) + '"><td class="small muted">' + esc(l.at) + '</td>' +
          (isAdmin ? '<td class="left">' + esc(l.name) + ' <span class="muted small">' + esc(l.id) + '</span></td>' : '') +
          '<td class="left"><span class="badge ' + (type === '대량' ? 'down' : 'up') + '">' + type + (type === '대량' && l.count ? ' ' + won(l.count) + '건' : '') + '</span></td>' +
          '<td class="left wrap">' + esc(l.from) + '</td><td class="left wrap">' + esc(l.to) + '</td>' +
          '<td class="num">' + (l.km === '' || l.km == null ? '–' : esc(l.km) + 'km') + '</td>' +
          '<td><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">' +
          (l.hasSnapshot
            ? '<button class="btn btn-sm" data-open="' + esc(l.recordId) + '">상세보기</button><button class="btn btn-sm btn-ghost" data-save="' + esc(l.recordId) + '">견적 저장</button>'
            : '<span class="small muted">' + (l.recordId ? '보관 기간 지남' : '상세 없음') + '</span>') +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>' +
      (h.logs.length >= 300 ? '<p class="hint">최근 300건까지 표시합니다. 기간이나 검색으로 좁혀 보세요.</p>' : '');
    $$('[data-open]', list).forEach(function (b) { b.onclick = function () { h.detail = b.dataset.open; h.detailData = null; renderHistory(); window.scrollTo(0, 0); }; });
    $$('[data-save]', list).forEach(function (b) { b.onclick = function () { openSaveQuote(b.dataset.save, {}); }; });
  }

  function renderHistoryDetail() {
    var h = state.hist;
    $('#main').innerHTML =
      '<div class="row-between" style="margin-bottom:14px;flex-wrap:wrap"><button class="btn btn-sm" id="hBack">← 조회기록</button><div class="actions" id="hActs"></div></div>' +
      '<div id="hHead"></div><div id="hBody"><div class="card muted"><span class="spinner dark"></span> 그때 결과를 불러오는 중…</div></div>';
    $('#hBack').onclick = function () { h.detail = null; h.detailData = null; renderHistory(); };
    var id = h.detail;
    var show = function (d) {
      if (state.view !== 'history' || h.detail !== id) return;
      $('#hHead').innerHTML = '<div class="card" style="margin-bottom:16px"><div class="eyebrow">Snapshot · 그때 결과</div><h3>' +
        esc(d.meta.type === '대량' ? '대량 ' + won(d.items.length) + '건 · ' + d.log.from : d.log.from + ' → ' + d.log.to) + '</h3>' + snapshotInfoHtml(d.meta) +
        '<p class="hint" style="margin:10px 0 0">아래 금액은 조회 당시 단가 기준입니다. 지금 단가로 보려면 "현재 단가로 다시 계산"을 누르세요.</p></div>';
      $('#hActs').innerHTML = '<button class="btn btn-sm" id="hRecalc">현재 단가로 다시 계산</button>';
      $('#hRecalc').onclick = function () { recalcNow(d.meta, d.items); };
      renderSnapshot(d.meta, d.items, $('#hBody'), d, id);
    };
    if (h.detailData) return show(h.detailData);
    api('history.get', { recordId: id }).then(function (d) { h.detailData = d; show(d); }).catch(function (err) {
      if (h.detail === id) $('#hBody').innerHTML = '<div class="card"><p style="margin:0">' + esc(err.message) + '</p></div>';
    });
  }

  /* ───────── 견적모음 ───────── */

  function renderQuotes() {
    var qs = state.quotes;
    if (qs.detail) return renderQuoteDetail();
    var isAdmin = state.user.role === 'admin';
    $('#main').innerHTML =
      '<div class="card">' +
      '<div class="row-between" style="flex-wrap:wrap;margin-bottom:14px"><div><div class="eyebrow">Quotes · 견적모음</div><h2>' + (isAdmin ? '전체 견적모음' : '내 견적모음') + '</h2>' +
      '<p class="muted small" style="margin:6px 0 0">계산 결과나 조회기록에서 <b>견적으로 저장</b>한 것들이 여기에 쌓입니다. 저장 당시 금액 그대로 보관돼요.</p></div>' +
      '<button class="btn btn-sm" id="qReload">새로고침</button></div>' +
      '<div class="toolbar">' +
      '<div class="segmented" id="qStatus">' + [''].concat(QUOTE_STATUS).map(function (st) {
        return '<button type="button" data-s="' + st + '" class="' + (qs.status === st ? 'on' : '') + '">' + (st || '전체') + '</button>';
      }).join('') + '</div>' +
      '<input class="input input-sm" id="qSearch" placeholder="견적명·거래처·메모·주소 검색" value="' + esc(qs.q) + '" style="max-width:280px">' +
      '</div><div id="qList"></div></div>';
    $$('#qStatus button').forEach(function (b) {
      b.onclick = function () { qs.status = b.dataset.s; $$('#qStatus button').forEach(function (x) { x.classList.toggle('on', x === b); }); drawQuoteList(); };
    });
    var st;
    $('#qSearch').oninput = function () { var v = this.value; clearTimeout(st); st = setTimeout(function () { qs.q = v.trim(); drawQuoteList(); }, 200); };
    $('#qReload').onclick = function () { qs.list = null; loadQuotes(); };
    if (qs.list) drawQuoteList(); else loadQuotes();
  }

  function loadQuotes() {
    var l = $('#qList'); if (l) l.innerHTML = '<p class="muted"><span class="spinner dark"></span> 불러오는 중…</p>';
    api('quotes.list').then(function (r) {
      state.quotes.list = r.quotes;
      if (state.view === 'quotes' && !state.quotes.detail) drawQuoteList();
    }).catch(function (err) { var x = $('#qList'); if (x) x.innerHTML = '<p style="color:var(--red)">' + esc(err.message) + '</p>'; });
  }

  function drawQuoteList() {
    var qs = state.quotes, isAdmin = state.user.role === 'admin';
    var list = $('#qList'); if (!list || !qs.list) return;
    var q = qs.q;
    var items = qs.list.filter(function (x) {
      if (qs.status && x.status !== qs.status) return false;
      return !q || (x.name + ' ' + x.client + ' ' + x.memo + ' ' + x.from + ' ' + x.to + ' ' + x.userName).indexOf(q) !== -1;
    });
    var counts = {};
    qs.list.forEach(function (x) { counts[x.status] = (counts[x.status] || 0) + 1; });
    $$('#qStatus button').forEach(function (b) {
      var n = b.dataset.s ? counts[b.dataset.s] || 0 : qs.list.length;
      b.innerHTML = (b.dataset.s || '전체') + ' <span class="cnt">' + n + '</span>';
    });
    if (!items.length) { list.innerHTML = '<p class="muted" style="margin:18px 0 4px">' + (qs.list.length ? '조건에 맞는 견적이 없습니다.' : '아직 저장한 견적이 없어요. 계산 결과에서 <b>견적으로 저장</b>을 눌러 보세요.') + '</p>'; return; }
    list.innerHTML = '<div class="qgrid">' + items.map(function (x, i) {
      return '<button class="qcard" style="--i:' + Math.min(i, 12) + '" data-id="' + esc(x.id) + '">' +
        '<div class="row-between"><span class="qname">' + esc(x.name) + '</span>' + statusPill(x.status) + '</div>' +
        (x.client ? '<div class="qclient">' + esc(x.client) + '</div>' : '') +
        '<div class="qroute"><span class="pin from"></span>' + esc(x.from) + '<br><span class="pin to"></span>' + esc(x.to) + '</div>' +
        (x.memo ? '<div class="qmemo">' + esc(x.memo) + '</div>' : '') +
        '<div class="qfoot"><span class="badge ' + (x.type === '대량' ? 'down' : 'up') + '">' + esc(x.type) + (x.type === '대량' ? ' ' + won(x.count) + '건' : '') + '</span>' +
        '<span>' + (isAdmin ? esc(x.userName) + ' · ' : '') + esc(String(x.savedAt).slice(0, 10)) + '</span></div></button>';
    }).join('') + '</div>';
    $$('.qcard', list).forEach(function (c) { c.onclick = function () { qs.detail = c.dataset.id; qs.detailData = null; renderQuotes(); window.scrollTo(0, 0); }; });
  }

  function renderQuoteDetail() {
    var qs = state.quotes, id = qs.detail;
    $('#main').innerHTML =
      '<div class="row-between" style="margin-bottom:14px;flex-wrap:wrap"><button class="btn btn-sm" id="qBack">← 견적모음</button><div class="actions" id="qActs"></div></div>' +
      '<div id="qHead"><div class="card muted"><span class="spinner dark"></span> 견적을 불러오는 중…</div></div><div id="qBody" style="margin-top:16px"></div>';
    $('#qBack').onclick = function () { qs.detail = null; qs.detailData = null; renderQuotes(); };
    var show = function (d) {
      if (state.view !== 'quotes' || qs.detail !== id) return;
      var q = d.quote;
      $('#qHead').innerHTML = '<div class="card qdetail">' +
        '<div class="row-between" style="flex-wrap:wrap;margin-bottom:12px"><div><div class="eyebrow">Quote · 저장된 견적</div><h2>' + esc(q.name) + '</h2></div>' + statusPill(q.status) + '</div>' +
        '<div class="qedit"><div>' + quoteFieldsHtml(q) + '</div>' +
        '<div class="qmeta"><div><b>저장</b> ' + esc(q.savedAt) + ' · ' + esc(q.userName) + '</div>' + (q.updatedAt && q.updatedAt !== q.savedAt ? '<div><b>수정</b> ' + esc(q.updatedAt) + '</div>' : '') +
        snapshotInfoHtml(d.meta) + '</div></div>' +
        '<div class="actions" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-sm btn-danger" id="qDel">삭제</button><button class="btn btn-sm btn-primary" id="qUpd">변경 저장</button></div></div>';
      var read = bindQuoteFields($('#qHead'));
      $('#qUpd').onclick = function () {
        var f = read(); if (!f.name) return toast('견적명을 입력하세요.', 'err');
        var btn = this; busy(btn, true, '저장 중…');
        api('quotes.update', { id: id, patch: f }).then(function (r) {
          d.quote = r.quote; qs.list = null; toast('변경사항을 저장했습니다.'); show(d);
        }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
      };
      $('#qDel').onclick = function () {
        if (!confirm('"' + q.name + '" 견적을 삭제할까요? 되돌릴 수 없습니다.')) return;
        var btn = this; busy(btn, true, '삭제 중…');
        api('quotes.delete', { id: id }).then(function () {
          qs.detail = null; qs.detailData = null; qs.list = null; toast('삭제했습니다.'); renderQuotes();
        }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
      };
      $('#qActs').innerHTML = '<button class="btn btn-sm" id="qRecalc">현재 단가로 다시 계산</button>';
      $('#qRecalc').onclick = function () { recalcNow(d.meta, d.items); };
      if (!d.drawn) { renderSnapshot(d.meta, d.items, $('#qBody'), d, null); d.drawn = true; }
    };
    if (qs.detailData) { qs.detailData.drawn = false; return show(qs.detailData); }
    api('quotes.get', { id: id }).then(function (d) { qs.detailData = d; show(d); }).catch(function (err) {
      if (qs.detail === id) $('#qHead').innerHTML = '<div class="card"><p style="margin:0">' + esc(err.message) + '</p></div>';
    });
  }

  /* ───────── 매출매입 분석: 데이터 ───────── */
  /*
   * 행 형식(서버 저장): [날짜, 매출처, 발지, 착지, 중량, 매출후불, 매입후불, 차량번호, 기사명, 차량전화, 기타1, 비고]
   * 브라우저에서 덧붙임: [12]=사업자, [13]=표시 매출처, [14]=숨김 여부, [15]=구분('' 운송 / '__x' 제외 / 분류 이름)
   */
  var AN_COLS = ['날짜', '매출처', '발지', '착지', '중량', '매출후불', '매입후불', '차량번호', '기사명', '차량전화', '기타1', '비고'];
  var AN_REQUIRED = ['날짜', '매출처', '매출후불', '매입후불'];
  var C = { date: 0, cust: 1, from: 2, to: 3, weight: 4, sales: 5, buys: 6, car: 7, driver: 8, phone: 9, etc: 10, note: 11, biz: 12, disp: 13, hidden: 14, cat: 15 };
  var AN_SALES_COLOR = '#2A9DB0', AN_BUYS_COLOR = '#D2601A'; // 검증된 2색 (색약·대비 통과)

  function newAnState() {
    return {
      index: null, mapping: {}, businesses: [], rows: null, loading: false, loaded: 0, total: 0, error: null,
      f: { from: '', to: '', biz: [], sel: {}, q: '' }, dim: 'cust', sort: { key: 'sales', dir: -1 }, groupLimit: 50, groupQ: '',
      detailPage: 0, detailSort: -1, view: 'month',
      cmp: 'prev', trendMode: 'profit', routeWeight: true, minN: 1, alert: { drop: 3, minSales: 1000000 },
      anom: { kind: 'buy', th: 20, minN: 3, limit: 30 }
    };
  }

  function b64FromBytes(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function bytesFromB64(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function gzipToB64(text) {
    if (!window.CompressionStream) return Promise.reject(new Error('이 브라우저는 압축 기능을 지원하지 않아요. 최신 크롬이나 엣지를 사용하세요.'));
    var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) { return b64FromBytes(new Uint8Array(buf)); });
  }
  function gunzipB64(b64) {
    if (!window.DecompressionStream) return Promise.reject(new Error('이 브라우저는 압축 해제를 지원하지 않아요. 최신 크롬이나 엣지를 사용하세요.'));
    var stream = new Blob([bytesFromB64(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  /** 구글 시트가 "2026-05"를 날짜로 바꿔 버리므로, 월·사업자는 항상 키("사업자|YYYY-MM")에서 꺼냄 */
  function normAnIndex(list) {
    return (list || []).map(function (x) {
      var parts = String(x.key).split('|');
      x.biz = parts[0]; x.month = parts[1];
      return x;
    }).filter(function (x) { return /^\d{4}-\d{2}$/.test(x.month); });
  }

  function anDisplay(raw) {
    var m = state.an.mapping[raw];
    return m && m.display ? m.display : raw;
  }
  function applyMapping() {
    var an = state.an;
    if (!an.rows) return;
    for (var i = 0; i < an.rows.length; i++) {
      var r = an.rows[i], m = an.mapping[r[C.cust]];
      r[C.disp] = m && m.display ? m.display : r[C.cust];
      r[C.hidden] = !!(m && m.hidden);
    }
  }

  /** 목록 + 전체 데이터 불러오기 (12개 묶음씩 3개 동시) */
  function loadAnalysis(force) {
    var an = state.an;
    if (an.loading) return an.loading;
    if (an.rows && !force) return Promise.resolve();
    an.error = null;
    an.loading = api('analysis.index').then(function (r) {
      an.index = normAnIndex(r.index); an.businesses = r.businesses || ['조일물류', '명일로지스', '조일로지스'];
      an.mapping = {};
      (r.mapping || []).forEach(function (m) { an.mapping[m.raw] = m; });
      an.rules = r.rules || [];
      var keys = an.index.map(function (x) { return x.key; });
      an.total = keys.length; an.loaded = 0;
      var batches = [];
      for (var i = 0; i < keys.length; i += 12) batches.push(keys.slice(i, i + 12));
      var rows = [], next = 0;
      function work() {
        if (next >= batches.length) return Promise.resolve();
        var batch = batches[next++];
        return api('analysis.load', { keys: batch }).then(function (res) {
          return Promise.all(batch.map(function (k) {
            if (!res.data[k]) return null;
            return gunzipB64(res.data[k]).then(function (text) {
              var biz = k.split('|')[0];
              JSON.parse(text).forEach(function (row) { row[C.biz] = biz; rows.push(row); });
            });
          }));
        }).then(function () {
          an.loaded += batch.length;
          var p = $('#anProg'); if (p) p.textContent = an.loaded + ' / ' + an.total;
          return work();
        });
      }
      return Promise.all([work(), work(), work()]).then(function () {
        an.rows = rows;
        applyMapping();
        applyRules();
        var months = anMonths();
        if (!an.f.to || months.indexOf(an.f.to) === -1) { an.f.to = months[months.length - 1] || ''; }
        if (!an.f.from || months.indexOf(an.f.from) === -1) { an.f.from = an.f.to; }
      });
    }).then(function () { an.loading = false; }, function (err) { an.loading = false; an.error = err.message; throw err; });
    return an.loading;
  }

  function anMonths() {
    var set = {};
    (state.an.index || []).forEach(function (x) { set[x.month] = true; });
    return Object.keys(set).sort();
  }

  /* ───────── 매출매입 분석: 엑셀 읽기 ───────── */

  function anNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    var n = Number(String(v).replace(/[,\s원]/g, ''));
    return isFinite(n) ? n : NaN;
  }
  function anDate(v, X) {
    if (v == null || v === '') return '';
    if (v instanceof Date) return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
    if (typeof v === 'number' && X && X.SSF) {
      var d = X.SSF.parse_date_code(v);
      if (d) return d.y + '-' + ('0' + d.m).slice(-2) + '-' + ('0' + d.d).slice(-2);
    }
    var m = String(v).match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
  }
  function guessBiz(name) {
    if (/명일/.test(name)) return '명일로지스';
    if (/로지스/.test(name)) return '조일로지스';
    if (/조일|물류/.test(name)) return '조일물류';
    return '';
  }

  /** 엑셀 파일 하나 → { rows, months, sums, totalRow, warnings } */
  function parseAnFile(file) {
    return Promise.all([loadXlsx(), file.arrayBuffer()]).then(function (res) {
      var X = res[0];
      var wb = X.read(new Uint8Array(res[1]), { type: 'array', cellDates: true });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var grid = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      var hi = -1;
      for (var i = 0; i < Math.min(grid.length, 20); i++) {
        var row = grid[i].map(function (c) { return String(c).trim(); });
        if (row.indexOf('날짜') !== -1 && row.indexOf('매출처') !== -1) { hi = i; break; }
      }
      if (hi === -1) throw new Error('"날짜", "매출처" 제목이 있는 줄을 찾지 못했습니다.');
      var head = grid[hi].map(function (c) { return String(c).trim(); });
      var idx = AN_COLS.map(function (c) { return head.indexOf(c); });
      var missing = AN_REQUIRED.filter(function (c) { return head.indexOf(c) === -1; });
      if (missing.length) throw new Error('필수 열이 없습니다: ' + missing.join(', '));
      var warnings = [];
      var optMissing = AN_COLS.filter(function (c, k) { return idx[k] === -1; });
      if (optMissing.length) warnings.push('없는 열(빈칸으로 저장): ' + optMissing.join(', '));

      var rows = [], totalRow = null, badDate = 0, badNum = 0;
      for (var r = hi + 1; r < grid.length; r++) {
        var g = grid[r];
        var dateRaw = g[idx[0]];
        var vals = idx.map(function (k) { return k === -1 ? '' : g[k]; });
        if (dateRaw === '' || dateRaw == null) {
          // 날짜 없는 줄: 합계 줄인지 확인
          if (anNum(vals[5]) || anNum(vals[6])) totalRow = { sales: anNum(vals[5]), buys: anNum(vals[6]) };
          continue;
        }
        var d = anDate(dateRaw, X);
        if (!d) { badDate++; continue; }
        var s = anNum(vals[5]), b = anNum(vals[6]);
        if (isNaN(s) || isNaN(b)) { badNum++; s = isNaN(s) ? 0 : s; b = isNaN(b) ? 0 : b; }
        rows.push([d, String(vals[1]), String(vals[2]), String(vals[3]), String(vals[4]), s, b, String(vals[7]), String(vals[8]), String(vals[9]), String(vals[10]), String(vals[11])]);
      }
      if (badDate) warnings.push('날짜를 읽지 못한 ' + badDate + '줄은 제외했어요.');
      if (badNum) warnings.push('금액이 숫자가 아닌 ' + badNum + '줄은 0원으로 처리했어요.');
      var sums = rows.reduce(function (a, x) { a.sales += x[5]; a.buys += x[6]; return a; }, { sales: 0, buys: 0 });
      var months = {};
      rows.forEach(function (x) { var m = x[0].slice(0, 7); months[m] = (months[m] || 0) + 1; });
      return { rows: rows, sums: sums, totalRow: totalRow, months: months, warnings: warnings };
    });
  }

  /* ───────── 관리자: 분석 데이터 ───────── */

  function adminAnData() {
    var a = state.admin, up = a.anUpload || (a.anUpload = { files: [] });
    var body = $('#adminBody');
    var idx = state.an.index;
    body.innerHTML =
      '<div class="card" style="margin-bottom:16px"><div class="eyebrow">Upload · 분석 데이터</div><h2>매출매입 엑셀 올리기</h2>' +
      '<p class="muted small" style="margin:6px 0 16px">전산에서 받은 사업자별 월 엑셀을 그대로 올리세요. <b>같은 사업자·같은 달을 다시 올리면 덮어씁니다.</b> 파일 맨 아래 합계 줄과 자동으로 대조해요.</p>' +
      '<label class="dropzone" id="anDrop"><input type="file" id="anFile" accept=".xlsx,.xls,.csv" multiple hidden>' +
      '<div class="big-stripes"></div><b>엑셀 파일을 여기에 끌어다 놓거나 눌러서 고르세요</b><span class="hint">여러 개를 한 번에 올릴 수 있어요 · 열: ' + AN_COLS.join(', ') + '</span></label>' +
      '<div id="anFiles"></div></div>' +
      '<div class="card" style="--i:1;margin-bottom:16px"><div class="row-between" style="flex-wrap:wrap;margin-bottom:12px"><h3>저장된 데이터</h3><button class="btn btn-sm" id="anIdxReload">새로고침</button></div><div id="anIdx">' +
      (idx ? '' : '<p class="muted"><span class="spinner dark"></span> 불러오는 중…</p>') + '</div></div>' +
      '<div class="card" style="--i:2"><div class="row-between" style="margin-bottom:12px"><h3>분석 화면 접속 기록</h3><button class="btn btn-sm" id="anLogLoad">불러오기</button></div><div id="anLog" class="muted small">누가 언제 분석 데이터를 열었는지 보여줍니다.</div></div>';

    var input = $('#anFile'), drop = $('#anDrop');
    input.onchange = function () { addFiles(this.files); this.value = ''; };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function () { drop.classList.remove('over'); };
    drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
    $('#anIdxReload').onclick = function () { state.an.index = null; adminAnData(); };
    $('#anLogLoad').onclick = function () {
      var btn = this; busy(btn, true, '불러오는 중…');
      api('analysis.accessLog').then(function (r) {
        $('#anLog').innerHTML = r.logs.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>일시</th><th class="left">사용자</th></tr></thead><tbody>' +
          r.logs.map(function (l) { return '<tr><td class="small muted">' + esc(l.at) + '</td><td class="left">' + esc(l.name) + ' <span class="muted small">' + esc(l.id) + '</span></td></tr>'; }).join('') +
          '</tbody></table></div>' : '기록이 없습니다.';
      }).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };

    function addFiles(list) {
      Array.prototype.slice.call(list).forEach(function (file) {
        var item = { file: file, name: file.name, biz: guessBiz(file.name), status: 'parsing' };
        up.files.push(item);
        parseAnFile(file).then(function (p) { item.parsed = p; item.status = 'ready'; }, function (err) { item.status = 'error'; item.error = err.message; })
          .then(drawFiles);
      });
      drawFiles();
    }

    function drawFiles() {
      var box = $('#anFiles'); if (!box) return;
      var existing = {};
      (state.an.index || []).forEach(function (x) { existing[x.key] = x; });
      if (!up.files.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="anfiles">' + up.files.map(function (it, i) {
        var p = it.parsed, html = '<div class="anfile ' + it.status + '"><div class="row-between" style="flex-wrap:wrap;gap:8px"><b class="fname">' + esc(it.name) + '</b>' +
          '<div class="actions"><select class="input input-sm" data-biz="' + i + '" style="width:auto"' + (it.status === 'done' ? ' disabled' : '') + '><option value="">사업자 선택</option>' +
          (state.an.businesses.length ? state.an.businesses : ['조일물류', '명일로지스', '조일로지스']).map(function (b) { return '<option' + (it.biz === b ? ' selected' : '') + '>' + b + '</option>'; }).join('') +
          '</select><button class="btn btn-ghost btn-sm" data-rm="' + i + '" title="목록에서 빼기">✕</button></div></div>';
        if (it.status === 'parsing') html += '<p class="muted small"><span class="spinner dark"></span> 읽는 중…</p>';
        if (it.status === 'error') html += '<p class="err-text">⚠ ' + esc(it.error) + '</p>';
        if (p) {
          var tot = p.totalRow;
          var okS = tot && tot.sales === p.sums.sales, okB = tot && tot.buys === p.sums.buys;
          var months = Object.keys(p.months).sort();
          html += '<div class="anfile-stats"><span><b>' + won(p.rows.length) + '</b>건</span><span>' + months.map(function (m) {
            var ex = it.biz && existing[it.biz + '|' + m];
            return esc(m) + (ex ? ' <span class="badge down">덮어씀</span>' : '');
          }).join(', ') + '</span><span>매출 <b class="num">' + won(p.sums.sales) + '</b></span><span>매입 <b class="num">' + won(p.sums.buys) + '</b></span>' +
            (tot ? '<span class="' + (okS && okB ? 'ok-text' : 'err-text') + '">' + (okS && okB ? '✓ 합계 줄과 일치' : '⚠ 합계 줄과 다름 (파일 합계 매출 ' + won(tot.sales) + ' / 매입 ' + won(tot.buys) + ')') + '</span>' : '<span class="muted">합계 줄 없음</span>') +
            '</div>' + (p.warnings.length ? '<p class="hint" style="margin:6px 0 0">' + p.warnings.map(esc).join('<br>') + '</p>' : '');
        }
        if (it.status === 'done') html += '<p class="ok-text small" style="margin:6px 0 0">✓ 업로드 완료</p>';
        if (it.status === 'uploading') html += '<p class="muted small" style="margin:6px 0 0"><span class="spinner dark"></span> 올리는 중…</p>';
        if (it.upErr) html += '<p class="err-text small">⚠ ' + esc(it.upErr) + '</p>';
        return html + '</div>';
      }).join('') + '</div>' +
        '<div class="actions" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="anClear">목록 비우기</button><button class="btn btn-accent" id="anUp">업로드</button></div>';
      $$('[data-biz]', box).forEach(function (sel) { sel.onchange = function () { up.files[this.dataset.biz].biz = this.value; drawFiles(); }; });
      $$('[data-rm]', box).forEach(function (b) { b.onclick = function () { up.files.splice(Number(b.dataset.rm), 1); drawFiles(); }; });
      $('#anClear').onclick = function () { up.files = []; drawFiles(); };
      $('#anUp').onclick = function () { uploadAll(this); };
    }

    function uploadAll(btn) {
      var todo = up.files.filter(function (it) { return it.status === 'ready'; });
      if (!todo.length) return toast('올릴 파일이 없습니다.', 'err');
      if (todo.some(function (it) { return !it.biz; })) return toast('모든 파일의 사업자를 선택하세요.', 'err');
      var mismatch = todo.filter(function (it) { var t = it.parsed.totalRow; return t && (t.sales !== it.parsed.sums.sales || t.buys !== it.parsed.sums.buys); });
      if (mismatch.length && !confirm('합계 줄과 다른 파일이 ' + mismatch.length + '개 있습니다. 그래도 올릴까요?')) return;
      busy(btn, true, '업로드 중…');
      var chain = Promise.resolve();
      todo.forEach(function (it) {
        chain = chain.then(function () {
          it.status = 'uploading'; it.upErr = null; drawFiles();
          var byMonth = {};
          it.parsed.rows.forEach(function (r) { (byMonth[r[0].slice(0, 7)] = byMonth[r[0].slice(0, 7)] || []).push(r); });
          var c2 = Promise.resolve();
          Object.keys(byMonth).sort().forEach(function (m) {
            c2 = c2.then(function () {
              return gzipToB64(JSON.stringify(byMonth[m])).then(function (b64) {
                var sum = byMonth[m].reduce(function (a, r) { a.s += r[5]; a.b += r[6]; return a; }, { s: 0, b: 0 });
                return api('analysis.upload', { biz: it.biz, month: m, data: b64, count: byMonth[m].length, sales: sum.s, buys: sum.b, fileName: it.name });
              });
            });
          });
          return c2.then(function () { it.status = 'done'; }, function (err) { it.status = 'ready'; it.upErr = err.message; });
        });
      });
      chain.then(function () {
        busy(btn, false);
        state.an.rows = null; state.an.index = null; // 분석 화면이 새로 불러오도록
        var failed = todo.filter(function (it) { return it.upErr; }).length;
        toast(failed ? '일부 파일이 실패했어요. 확인 후 다시 시도하세요.' : '업로드했습니다.', failed ? 'err' : 'ok');
        loadIndex();
      });
    }

    function loadIndex() {
      api('analysis.index').then(function (r) {
        state.an.index = normAnIndex(r.index); state.an.businesses = r.businesses;
        state.an.mapping = {}; (r.mapping || []).forEach(function (m) { state.an.mapping[m.raw] = m; });
        state.an.rules = r.rules || [];
        drawIndex(); drawFiles();
      }).catch(function (err) { var x = $('#anIdx'); if (x) x.innerHTML = '<p class="err-text">' + esc(err.message) + '</p>'; });
    }

    function drawIndex() {
      var box = $('#anIdx'); if (!box) return;
      var list = (state.an.index || []).slice().sort(function (x, y) { return x.month < y.month ? 1 : x.month > y.month ? -1 : x.biz < y.biz ? -1 : 1; });
      if (!list.length) { box.innerHTML = '<p class="muted">아직 올린 데이터가 없습니다.</p>'; return; }
      var tot = list.reduce(function (a, x) { a.c += x.count; a.s += x.sales; a.b += x.buys; return a; }, { c: 0, s: 0, b: 0 });
      box.innerHTML = '<p class="muted small" style="margin:0 0 10px">' + list.length + '묶음 · 총 ' + won(tot.c) + '건 · 매출 ' + won(tot.s) + '원 · 매입 ' + won(tot.b) + '원</p>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>월</th><th class="left">사업자</th><th>건수</th><th>매출</th><th>매입</th><th>이익률</th><th class="left">파일 · 올린 사람</th><th></th></tr></thead><tbody>' +
        list.map(function (x) {
          var rate = x.sales ? ((x.sales - x.buys) / x.sales * 100).toFixed(1) + '%' : '–';
          return '<tr><td class="ton">' + esc(x.month) + '</td><td class="left">' + esc(x.biz) + '</td><td class="num">' + won(x.count) + '</td><td class="num">' + won(x.sales) + '</td><td class="num">' + won(x.buys) + '</td><td class="num">' + rate + '</td>' +
            '<td class="left small muted wrap">' + esc(x.fileName) + '<br>' + esc(x.uploadedAt) + ' · ' + esc(x.uploader) + '</td>' +
            '<td><button class="btn btn-sm btn-danger" data-del="' + esc(x.key) + '">삭제</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      $$('[data-del]', box).forEach(function (b) {
        b.onclick = function () {
          if (!confirm(b.dataset.del.replace('|', ' ') + ' 데이터를 삭제할까요?')) return;
          busy(b, true, '…');
          api('analysis.delete', { key: b.dataset.del }).then(function () { toast('삭제했습니다.'); state.an.rows = null; loadIndex(); })
            .catch(function (err) { busy(b, false); toast(err.message, 'err'); });
        };
      });
    }

    drawFiles();
    if (idx) drawIndex(); else loadIndex();
  }

  /* ───────── 관리자: 매출처 설정 ───────── */

  function adminAnMap() {
    var body = $('#adminBody'), an = state.an, a = state.admin;
    if (!an.rows) {
      body.innerHTML = '<div class="card"><span class="spinner dark"></span> 매출처 목록을 만들려고 전체 데이터를 불러오는 중… <span id="anProg" class="muted"></span></div>';
      loadAnalysis().then(function () { if (state.view === 'admin' && a.tab === 'anmap') adminAnMap(); })
        .catch(function (err) { body.innerHTML = '<div class="card"><p class="err-text">' + esc(err.message) + '</p></div>'; });
      return;
    }
    var mm = a.anMap || (a.anMap = { edits: {}, q: '', filter: 'all', dirty: false });
    // 원본 매출처별 통계
    var stats = {};
    an.rows.forEach(function (r) {
      var s = stats[r[C.cust]] || (stats[r[C.cust]] = { raw: r[C.cust], n: 0, sales: 0, buys: 0, first: r[C.date], last: r[C.date] });
      s.n++; s.sales += r[C.sales]; s.buys += r[C.buys];
      if (r[C.date] < s.first) s.first = r[C.date];
      if (r[C.date] > s.last) s.last = r[C.date];
    });
    var list = Object.keys(stats).map(function (k) { return stats[k]; }).sort(function (x, y) { return y.sales - x.sales; });
    function cur(raw) {
      var e = mm.edits[raw], m = an.mapping[raw] || {};
      return e || { display: m.display || '', hidden: !!m.hidden };
    }
    var groupCount = {};
    list.forEach(function (s) { var d = cur(s.raw).display || s.raw; groupCount[d] = (groupCount[d] || 0) + 1; });

    body.innerHTML =
      '<div class="card"><div class="eyebrow">Customers · 매출처 설정</div><h2>매출처 표시 이름 · 묶기 · 숨기기</h2>' +
      '<p class="muted small" style="margin:6px 0 14px">업로드된 데이터의 <b>모든 매출처</b>가 나와요. 표시 이름을 정하면 분석 화면에서 그 이름으로 보이고, <b>서로 다른 매출처라도 표시 이름이 같으면 합쳐서</b> 집계돼요. 숨김을 켜면 분석에서 빠집니다.</p>' +
      '<div class="toolbar"><input class="input input-sm" id="mapQ" placeholder="매출처·표시 이름 검색" value="' + esc(mm.q) + '" style="max-width:260px">' +
      '<div class="segmented" id="mapF">' + [['all', '전체'], ['set', '이름 정함'], ['unset', '안 정함'], ['hidden', '숨김'], ['merged', '묶인 것']].map(function (x) {
        return '<button type="button" data-f="' + x[0] + '" class="' + (mm.filter === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
      }).join('') + '</div>' +
      '<button class="btn btn-sm" id="mapStrip" title="표시 이름이 비어 있는 매출처에 (담당 ○○○) 표기를 뺀 이름을 채웁니다">담당자 표기 뺀 이름으로 채우기</button></div>' +
      '<div class="bulk-table" style="max-height:62vh"><table class="data bulk mapt"><thead><tr><th class="left">원본 매출처</th><th>건수</th><th>매출</th><th>매입</th><th class="left">기간</th><th class="left">표시 이름</th><th>숨김</th></tr></thead><tbody id="mapBody"></tbody></table></div>' +
      '<div class="save-bar"><span class="small muted" id="mapDirty" style="margin-right:auto"></span><button class="btn btn-accent" id="mapSave">저장</button></div></div>';

    function visible() {
      var q = mm.q.trim();
      return list.filter(function (s) {
        var c = cur(s.raw), d = c.display || s.raw;
        if (q && (s.raw + ' ' + c.display).indexOf(q) === -1) return false;
        if (mm.filter === 'set' && !c.display) return false;
        if (mm.filter === 'unset' && c.display) return false;
        if (mm.filter === 'hidden' && !c.hidden) return false;
        if (mm.filter === 'merged' && groupCount[d] < 2) return false;
        return true;
      });
    }
    function drawRows() {
      groupCount = {};
      list.forEach(function (s) { var d = cur(s.raw).display || s.raw; groupCount[d] = (groupCount[d] || 0) + 1; });
      var rows = visible();
      $('#mapBody').innerHTML = rows.map(function (s, i) {
        var c = cur(s.raw), d = c.display || s.raw;
        return '<tr class="' + (c.hidden ? 'muted-row' : '') + '"><td class="left wrap"><div class="addr">' + esc(s.raw) + '</div></td>' +
          '<td class="num">' + won(s.n) + '</td><td class="num">' + won(s.sales) + '</td><td class="num">' + won(s.buys) + '</td>' +
          '<td class="left small muted">' + esc(s.first.slice(0, 7)) + (s.first.slice(0, 7) !== s.last.slice(0, 7) ? ' ~ ' + esc(s.last.slice(0, 7)) : '') + '</td>' +
          '<td class="left"><input class="input input-sm" data-raw="' + i + '" value="' + esc(c.display) + '" placeholder="' + esc(s.raw) + '" style="min-width:220px">' +
          (groupCount[d] > 1 ? '<span class="badge region" style="margin-left:6px">' + groupCount[d] + '곳 합침</span>' : '') + '</td>' +
          '<td><label class="toggle"><input type="checkbox" data-hide="' + i + '"' + (c.hidden ? ' checked' : '') + '><span class="track"></span></label></td></tr>';
      }).join('') || '<tr><td colspan="7" class="left muted" style="padding:20px">조건에 맞는 매출처가 없습니다.</td></tr>';
      $$('#mapBody [data-raw]').forEach(function (inp) {
        inp.onchange = function () {
          var raw = rows[this.dataset.raw].raw, v = this.value.trim();
          if (v === cur(raw).display) return;
          edit(raw, { display: v }); redraw();
        };
      });
      $$('#mapBody [data-hide]').forEach(function (cb) {
        cb.onchange = function () { edit(rows[this.dataset.hide].raw, { hidden: this.checked }); redraw(); };
      });
      $('#mapDirty').innerHTML = (mm.dirty ? '<span class="dirty-dot"></span>저장하지 않은 변경사항 · ' : '') + list.length + '개 매출처 → 표시 ' + Object.keys(groupCount).length + '개';
    }
    function edit(raw, patch) {
      mm.edits[raw] = Object.assign({}, cur(raw), patch);
      mm.dirty = true;
    }
    // 입력칸에서 포커스가 빠지며 다시 그리는 경우가 겹치지 않도록 한 박자 늦게
    var redrawTimer = null;
    function redraw() { clearTimeout(redrawTimer); redrawTimer = setTimeout(drawRows, 0); }
    var st;
    $('#mapQ').oninput = function () { var v = this.value; clearTimeout(st); st = setTimeout(function () { mm.q = v; drawRows(); }, 200); };
    $$('#mapF button').forEach(function (b) { b.onclick = function () { mm.filter = b.dataset.f; $$('#mapF button').forEach(function (x) { x.classList.toggle('on', x === b); }); drawRows(); }; });
    $('#mapStrip').onclick = function () {
      var n = 0;
      list.forEach(function (s) {
        if (cur(s.raw).display) return;
        var cleaned = s.raw.replace(/\s*[-=]?\s*\(\s*담당[^)]*\)\s*$/, '').trim();
        if (cleaned && cleaned !== s.raw) { edit(s.raw, { display: cleaned }); n++; }
      });
      toast(n ? n + '곳의 표시 이름을 채웠어요. 확인 후 저장하세요.' : '바꿀 매출처가 없습니다.');
      drawRows();
    };
    $('#mapSave').onclick = function () {
      var btn = this;
      var focused = document.activeElement;
      if (focused && focused.dataset && focused.dataset.raw != null && focused.onchange) focused.onchange();
      var all = {};
      Object.keys(an.mapping).forEach(function (k) { all[k] = an.mapping[k]; });
      Object.keys(mm.edits).forEach(function (k) { all[k] = { raw: k, display: mm.edits[k].display, hidden: mm.edits[k].hidden }; });
      var payload = Object.keys(all).map(function (k) { return { raw: k, display: all[k].display || '', hidden: !!all[k].hidden }; })
        .filter(function (m) { return m.display || m.hidden; });
      busy(btn, true, '저장 중…');
      api('analysis.saveMap', { map: payload }).then(function () {
        an.mapping = {}; payload.forEach(function (m) { an.mapping[m.raw] = m; });
        mm.edits = {}; mm.dirty = false;
        applyMapping();
        toast('매출처 설정을 저장했습니다.');
        busy(btn, false); drawRows();
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    drawRows();
  }

  /* ───────── 분석: 제외·분류 규칙 ───────── */

  var RULE_FIELDS = [['any', '아무 칸'], ['cust', '매출처'], ['from', '발지'], ['to', '착지'], ['weight', '중량'], ['car', '차량번호'], ['driver', '기사명'], ['etc', '기타1'], ['note', '비고']];
  var RULE_MODES = [['eq', '정확히 같음'], ['contains', '포함'], ['starts', '으로 시작']];
  var RULE_ANY = [C.cust, C.from, C.to, C.weight, C.car, C.driver, C.etc, C.note];

  function ruleMatch(rule, r) {
    if (rule.on === false || !rule.word) return false;
    if (rule.biz && r[C.biz] !== rule.biz) return false;
    var w = String(rule.word).trim();
    var test = function (v) {
      v = String(v == null ? '' : v).trim();
      return rule.mode === 'eq' ? v === w : rule.mode === 'starts' ? v.indexOf(w) === 0 : v.indexOf(w) !== -1;
    };
    if (rule.field === 'any') return RULE_ANY.some(function (i) { return test(r[i]); });
    return test(r[C[rule.field]]);
  }

  /** 행 구분: '' = 운송, '__x' = 제외, 그 외 = 분류 이름. 위 규칙부터 먼저 걸린 것 하나만 적용 */
  function ruleOf(rules, r) {
    for (var i = 0; i < rules.length; i++) if (ruleMatch(rules[i], r)) return rules[i].action === 'class' ? rules[i].cat : '__x';
    return '';
  }

  function applyRules() {
    var an = state.an, rules = an.rules || [];
    if (!an.rows) return;
    for (var i = 0; i < an.rows.length; i++) an.rows[i][C.cat] = ruleOf(rules, an.rows[i]);
    an.hasCats = rules.some(function (r) { return r.on !== false && r.action === 'class'; });
  }

  function adminAnRules() {
    var body = $('#adminBody'), an = state.an, a = state.admin;
    if (!an.rows) {
      body.innerHTML = '<div class="card"><span class="spinner dark"></span> 규칙을 미리 볼 데이터를 불러오는 중… <span id="anProg" class="muted"></span></div>';
      loadAnalysis().then(function () { if (state.view === 'admin' && a.tab === 'anrule') adminAnRules(); })
        .catch(function (err) { body.innerHTML = '<div class="card"><p class="err-text">' + esc(err.message) + '</p></div>'; });
      return;
    }
    var ed = a.anRules || (a.anRules = { rules: clone(an.rules || []), dirty: false, open: -1 });
    body.innerHTML =
      '<div class="card"><div class="eyebrow">Rules · 제외 · 분류 규칙</div><h2>보고에서 뺄 항목 · 따로 볼 항목</h2>' +
      '<p class="muted small" style="margin:6px 0 14px">인건비·창고비·대여료처럼 운송 실적이 아닌 행을 <b>제외</b>하거나, <b>분류</b>(예: 부대비용)로 따로 모아 볼 수 있어요. ' +
      '원본은 그대로 두고 보여줄 때만 적용돼서, 지난 데이터와 앞으로 올릴 데이터 모두에 똑같이 적용되고 언제든 되돌릴 수 있어요. ' +
      '<b>위에 있는 규칙부터</b> 검사해서 처음 걸린 규칙 하나만 적용돼요. 분석 화면에는 제외 사실이 표시되지 않아요.</p>' +
      '<div id="ruleSum" class="rule-sum"></div><div id="ruleList"></div>' +
      '<button class="btn" id="ruleAdd" style="margin-top:12px">+ 규칙 추가</button>' +
      '<div class="save-bar"><span class="small muted" id="ruleDirty" style="margin-right:auto"></span><button class="btn btn-accent" id="ruleSave">저장</button></div></div>';

    function stats() {
      // 규칙마다 "이 규칙 때문에" 걸린 행 (앞 규칙에 먼저 걸린 건 제외)
      var per = ed.rules.map(function () { return { n: 0, s: 0, b: 0, rows: [] }; }), tot = { x: { n: 0, s: 0, b: 0 }, c: { n: 0, s: 0, b: 0 } };
      an.rows.forEach(function (r) {
        for (var i = 0; i < ed.rules.length; i++) {
          if (ruleMatch(ed.rules[i], r)) {
            var p = per[i]; p.n++; p.s += r[C.sales]; p.b += r[C.buys]; if (p.rows.length < 30) p.rows.push(r);
            var t = ed.rules[i].action === 'class' ? tot.c : tot.x; t.n++; t.s += r[C.sales]; t.b += r[C.buys];
            break;
          }
        }
      });
      return { per: per, tot: tot };
    }
    function draw() {
      var st = stats();
      $('#ruleSum').innerHTML = '<span><b>제외</b> ' + won(st.tot.x.n) + '건 · 매출 ' + won(st.tot.x.s) + ' · 매입 ' + won(st.tot.x.b) + '</span>' +
        '<span><b>분류</b> ' + won(st.tot.c.n) + '건 · 매출 ' + won(st.tot.c.s) + ' · 매입 ' + won(st.tot.c.b) + '</span>' +
        '<span class="muted">전체 ' + won(an.rows.length) + '건 기준 · 숨긴 매출처 포함</span>';
      $('#ruleList').innerHTML = ed.rules.length ? ed.rules.map(function (rule, i) {
        var p = st.per[i];
        return '<div class="rulebox' + (rule.on === false ? ' off' : '') + '" data-i="' + i + '">' +
          '<div class="rulerow">' +
          '<label class="toggle" title="켜기/끄기"><input type="checkbox" data-f="on"' + (rule.on !== false ? ' checked' : '') + '><span class="track"></span></label>' +
          '<select class="input input-sm" data-f="field">' + RULE_FIELDS.map(function (o) { return '<option value="' + o[0] + '"' + (rule.field === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
          '<span class="muted small">이(가)</span>' +
          '<input class="input input-sm" data-f="word" value="' + esc(rule.word || '') + '" placeholder="단어 (예: 인건비)" style="min-width:150px;flex:1">' +
          '<select class="input input-sm" data-f="mode">' + RULE_MODES.map(function (o) { return '<option value="' + o[0] + '"' + (rule.mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
          '<span class="muted small">이면</span>' +
          '<select class="input input-sm" data-f="action"><option value="exclude"' + (rule.action !== 'class' ? ' selected' : '') + '>제외</option><option value="class"' + (rule.action === 'class' ? ' selected' : '') + '>분류</option></select>' +
          (rule.action === 'class' ? '<input class="input input-sm" data-f="cat" value="' + esc(rule.cat || '') + '" placeholder="분류 이름 (예: 부대비용)" style="width:150px">' : '') +
          '<select class="input input-sm" data-f="biz"><option value="">모든 사업자</option>' + an.businesses.map(function (b) { return '<option' + (rule.biz === b ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('') + '</select>' +
          '<span class="rule-ctl"><button class="btn btn-ghost btn-sm" data-mv="-1" title="위로">↑</button><button class="btn btn-ghost btn-sm" data-mv="1" title="아래로">↓</button><button class="btn btn-ghost btn-sm btn-danger" data-del title="삭제">✕</button></span>' +
          '</div>' +
          '<div class="rulemeta"><input class="input input-sm" data-f="memo" value="' + esc(rule.memo || '') + '" placeholder="메모 (왜 빼는지)" style="flex:1;min-width:180px">' +
          '<button class="btn btn-sm" data-peek>' + (rule.word ? '걸리는 행 <b>' + won(p.n) + '건</b> · 매출 ' + won(p.s) + ' · 매입 ' + won(p.b) : '단어를 입력하세요') + ' ' + (ed.open === i ? '▲' : '▼') + '</button></div>' +
          (ed.open === i && p.rows.length ? '<div class="bulk-table" style="max-height:300px;margin-top:8px"><table class="data bulk"><thead><tr><th class="left">날짜</th><th class="left">사업자</th><th class="left">매출처</th><th class="left">발지</th><th class="left">착지</th><th class="left">중량</th><th>매출</th><th>매입</th><th class="left">차량번호</th><th class="left">기타1</th><th class="left">비고</th></tr></thead><tbody>' +
            p.rows.map(function (r) { return '<tr><td class="left small">' + esc(r[C.date]) + '</td><td class="left small">' + esc(r[C.biz]) + '</td><td class="left wrap">' + esc(r[C.cust]) + '</td><td class="left wrap">' + esc(r[C.from]) + '</td><td class="left wrap">' + esc(r[C.to]) + '</td><td class="left">' + esc(r[C.weight]) + '</td><td class="num">' + won(r[C.sales]) + '</td><td class="num">' + won(r[C.buys]) + '</td><td class="left">' + esc(r[C.car]) + '</td><td class="left small wrap">' + esc(r[C.etc]) + '</td><td class="left small wrap">' + esc(r[C.note]) + '</td></tr>'; }).join('') +
            '</tbody></table></div>' + (p.n > 30 ? '<p class="hint" style="margin:6px 0 0">앞의 30건만 보여요.</p>' : '') : '') +
          '</div>';
      }).join('') : '<p class="muted" style="margin:6px 0">아직 규칙이 없어요. "+ 규칙 추가"를 눌러 보세요. 예) 착지가 "인건비"와 <b>정확히 같음</b>이면 제외</p>';
      $('#ruleDirty').innerHTML = (ed.dirty ? '<span class="dirty-dot"></span>저장하지 않은 변경사항 · ' : '') + ed.rules.length + '개 규칙';
      bind();
    }
    var t;
    function later() { clearTimeout(t); t = setTimeout(draw, 0); }
    function bind() {
      $$('#ruleList .rulebox').forEach(function (box) {
        var i = Number(box.dataset.i), rule = ed.rules[i];
        $$('[data-f]', box).forEach(function (el) {
          var ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'onchange' : 'onchange';
          el[ev] = function () {
            var f = el.dataset.f, v = el.type === 'checkbox' ? el.checked : el.value;
            if (rule[f] === v) return;
            rule[f] = v; ed.dirty = true;
            if (f !== 'memo') later(); else $('#ruleDirty').innerHTML = '<span class="dirty-dot"></span>저장하지 않은 변경사항 · ' + ed.rules.length + '개 규칙';
          };
        });
        $('[data-peek]', box).onclick = function () { ed.open = ed.open === i ? -1 : i; draw(); };
        $('[data-del]', box).onclick = function () { if (!confirm('이 규칙을 삭제할까요?')) return; ed.rules.splice(i, 1); ed.dirty = true; ed.open = -1; draw(); };
        $$('[data-mv]', box).forEach(function (b) {
          b.onclick = function () {
            var j = i + Number(b.dataset.mv); if (j < 0 || j >= ed.rules.length) return;
            var tmp = ed.rules[i]; ed.rules[i] = ed.rules[j]; ed.rules[j] = tmp; ed.dirty = true; ed.open = -1; draw();
          };
        });
      });
    }
    $('#ruleAdd').onclick = function () { ed.rules.push({ on: true, field: 'to', mode: 'eq', word: '', action: 'exclude', cat: '', biz: '', memo: '' }); ed.dirty = true; draw(); var w = $$('#ruleList [data-f="word"]'); if (w.length) w[w.length - 1].focus(); };
    $('#ruleSave').onclick = function () {
      var btn = this, fe = document.activeElement;
      if (fe && fe.dataset && fe.dataset.f && fe.onchange) fe.onchange();
      if (ed.rules.some(function (r) { return !String(r.word || '').trim(); })) return toast('단어가 비어 있는 규칙이 있어요.', 'err');
      if (ed.rules.some(function (r) { return r.action === 'class' && !String(r.cat || '').trim(); })) return toast('분류 규칙에는 분류 이름을 넣어 주세요.', 'err');
      busy(btn, true, '저장 중…');
      api('analysis.saveRules', { rules: ed.rules }).then(function (r) {
        an.rules = r.rules; ed.rules = clone(r.rules); ed.dirty = false;
        applyRules(); toast('규칙을 저장했습니다. 분석 화면에 바로 반영돼요.'); busy(btn, false); draw();
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    draw();
  }

  /* ───────── 관리자: 유가 기록 ───────── */

  function adminDiesel() {
    var a = state.admin, body = $('#adminBody');
    var dz = a.diesel || (a.diesel = { rows: null, status: null, range: 90 });
    if (!dz.rows) {
      body.innerHTML = '<div class="card"><span class="spinner dark"></span> 유가 기록 불러오는 중…</div>';
      api('admin.dieselHistory').then(function (r) { dz.rows = r.rows; dz.status = r.status; if (state.view === 'admin' && a.tab === 'diesel') adminDiesel(); })
        .catch(function (err) { body.innerHTML = '<div class="card"><p class="err-text">' + esc(err.message) + '</p></div>'; });
      return;
    }
    var st = dz.status || {}, rows = dz.rows;
    var shown = dz.range ? rows.slice(-dz.range) : rows;
    var data = shown.map(function (r) { return { d: r[0], p: Number(r[1]) }; });
    var prev = rows.length > 1 ? rows[rows.length - 2][1] : null, last = rows.length ? rows[rows.length - 1][1] : null;
    var diff = last != null && prev != null ? last - prev : null;
    body.innerHTML =
      '<div class="card" style="margin-bottom:16px"><div class="row-between" style="flex-wrap:wrap;gap:10px"><div><div class="eyebrow">Diesel · 유가 기록</div><h2>전국 평균 경유가</h2></div>' +
      '<div class="actions"><button class="btn btn-sm" id="dzNow"' + (st.hasKey ? '' : ' disabled') + '>지금 오피넷에서 받기</button><label class="btn btn-sm" for="dzFile">과거 유가 엑셀 가져오기</label><input type="file" id="dzFile" accept=".xlsx,.xls,.csv" hidden></div></div>' +
      '<div class="dz-head"><div class="dz-price"><span class="num">' + (last != null ? won(Math.round(last)) : '–') + '</span><span class="small">원/L</span>' +
      (diff != null ? '<span class="dz-diff ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '') + '">' + (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '') + Math.abs(diff).toFixed(2) + '</span>' : '') + '</div>' +
      '<div class="dz-meta"><span><b>마지막 기록</b> ' + esc(st.last || '없음') + '</span><span><b>기록</b> ' + won(st.count || 0) + '일' + (st.first ? ' (' + esc(st.first) + '부터)' : '') + '</span>' +
      '<span><b>매일 자동 기록</b> ' + (st.triggerOn ? '<span class="status-pill ok">켜짐 · 매일 아침 7시</span>' : st.triggerOn === false ? '<span class="status-pill no">꺼짐</span>' : '<span class="status-pill no">권한 승인 필요</span>') + '</span>' +
      '<span><b>오피넷 키</b> ' + (st.hasKey ? '설정됨' : '<span class="err-text">없음 (API 키 탭)</span>') + '</span></div></div>' +
      (st.triggerOn ? '' : '<p class="notice">매일 자동 기록을 켜려면: 구글 시트 메뉴 <b>조일ver1 → 유가 자동 기록 켜기</b>를 한 번 누르세요. (또는 Apps Script 편집기에서 <code>installDieselTrigger</code> 실행) 권한 승인 창이 뜨면 허용하면 돼요.</p>') +
      '</div>' +
      '<div class="card" style="margin-bottom:16px"><div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:6px"><h3>추이</h3><div class="segmented" id="dzRange">' +
      [[30, '1개월'], [90, '3개월'], [365, '1년'], [1095, '3년'], [0, '전체']].map(function (x) { return '<button type="button" data-r="' + x[0] + '" class="' + (dz.range === x[0] ? 'on' : '') + '">' + x[1] + '</button>'; }).join('') + '</div></div>' +
      (data.length > 1 ? priceChart(data) : '<p class="muted">기록이 2일 이상 쌓이면 그래프가 보여요. 과거 유가 엑셀을 가져오면 바로 볼 수 있어요.</p>') + '</div>' +
      '<div class="card"><h3 style="margin-bottom:10px">최근 기록</h3>' +
      (rows.length ? '<div class="table-wrap"><table class="data"><thead><tr><th class="left">날짜</th><th>경유 (원/L)</th><th>전일 대비</th><th class="left">출처</th></tr></thead><tbody>' +
        rows.slice(-30).reverse().map(function (r, i, arr) {
          var pv = arr[i + 1] ? arr[i + 1][1] : null, df = pv != null ? r[1] - pv : null;
          return '<tr><td class="left">' + esc(r[0]) + '</td><td class="num">' + Number(r[1]).toFixed(2) + '</td><td class="num ' + (df > 0 ? 'neg' : '') + '">' + (df == null ? '–' : (df > 0 ? '+' : '') + df.toFixed(2)) + '</td><td class="left small muted">' + esc(r[2]) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">아직 기록이 없어요.</p>') +
      '<p class="hint" style="margin:10px 0 0">견적 계산의 밀크런 유류비는 경유가 "자동"일 때 이 기록의 가장 최근 값을 써요. (계산할 때마다 오피넷을 부르지 않음) · 오피넷 API는 최근 7일치만 주므로, 그보다 오래된 값은 오피넷 사이트 <b>유가통계</b>에서 엑셀로 내려받아 "과거 유가 엑셀 가져오기"로 넣어 주세요.</p></div>';

    $$('#dzRange button').forEach(function (b) { b.onclick = function () { dz.range = Number(b.dataset.r); adminDiesel(); }; });
    if (data.length > 1) bindChartHover(body.querySelectorAll('.card')[1], data, function (d) { return '<b>' + d.d + '</b><br>경유 ' + d.p.toFixed(2) + '원/L'; });
    $('#dzNow').onclick = function () {
      var btn = this; busy(btn, true, '받는 중…');
      api('admin.dieselRecordNow').then(function (r) { dz.rows = r.rows; dz.status = r.status; toast('최근 7일치 경유가를 기록했어요.'); adminDiesel(); })
        .catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    $('#dzFile').onchange = function () {
      var file = this.files[0]; this.value = '';
      if (!file) return;
      Promise.all([loadXlsx(), file.arrayBuffer()]).then(function (res) {
        var X = res[0], wb = X.read(new Uint8Array(res[1]), { type: 'array', cellDates: true });
        var grid = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
        var hi = -1, dc = -1, pc = -1;
        for (var i = 0; i < Math.min(grid.length, 30) && hi === -1; i++) {
          var h = grid[i].map(function (c) { return String(c).replace(/\s/g, ''); });
          var p = h.findIndex(function (c) { return /경유/.test(c) && !/등유|실내/.test(c); });
          if (p !== -1) { hi = i; pc = p; dc = h.findIndex(function (c) { return /날짜|일자|구분|기간|일시/.test(c); }); if (dc === -1) dc = 0; }
        }
        if (hi === -1) throw new Error('"경유" 열이 있는 제목 줄을 찾지 못했어요.');
        var out = [];
        grid.slice(hi + 1).forEach(function (r) {
          var d = anDate(r[dc], X), v = anNum(r[pc]);
          if (d && v > 0) out.push([d, v]);
        });
        if (!out.length) throw new Error('날짜와 경유가를 읽지 못했어요.');
        if (!confirm(out.length + '일치 (' + out[0][0] + ' ~ ' + out[out.length - 1][0] + ') 경유가를 가져올까요? 같은 날짜는 덮어써요.')) return null;
        return api('admin.dieselImport', { rows: out });
      }).then(function (r) {
        if (!r) return;
        toast(r.count + '일치를 가져왔어요.'); dz.rows = null; adminDiesel();
      }).catch(function (err) { toast(err.message, 'err'); });
    };
  }

  /** 날짜 축 선 그래프: 7일 넘게 비어 있는 구간은 선을 끊음 */
  function priceChart(data) {
    var W = 760, H = 260, L = 50, R = 16, T = 14, B = 26;
    var day = function (d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000; };
    var t0 = day(data[0].d), t1 = day(data[data.length - 1].d);
    var vals = data.map(function (d) { return d.p; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = Math.max(10, (hi - lo) * 0.1); lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
    var x = function (d) { return t1 === t0 ? (L + W - R) / 2 : L + (W - L - R) * (day(d) - t0) / (t1 - t0); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var ticks = [0, .25, .5, .75, 1].map(function (k) { return Math.round(lo + (hi - lo) * k); });
    var grid = ticks.map(function (t) { return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="gridl"/><text x="' + (L - 6) + '" y="' + (y(t) + 4) + '" class="axis" text-anchor="end">' + won(t) + '</text>'; }).join('');
    var segs = [], cur = [];
    data.forEach(function (d, i) {
      if (i && day(d.d) - day(data[i - 1].d) > 7) { segs.push(cur); cur = []; }
      cur.push(d);
    });
    segs.push(cur);
    var lines = segs.map(function (sg) {
      var path = sg.map(function (d, i) { return (i ? 'L' : 'M') + x(d.d).toFixed(1) + ',' + y(d.p).toFixed(1); }).join('');
      var area = sg.length > 1 ? '<path d="' + path + 'L' + x(sg[sg.length - 1].d).toFixed(1) + ',' + y(lo) + 'L' + x(sg[0].d).toFixed(1) + ',' + y(lo) + 'Z" fill="' + AN_SALES_COLOR + '" opacity=".1"/>' : '';
      return area + '<path d="' + path + '" fill="none" stroke="' + AN_SALES_COLOR + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        (sg.length === 1 ? '<circle cx="' + x(sg[0].d) + '" cy="' + y(sg[0].p) + '" r="2.5" fill="' + AN_SALES_COLOR + '"/>' : '');
    }).join('');
    // 날짜 눈금: 기간 길이에 맞춰 6~8개
    var labels = '', span = t1 - t0, nTicks = 7;
    for (var k = 0; k <= nTicks; k++) {
      var td = new Date((t0 + span * k / nTicks) * 86400000), ds = td.toISOString().slice(0, 10);
      labels += '<text x="' + x(ds) + '" y="' + (H - 8) + '" class="axis" text-anchor="' + (k === 0 ? 'start' : k === nTicks ? 'end' : 'middle') + '">' + (span > 400 ? ds.slice(2, 7).replace('-', '.') : ds.slice(2).replace(/-/g, '.')) + '</text>';
    }
    var last = data[data.length - 1];
    var hits = data.map(function (d, i) {
      var x0 = i ? (x(data[i - 1].d) + x(d.d)) / 2 : L, x1 = i < data.length - 1 ? (x(d.d) + x(data[i + 1].d)) / 2 : W - R;
      return '<rect class="hit" data-i="' + i + '" x="' + x0 + '" y="' + T + '" width="' + Math.max(1, x1 - x0) + '" height="' + (H - T - B) + '" fill="transparent"/>';
    }).join('');
    return '<div class="chartbox"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="전국 평균 경유가 추이">' + grid + lines +
      '<circle cx="' + x(last.d) + '" cy="' + y(last.p) + '" r="4.5" fill="' + AN_SALES_COLOR + '" stroke="var(--panel)" stroke-width="2"/>' +
      '<text x="' + (x(last.d) - 8) + '" y="' + (y(last.p) - 10) + '" class="vlabel" text-anchor="end">' + last.p.toFixed(2) + '</text>' +
      labels + hits + '</svg><div class="tip hidden"></div></div>';
  }

  /* ───────── 분석: 단가 이상치 (A1 매입이 비싼 오더 · A4 매출이 싼 오더) ───────── */
  /*
   * 같은 발지+착지+중량 오더들의 보통 단가(중앙값)와 비교합니다. 기준 데이터는 기간과 무관하게 전체 데이터
   * (숨긴 매출처·제외/분류 규칙은 반영), 표시는 지금 걸려 있는 필터 안의 오더만.
   */
  var anomalyCache = null;
  function median(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; }), m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function anomalyBase() {
    var an = state.an, key = an.rows.length + '|' + JSON.stringify(an.rules || []) + '|' + JSON.stringify(an.mapping);
    if (anomalyCache && anomalyCache.key === key) return anomalyCache;
    var g = {};
    an.rows.forEach(function (r) {
      if (r[C.hidden] || r[C.cat]) return;
      var k = r[C.from] + '\u0001' + r[C.to] + '\u0001' + r[C.weight];
      var x = g[k] || (g[k] = { buys: [], sales: [] });
      if (r[C.buys] > 0) x.buys.push(r[C.buys]);
      if (r[C.sales] > 0) x.sales.push(r[C.sales]);
    });
    var base = {};
    Object.keys(g).forEach(function (k) {
      base[k] = { nb: g[k].buys.length, ns: g[k].sales.length, mb: g[k].buys.length ? median(g[k].buys) : 0, ms: g[k].sales.length ? median(g[k].sales) : 0 };
    });
    anomalyCache = { key: key, base: base };
    return anomalyCache;
  }
  function findAnomalies(kind, rows) {
    var an = state.an, set = an.anom, base = anomalyBase().base, th = set.th / 100, out = [];
    rows.forEach(function (r) {
      if (r[C.cat]) return;
      var b = base[r[C.from] + '\u0001' + r[C.to] + '\u0001' + r[C.weight]];
      if (!b) return;
      if (kind === 'buy') {
        if (!(r[C.buys] > 0) || b.nb - 1 < set.minN) return;
        if (r[C.buys] > b.mb * (1 + th)) out.push({ r: r, base: b.mb, n: b.nb, diff: r[C.buys] - b.mb, ratio: (r[C.buys] / b.mb - 1) * 100 });
      } else {
        if (!(r[C.sales] > 0) || b.ns - 1 < set.minN) return;
        if (r[C.sales] < b.ms * (1 - th)) out.push({ r: r, base: b.ms, n: b.ns, diff: b.ms - r[C.sales], ratio: (r[C.sales] / b.ms - 1) * 100 });
      }
    });
    return out.sort(function (a, b) { return b.diff - a.diff; });
  }

  function drawAnomalies(rows) {
    var an = state.an, set = an.anom, box = $('#anAnom');
    if (!box) return;
    if (an.showExcluded) { box.innerHTML = ''; return; }
    var kind = set.kind;
    var list = findAnomalies(kind, rows);
    var total = list.reduce(function (s, x) { return s + x.diff; }, 0);
    var shown = list.slice(0, set.limit);
    var isBuy = kind === 'buy';
    box.innerHTML = '<div class="card anom-card">' +
      '<div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:10px"><div><div class="eyebrow">Outliers · 단가 이상치</div>' +
      '<h3>' + (isBuy ? '매입이 평소보다 비싼 오더' : '매출이 평소보다 싼 오더') + ' <span class="' + (list.length ? 'neg' : 'muted') + '">' + won(list.length) + '건</span>' +
      (list.length ? ' <span class="small muted">· ' + (isBuy ? '평소보다 더 나간 매입' : '평소보다 덜 받은 매출') + ' 합계 ' + won(Math.round(total)) + '원</span>' : '') + '</h3></div>' +
      '<div class="actions" style="align-items:center"><div class="segmented" id="anomKind"><button type="button" data-k="buy" class="' + (isBuy ? 'on' : '') + '">매입 비싼 오더</button><button type="button" data-k="sell" class="' + (!isBuy ? 'on' : '') + '">매출 싼 오더</button></div>' +
      '<span class="small">기준 ±<input class="input input-sm num" id="anomTh" type="number" min="5" max="200" step="5" value="' + set.th + '" style="width:62px">%</span>' +
      '<span class="small">비교 오더 <select class="input input-sm" id="anomMin" style="width:auto">' + [2, 3, 5, 10].map(function (n) { return '<option value="' + n + '"' + (set.minN === n ? ' selected' : '') + '>' + n + '건↑</option>'; }).join('') + '</select></span>' +
      '<button class="btn btn-sm" id="anomX"' + (list.length ? '' : ' disabled') + '>엑셀</button></div></div>' +
      (list.length ? '<div class="bulk-table" style="max-height:520px"><table class="data bulk"><thead><tr><th class="left">날짜</th><th class="left">매출처</th><th class="left">경로 · 중량</th>' +
        '<th>' + (isBuy ? '매입' : '매출') + '</th><th>보통 단가</th><th>차이</th><th>벗어난 정도</th><th>' + (isBuy ? '매출' : '매입') + '</th><th class="left">기사 · 차량</th><th class="left">비고</th></tr></thead><tbody>' +
        shown.map(function (x) {
          var r = x.r;
          return '<tr><td class="left small">' + esc(r[C.date]) + '</td><td class="left wrap">' + esc(r[C.disp]) + '</td>' +
            '<td class="left wrap"><span class="route"><span>' + esc(r[C.from]) + '</span><i>→</i><span>' + esc(r[C.to]) + '</span><em>' + esc(r[C.weight] || '-') + '</em></span><div class="addr-in">비교 ' + (x.n - 1) + '건</div></td>' +
            '<td class="num strong">' + won(isBuy ? r[C.buys] : r[C.sales]) + '</td><td class="num muted">' + won(Math.round(x.base)) + '</td>' +
            '<td class="num neg">' + (isBuy ? '+' : '−') + won(Math.round(x.diff)) + '</td><td class="num"><span class="dl bad">' + (x.ratio > 0 ? '+' : '') + x.ratio.toFixed(0) + '%</span></td>' +
            '<td class="num">' + won(isBuy ? r[C.sales] : r[C.buys]) + '</td><td class="left small">' + esc(r[C.driver]) + ' ' + esc(r[C.car]) + '</td><td class="left small wrap">' + esc([r[C.etc], r[C.note]].filter(Boolean).join(' · ')) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (list.length > shown.length ? '<div style="text-align:center;margin-top:10px"><button class="btn btn-sm" id="anomMore">더 보기 (' + won(list.length - shown.length) + '건 남음)</button></div>' : '')
        : '<p class="muted" style="margin:0">지금 조건에서는 기준을 벗어난 오더가 없어요.</p>') +
      '<p class="hint" style="margin:8px 0 0">보통 단가 = 같은 발지·착지·중량 오더들의 중앙값 (전체 기간 기준). 대기·경유·수작업 같은 추가 요금이 붙은 오더도 걸릴 수 있으니 비고를 함께 보세요.</p></div>';
    // 입력칸 포커스가 빠지면서 다시 그리기가 겹치지 않도록 한 박자 늦게
    var later = function () { clearTimeout(an.anomTimer); an.anomTimer = setTimeout(function () { drawAnomalies(rows); }, 0); };
    $$('#anomKind button').forEach(function (b) { b.onclick = function () { set.kind = b.dataset.k; set.limit = 30; later(); }; });
    $('#anomTh').onchange = function () { set.th = Math.min(200, Math.max(5, Number(this.value) || 20)); later(); };
    $('#anomMin').onchange = function () { set.minN = Number(this.value); later(); };
    var more = $('#anomMore'); if (more) more.onclick = function () { set.limit += 100; drawAnomalies(rows); };
    var ax = $('#anomX'); if (ax) ax.onclick = function () {
      var btn = this; busy(btn, true, '…');
      downloadXlsx('조일ver1_단가이상치_' + (isBuy ? '매입' : '매출') + '_' + an.f.from + '_' + an.f.to + '.xlsx', [{
        name: isBuy ? '매입 비싼 오더' : '매출 싼 오더', widths: [11, 10, 26, 18, 18, 8, 12, 12, 12, 9, 12, 10, 12, 20, 20],
        rows: [['날짜', '사업자', '매출처', '발지', '착지', '중량', isBuy ? '매입' : '매출', '보통 단가', '차이', '벗어난 정도(%)', isBuy ? '매출' : '매입', '기사명', '차량번호', '기타1', '비고']].concat(list.map(function (x) {
          var r = x.r;
          return [r[C.date], r[C.biz], r[C.disp], r[C.from], r[C.to], r[C.weight], isBuy ? r[C.buys] : r[C.sales], Math.round(x.base), Math.round(x.diff), Math.round(x.ratio), isBuy ? r[C.sales] : r[C.buys], r[C.driver], r[C.car], r[C.etc], r[C.note]];
        }))
      }]).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  /* ───────── 분석: 매출처 상세 카드 (A2) ───────── */

  function openCustCard(name) {
    var an = state.an, f = an.f;
    // 이 매출처만 (다른 선택 조건은 무시, 사업자·검색·분류 설정은 반영)
    var saveSel = f.sel;
    f.sel = { cust: [name] };
    var allRows = anFilter(null, { from: '', to: '' });
    var rows = anFilter(null);
    var cr = cmpRange(), cmpRows = rangeHasData(cr) ? anFilter(null, { from: cr.from, to: cr.to }) : null;
    f.sel = saveSel;
    var t = agg(rows), c = cmpRows ? agg(cmpRows) : null;
    var byM = {};
    allRows.forEach(function (r) { var m = r[C.date].slice(0, 7); var x = byM[m] || (byM[m] = { s: 0, b: 0, n: 0 }); x.s += r[C.sales]; x.b += r[C.buys]; x.n++; });
    var have = Object.keys(byM).sort(), months = [];
    if (have.length) for (var mm = have[have.length - 1], k = 0; k < 24 && mm >= have[0]; k++, mm = addMonths(mm, -1)) months.unshift(mm);
    var mk = function (m) { var x = byM[m] || { s: 0, b: 0, n: 0 }; return { m: m, s: x.s, b: x.b, n: x.n, p: x.s - x.b, rate: pct(x.s - x.b, x.s), has: !!byM[m] }; };
    var data = months.map(function (m) { var d = mk(m); d.ly = mk(addMonths(m, -12)); return d; });
    // 경로 조합 (선택 기간)
    var g = {};
    rows.forEach(function (r) {
      var key = r[C.from] + '\u0001' + r[C.to] + '\u0001' + r[C.weight];
      var x = g[key] || (g[key] = { from: r[C.from], to: r[C.to], w: r[C.weight], n: 0, s: 0, b: 0 });
      x.n++; x.s += r[C.sales]; x.b += r[C.buys];
    });
    var routes = Object.keys(g).map(function (k) { var x = g[k]; x.p = x.s - x.b; x.r = pct(x.p, x.s); return x; });
    var top = routes.slice().sort(function (a, b) { return b.n - a.n || b.p - a.p; }).slice(0, 10);
    var loss = routes.filter(function (x) { return x.p < 0; }).sort(function (a, b) { return a.p - b.p; }).slice(0, 10);
    var routeTable = function (list, empty) {
      if (!list.length) return '<p class="muted small" style="margin:0">' + empty + '</p>';
      return '<table class="data grp mini"><thead><tr><th class="left">경로 · 중량</th><th>건수</th><th>이익</th><th>이익률</th></tr></thead><tbody>' +
        list.map(function (x) {
          return '<tr><td class="left wrap"><span class="route"><span>' + esc(x.from) + '</span><i>→</i><span>' + esc(x.to) + '</span><em>' + esc(x.w || '-') + '</em></span></td><td class="num">' + won(x.n) + '</td>' +
            '<td class="num' + (x.p < 0 ? ' neg' : '') + '">' + won(x.p) + '</td><td class="num' + (x.r != null && x.r < 0 ? ' neg' : '') + '">' + pctText(x.r) + '</td></tr>';
        }).join('') + '</tbody></table>';
    };
    var period = f.from === f.to ? f.from : f.from + ' ~ ' + f.to;
    modal({
      wide: true, eyebrow: '매출처 상세 · ' + period, title: name,
      body:
        '<div class="kpis mini">' + [
          ['이익', won(t.p) + '원', t.p < 0, c && deltaHtml(deltaPct(t.p, c.p), '%', true)],
          ['이익률', pctText(t.r), t.r != null && t.r < 0, c && (t.r != null && c.r != null ? deltaHtml(t.r - c.r, '%p', true) : '')],
          ['매출', won(t.s) + '원', false, c && deltaHtml(deltaPct(t.s, c.s), '%', true)],
          ['건수', won(t.n) + '건', false, c && deltaHtml(deltaPct(t.n, c.n), '%', true)]
        ].map(function (k) { return '<div class="kpi"><div class="k">' + k[0] + '</div><div class="v num' + (k[2] ? ' neg' : '') + '">' + k[1] + '</div><div class="s">' + (k[3] ? k[3] + ' <span class="muted">' + esc(cr.label) + ' 대비</span>' : '') + '</div></div>'; }).join('') + '</div>' +
        '<div class="cc-charts"><div id="ccTrend"><div class="row-between"><h3>월별 이익</h3><div class="legend"><span><i style="background:' + AN_SALES_COLOR + '"></i>이익</span><span><i style="background:' + AN_BUYS_COLOR + '"></i>손실</span><span><i class="ly"></i>전년 같은 달</span></div></div>' + profitChart(data) + '</div>' +
        '<div id="ccRate"><h3>월별 이익률</h3>' + lineChart(data) + '</div></div>' +
        '<div class="cc-routes"><div><h3>주력 경로 <span class="muted small">건수 많은 순 · ' + esc(period) + '</span></h3>' + routeTable(top, '이 기간에 오더가 없어요.') + '</div>' +
        '<div><h3>손실 경로 <span class="muted small">손실 큰 순</span></h3>' + routeTable(loss, '손실 난 경로가 없어요. 👍') + '</div></div>',
      foot: '<button class="btn" data-close>닫기</button><button class="btn btn-primary" id="ccFilter">이 매출처로 걸러 보기</button>',
      onMount: function (m, close) {
        bindChartHover($('#ccTrend', m), data, function (d) { return '<b>' + d.m + '</b><br>이익 ' + won(d.p) + ' · ' + pctText(d.rate) + '<br>매출 ' + won(d.s) + '<br>' + won(d.n) + '건' + (d.ly.has ? '<br><span style="opacity:.75">전년: 이익 ' + won(d.ly.p) + '</span>' : ''); });
        bindChartHover($('#ccRate', m), data, function (d) { return '<b>' + d.m + '</b><br>이익률 ' + pctText(d.rate); });
        $('#ccFilter', m).onclick = function () { f.sel = { cust: [name] }; an.dim = 'route'; an.sort = { key: 'profit', dir: 1 }; close(); renderAnalysis(); };
      }
    });
  }

  /* ───────── 분석: 월간 보고서 (A3) ───────── */

  function openReport() {
    var an = state.an, f = an.f;
    var period = f.from === f.to ? f.from : f.from + ' ~ ' + f.to;
    var rows = anFilter(null), t = agg(rows);
    var cr = cmpRange(), hasCmp = rangeHasData(cr), c = hasCmp ? agg(anFilter(null, { from: cr.from, to: cr.to })) : null;
    var yr = { from: addMonths(f.from, -12), to: addMonths(f.to, -12) }, hasYoy = an.cmp !== 'yoy' && rangeHasData(yr);
    var y = hasYoy ? agg(anFilter(null, { from: yr.from, to: yr.to })) : null;
    var byKey = function (getter, list) {
      var g = {};
      list.forEach(function (r) { var k = getter(r), x = g[k] || (g[k] = { k: k, n: 0, s: 0, b: 0 }); x.n++; x.s += r[C.sales]; x.b += r[C.buys]; });
      return Object.keys(g).map(function (k) { var x = g[k]; x.p = x.s - x.b; x.r = pct(x.p, x.s); return x; });
    };
    var bizRows = byKey(function (r) { return r[C.biz]; }, rows).sort(function (a, b) { return b.s - a.s; });
    var custs = byKey(function (r) { return r[C.disp]; }, rows);
    var topP = custs.slice().sort(function (a, b) { return b.p - a.p; }).slice(0, 10);
    var lowP = custs.filter(function (x) { return x.p < 0 || (x.r != null && x.r < 3); }).sort(function (a, b) { return a.p - b.p; }).slice(0, 10);
    // 확인해 볼 곳
    var watch = [];
    if (hasCmp) {
      var prevC = {}; byKey(function (r) { return r[C.disp]; }, anFilter(null, { from: cr.from, to: cr.to })).forEach(function (x) { prevC[x.k] = x; });
      watch = custs.map(function (x) { var p = prevC[x.k]; if (!p) return null; x.cr = p.r; x.dr = x.r != null && p.r != null ? x.r - p.r : null; x.turned = p.p > 0 && x.p < 0; return x; })
        .filter(function (x) { return x && x.s >= an.alert.minSales && (x.turned || (x.dr != null && x.dr <= -an.alert.drop)); })
        .sort(function (a, b) { return a.dr - b.dr; }).slice(0, 10);
    }
    var buyAnom = findAnomalies('buy', rows), sellAnom = findAnomalies('sell', rows);
    var sumDiff = function (l) { return Math.round(l.reduce(function (s, x) { return s + x.diff; }, 0)); };
    // 월별 (최근 12개월)
    var all = anFilter(null, { from: '', to: '' }), byM = {};
    all.forEach(function (r) { var m = r[C.date].slice(0, 7); var x = byM[m] || (byM[m] = { s: 0, b: 0, n: 0 }); x.s += r[C.sales]; x.b += r[C.buys]; x.n++; });
    var months = [];
    for (var mm = f.to, k = 0; k < 12; k++, mm = addMonths(mm, -1)) months.unshift(mm);
    var mk = function (m) { var x = byM[m] || { s: 0, b: 0, n: 0 }; return { m: m, s: x.s, b: x.b, n: x.n, p: x.s - x.b, rate: pct(x.s - x.b, x.s), has: !!byM[m] }; };
    var data = months.map(function (m) { var d = mk(m); d.ly = mk(addMonths(m, -12)); return d; });
    var scope = [];
    if (f.biz.length) scope.push('사업자: ' + f.biz.join(', '));
    Object.keys(f.sel).forEach(function (kk) { if ((f.sel[kk] || []).length) scope.push(dimDef(kk)[1] + ': ' + f.sel[kk].join(', ')); });
    if (f.q) scope.push('검색: ' + f.q);
    var cmpCell = function (cur, prev, unit, goodUp, isRate) {
      if (prev == null) return '<td class="num muted">–</td>';
      return '<td class="num">' + (isRate ? pctText(prev) : won(prev)) + ' ' + deltaHtml(isRate ? (cur != null ? cur - prev : null) : deltaPct(cur, prev), unit, goodUp) + '</td>';
    };
    var tbl = function (list, cols) {
      return '<table class="data rpt"><thead><tr>' + cols.map(function (c2) { return '<th class="' + (c2[2] ? 'left' : '') + '">' + c2[0] + '</th>'; }).join('') + '</tr></thead><tbody>' +
        list.map(function (x) { return '<tr>' + cols.map(function (c2) { return c2[1](x); }).join('') + '</tr>'; }).join('') + '</tbody></table>';
    };
    var numCell = function (v, neg) { return '<td class="num' + (neg ? ' neg' : '') + '">' + v + '</td>'; };
    var html =
      '<div class="rpt-bar no-print"><span class="muted small">보고서 미리보기 · 인쇄 창에서 "PDF로 저장"을 고르면 PDF가 돼요</span><span class="spacer"></span>' +
      '<button class="btn btn-sm" id="rptX">엑셀</button><button class="btn btn-sm btn-primary" id="rptPrint">인쇄 / PDF 저장</button><button class="btn btn-sm" id="rptClose">닫기</button></div>' +
      '<div class="rpt-page">' +
      '<header class="rpt-head"><div class="stripe-bar"></div><div class="rpt-title"><div><div class="eyebrow">Monthly Report · 매출매입 보고</div><h1>' + esc(period) + ' 매출 · 매입 · 이익 보고</h1>' +
      '<p class="muted small">' + esc(scope.length ? scope.join(' · ') : '전체 사업자 · 전체 매출처') + ' · 작성 ' + esc(today()) + ' · ' + esc(state.user.name) + '</p></div><span class="logo"></span></div></header>' +
      '<section><h2>1. 요약</h2><table class="data rpt"><thead><tr><th class="left">항목</th><th>' + esc(period) + '</th><th>' + (hasCmp ? esc(cr.label) + ' 대비' : '비교') + '</th>' + (hasYoy ? '<th>전년 같은 기간 대비</th>' : '') + '</tr></thead><tbody>' +
      [['이익', t.p, c && c.p, y && y.p, '%', true], ['이익률', t.r, c && c.r, y && y.r, '%p', true, true], ['매출', t.s, c && c.s, y && y.s, '%', true], ['매입', t.b, c && c.b, y && y.b, '%', false], ['건수', t.n, c && c.n, y && y.n, '%', true]].map(function (r) {
        return '<tr><td class="left strong">' + r[0] + '</td>' + numCell(r[6] ? pctText(r[1]) : won(r[1]) + (r[0] === '건수' ? '건' : '원'), r[1] < 0) + cmpCell(r[1], c ? r[2] : null, r[4], r[5], r[6]) + (hasYoy ? cmpCell(r[1], r[3], r[4], r[5], r[6]) : '') + '</tr>';
      }).join('') + '</tbody></table></section>' +
      '<section><h2>2. 사업자별</h2>' + tbl(bizRows, [['사업자', function (x) { return '<td class="left strong">' + esc(x.k) + '</td>'; }, 1], ['건수', function (x) { return numCell(won(x.n)); }], ['매출', function (x) { return numCell(won(x.s)); }], ['매입', function (x) { return numCell(won(x.b)); }], ['이익', function (x) { return numCell(won(x.p), x.p < 0); }], ['이익률', function (x) { return numCell(pctText(x.r), x.r < 0); }]]) + '</section>' +
      '<section class="rpt-charts"><div><h2>3. 월별 이익 (최근 12개월)</h2><div class="legend"><span><i style="background:' + AN_SALES_COLOR + '"></i>이익</span><span><i style="background:' + AN_BUYS_COLOR + '"></i>손실</span><span><i class="ly"></i>전년 같은 달</span></div>' + profitChart(data) + '</div>' +
      '<div><h2>월별 이익률</h2>' + lineChart(data) + '</div></section>' +
      (hasCmp ? '<section><h2>4. 확인해 볼 곳 <span class="small muted">' + esc(cr.label) + '보다 이익률 ' + an.alert.drop + '%p 이상 하락 또는 적자 전환</span></h2>' +
        (watch.length ? tbl(watch, [['매출처', function (x) { return '<td class="left">' + (x.turned ? '<b class="neg">[적자 전환]</b> ' : '') + esc(x.k) + '</td>'; }, 1], ['이익률', function (x) { return numCell(pctText(x.r), x.r < 0); }], [esc(cr.label), function (x) { return numCell(pctText(x.cr)); }], ['변화', function (x) { return '<td class="num">' + deltaHtml(x.dr, '%p', true) + '</td>'; }], ['이익', function (x) { return numCell(won(x.p), x.p < 0); }], ['매출', function (x) { return numCell(won(x.s)); }]]) : '<p class="muted">해당하는 매출처가 없습니다.</p>') + '</section>' : '') +
      '<section class="rpt-two"><div><h2>' + (hasCmp ? '5' : '4') + '. 이익 상위 10</h2>' + tbl(topP, [['매출처', function (x) { return '<td class="left">' + esc(x.k) + '</td>'; }, 1], ['이익', function (x) { return numCell(won(x.p), x.p < 0); }], ['이익률', function (x) { return numCell(pctText(x.r)); }], ['건수', function (x) { return numCell(won(x.n)); }]]) + '</div>' +
      '<div><h2>' + (hasCmp ? '6' : '5') + '. 손실 · 저마진 10 <span class="small muted">이익률 3% 미만</span></h2>' + (lowP.length ? tbl(lowP, [['매출처', function (x) { return '<td class="left">' + esc(x.k) + '</td>'; }, 1], ['이익', function (x) { return numCell(won(x.p), x.p < 0); }], ['이익률', function (x) { return numCell(pctText(x.r), x.r < 0); }], ['건수', function (x) { return numCell(won(x.n)); }]]) : '<p class="muted">없습니다.</p>') + '</div></section>' +
      '<section><h2>' + (hasCmp ? '7' : '6') + '. 단가 이상치 <span class="small muted">같은 경로·중량 보통 단가 대비 ±' + an.anom.th + '%</span></h2>' +
      '<table class="data rpt"><tbody><tr><td class="left">매입이 평소보다 비싼 오더</td><td class="num">' + won(buyAnom.length) + '건</td><td class="num neg">+' + won(sumDiff(buyAnom)) + '원</td></tr>' +
      '<tr><td class="left">매출이 평소보다 싼 오더</td><td class="num">' + won(sellAnom.length) + '건</td><td class="num neg">−' + won(sumDiff(sellAnom)) + '원</td></tr></tbody></table>' +
      (buyAnom.length ? '<p class="small muted" style="margin:8px 0 4px">매입 초과 상위 5건</p>' + tbl(buyAnom.slice(0, 5), [['날짜', function (x) { return '<td class="left small">' + esc(x.r[C.date]) + '</td>'; }, 1], ['매출처', function (x) { return '<td class="left">' + esc(x.r[C.disp]) + '</td>'; }, 1], ['경로', function (x) { return '<td class="left">' + esc(x.r[C.from] + ' → ' + x.r[C.to] + ' · ' + x.r[C.weight]) + '</td>'; }, 1], ['매입', function (x) { return numCell(won(x.r[C.buys])); }], ['보통', function (x) { return numCell(won(Math.round(x.base))); }], ['기사', function (x) { return '<td class="left small">' + esc(x.r[C.driver]) + '</td>'; }, 1]]) : '') +
      '</section>' +
      '<footer class="rpt-foot muted small">조일ver1 · 이익 = 매출후불 − 매입후불 · 관리자가 정한 제외 규칙과 숨긴 매출처는 빠진 숫자입니다.</footer></div>';
    var wrap = document.createElement('div');
    wrap.id = 'report';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    document.body.classList.add('report-open');
    window.scrollTo(0, 0);
    function close() { wrap.remove(); document.body.classList.remove('report-open'); }
    $('#rptClose').onclick = close;
    $('#rptPrint').onclick = function () { window.print(); };
    $('#rptX').onclick = function () {
      var btn = this; busy(btn, true, '…');
      var custRows = custs.slice().sort(function (a, b) { return b.p - a.p; });
      var sheets = [
        { name: '요약', widths: [12, 18, 18, 18], rows: [['항목', period, hasCmp ? cr.label : '', hasYoy ? '전년 같은 기간' : '']].concat([['이익', t.p, c && c.p, y && y.p], ['이익률(%)', t.r == null ? '' : +t.r.toFixed(1), c && c.r != null ? +c.r.toFixed(1) : '', y && y.r != null ? +y.r.toFixed(1) : ''], ['매출', t.s, c && c.s, y && y.s], ['매입', t.b, c && c.b, y && y.b], ['건수', t.n, c && c.n, y && y.n]].map(function (r) { return r.map(function (v) { return v == null || v === false ? '' : v; }); })).concat([[], ['범위', scope.join(' · ') || '전체'], ['작성', today() + ' ' + state.user.name]]) },
        { name: '사업자별', widths: [14, 8, 15, 15, 15, 9], rows: [['사업자', '건수', '매출', '매입', '이익', '이익률(%)']].concat(bizRows.map(function (x) { return [x.k, x.n, x.s, x.b, x.p, x.r == null ? '' : +x.r.toFixed(1)]; })) },
        { name: '월별', widths: [10, 15, 15, 15, 9, 8], rows: [['월', '매출', '매입', '이익', '이익률(%)', '건수']].concat(data.map(function (d) { return [d.m, d.s, d.b, d.p, d.rate == null ? '' : +d.rate.toFixed(1), d.n]; })) },
        { name: '매출처별', widths: [32, 8, 15, 15, 15, 9], rows: [['매출처', '건수', '매출', '매입', '이익', '이익률(%)']].concat(custRows.map(function (x) { return [x.k, x.n, x.s, x.b, x.p, x.r == null ? '' : +x.r.toFixed(1)]; })) }
      ];
      if (hasCmp) sheets.push({ name: '확인해 볼 곳', widths: [32, 9, 12, 10, 15, 15], rows: [['매출처', '이익률(%)', cr.label + '(%)', '변화(%p)', '이익', '매출']].concat(watch.map(function (x) { return [(x.turned ? '[적자 전환] ' : '') + x.k, x.r == null ? '' : +x.r.toFixed(1), x.cr == null ? '' : +x.cr.toFixed(1), x.dr == null ? '' : +x.dr.toFixed(1), x.p, x.s]; })) });
      sheets.push({ name: '단가 이상치', widths: [8, 11, 26, 18, 18, 8, 12, 12, 12, 10], rows: [['구분', '날짜', '매출처', '발지', '착지', '중량', '금액', '보통 단가', '차이', '기사명']].concat(buyAnom.map(function (x) { return ['매입 비쌈', x.r[C.date], x.r[C.disp], x.r[C.from], x.r[C.to], x.r[C.weight], x.r[C.buys], Math.round(x.base), Math.round(x.diff), x.r[C.driver]]; })).concat(sellAnom.map(function (x) { return ['매출 쌈', x.r[C.date], x.r[C.disp], x.r[C.from], x.r[C.to], x.r[C.weight], x.r[C.sales], Math.round(x.base), Math.round(x.diff), x.r[C.driver]]; })) });
      downloadXlsx('조일ver1_매출매입보고_' + period.replace(/ ~ /, '_') + '.xlsx', sheets).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  /* ───────── 매출매입 분석 화면 ───────── */

  var AN_DIMS = [
    ['cust', '매출처', function (r) { return r[C.disp]; }],
    ['biz', '사업자', function (r) { return r[C.biz]; }],
    ['month', '월', function (r) { return r[C.date].slice(0, 7); }],
    ['from', '발지', function (r) { return r[C.from]; }],
    ['to', '착지', function (r) { return r[C.to]; }],
    ['driver', '기사명', function (r) { return r[C.driver]; }],
    ['car', '차량번호', function (r) { return r[C.car]; }],
    ['weight', '중량', function (r) { return r[C.weight]; }],
    ['cat', '구분', function (r) { return r[C.cat] && r[C.cat] !== '__x' ? r[C.cat] : '운송'; }],
    ['route', '경로 조합', function (r) { return r[C.from] + ' → ' + r[C.to] + (state.an.routeWeight ? ' · ' + r[C.weight] : ''); }]
  ];

  /* ── 비교 기간 (직전 같은 길이 / 전년 같은 기간) ── */
  function addMonths(m, k) {
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k;
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    return y + '-' + ('0' + (mo + 1)).slice(-2);
  }
  function monthSpan(from, to) { return (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7)) + 1; }
  function cmpRange() {
    var f = state.an.f, back = state.an.cmp === 'yoy' ? 12 : monthSpan(f.from, f.to);
    return { from: addMonths(f.from, -back), to: addMonths(f.to, -back), label: state.an.cmp === 'yoy' ? '전년 같은 기간' : (back === 1 ? '전월' : '직전 ' + back + '개월') };
  }
  function rangeHasData(r) { return anMonths().some(function (m) { return m >= r.from && m <= r.to; }); }
  function agg(rows) {
    var a = { n: rows.length, s: 0, b: 0 };
    rows.forEach(function (r) { a.s += r[C.sales]; a.b += r[C.buys]; });
    a.p = a.s - a.b; a.r = pct(a.p, a.s);
    return a;
  }
  function deltaPct(cur, prev) { return prev ? (cur - prev) / Math.abs(prev) * 100 : null; }
  function deltaHtml(v, unit, goodUp) {
    if (v == null || !isFinite(v)) return '<span class="dl">비교 없음</span>';
    var up = v > 0.05, down = v < -0.05;
    var cls = up ? (goodUp ? 'good' : 'bad') : down ? (goodUp ? 'bad' : 'good') : '';
    return '<span class="dl ' + cls + '">' + (up ? '▲ ' : down ? '▼ ' : '') + Math.abs(v).toFixed(1) + unit + '</span>';
  }
  function dimDef(key) { return AN_DIMS.filter(function (d) { return d[0] === key; })[0]; }

  function shortWon(n) {
    var a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a >= 1e8) return sign + (a / 1e8).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + '억';
    if (a >= 1e4) return sign + Math.round(a / 1e4).toLocaleString('ko-KR') + '만';
    return sign + Math.round(a).toLocaleString('ko-KR');
  }
  function pct(p, s) { return s ? (p / s * 100) : null; }
  function pctText(v) { return v == null ? '–' : v.toFixed(1) + '%'; }

  /** 필터 적용 (excludeDim: 해당 차원 선택은 빼고 — 순위표가 선택지를 계속 보여주도록) */
  function anFilter(excludeDim, opts) {
    var an = state.an, f = an.f, out = [];
    var catsOnly = !!(opts && opts.catsOnly);
    var fFrom = opts && opts.hasOwnProperty('from') ? opts.from : f.from;
    var fTo = opts && opts.hasOwnProperty('to') ? opts.to : f.to;
    var bizSet = f.biz.length ? f.biz : null;
    var sel = {};
    Object.keys(f.sel).forEach(function (k) { if (k !== excludeDim && f.sel[k] && f.sel[k].length) sel[k] = f.sel[k]; });
    var selKeys = Object.keys(sel), getters = {};
    selKeys.forEach(function (k) { getters[k] = dimDef(k)[2]; });
    var q = f.q.trim();
    for (var i = 0; i < an.rows.length; i++) {
      var r = an.rows[i];
      if (r[C.hidden]) continue;
      var cat = r[C.cat];
      if (an.showExcluded) { if (cat !== '__x') continue; }
      else {
        if (cat === '__x') continue;
        if (catsOnly ? !cat : (cat && !f.withCats)) continue;
      }
      var m = r[C.date].slice(0, 7);
      if (fFrom && m < fFrom) continue;
      if (fTo && m > fTo) continue;
      if (bizSet && bizSet.indexOf(r[C.biz]) === -1) continue;
      var ok = true;
      for (var j = 0; j < selKeys.length; j++) { if (sel[selKeys[j]].indexOf(getters[selKeys[j]](r)) === -1) { ok = false; break; } }
      if (!ok) continue;
      if (q && (r[C.disp] + ' ' + r[C.from] + ' ' + r[C.to] + ' ' + r[C.driver] + ' ' + r[C.car] + ' ' + r[C.weight] + ' ' + r[C.etc] + ' ' + r[C.note]).indexOf(q) === -1) continue;
      out.push(r);
    }
    return out;
  }

  function renderAnalysis() {
    var an = state.an;
    var main = $('#main');
    if (state.user.mustChange) { main.innerHTML = '<div class="card muted">비밀번호를 바꾸면 분석 화면이 열립니다.</div>'; return; }
    if (!an.rows) {
      main.innerHTML = '<div class="card empty"><div><div class="big-stripes"></div><h3>분석 데이터를 불러오는 중…</h3><p class="muted" style="margin:0"><span class="spinner dark"></span> <span id="anProg"></span></p></div></div>';
      loadAnalysis().then(function () { if (state.view === 'analysis') renderAnalysis(); }).catch(function (err) {
        if (state.view !== 'analysis') return;
        main.innerHTML = '<div class="card"><p class="err-text" style="margin:0 0 12px">' + esc(err.message) + '</p><button class="btn btn-primary btn-sm" id="anRetry">다시 불러오기</button></div>';
        $('#anRetry').onclick = function () { renderAnalysis(); };
      });
      return;
    }
    if (!an.rows.length) {
      main.innerHTML = '<div class="card empty"><div><div class="big-stripes"></div><h3>아직 분석 데이터가 없어요</h3><p class="muted" style="margin:0">' +
        (state.user.role === 'admin' ? '관리자 → 분석 데이터에서 매출매입 엑셀을 올려 주세요.' : '관리자가 데이터를 올리면 여기서 볼 수 있어요.') + '</p></div></div>';
      return;
    }
    var months = anMonths();
    var f = an.f;
    main.innerHTML =
      '<div class="card anfilter">' +
      '<div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:12px"><div><div class="eyebrow">Analysis · 매출매입 분석</div><h2>매출 · 매입 · 이익</h2></div>' +
      '<div class="actions"><button class="btn btn-sm btn-primary" id="anReport">월간 보고서</button><button class="btn btn-sm" id="anReset">필터 초기화</button><button class="btn btn-sm" id="anReload">데이터 새로고침</button></div></div>' +
      '<div class="anfilter-row">' +
      '<div class="fgroup"><span class="flabel">기간</span><select class="input input-sm" id="anFrom">' + months.map(function (m) { return '<option' + (m === f.from ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select>' +
      '<span class="muted">~</span><select class="input input-sm" id="anTo">' + months.map(function (m) { return '<option' + (m === f.to ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select>' +
      '<div class="segmented" id="anQuick"><button type="button" data-n="1">최근 1개월</button><button type="button" data-n="3">3개월</button><button type="button" data-n="12">12개월</button><button type="button" data-n="0">전체</button></div></div>' +
      '<div class="fgroup"><span class="flabel">사업자</span><div class="chips" id="anBiz">' + an.businesses.map(function (b) {
        return '<button type="button" class="chip ' + (f.biz.indexOf(b) !== -1 ? 'on' : '') + '" data-b="' + esc(b) + '">' + esc(b) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="fgroup"><span class="flabel">매출처</span><button class="btn btn-sm" id="anCustPick">' + ((f.sel.cust || []).length ? (f.sel.cust || []).length + '곳 선택됨' : '전체 · 고르기') + '</button></div>' +
      (an.hasCats || state.user.role === 'admin' ? '<div class="fgroup"><span class="flabel">보기</span><div class="chips">' +
        (an.hasCats ? '<button type="button" class="chip ' + (f.withCats ? 'on' : '') + '" id="anWithCats">분류 항목 포함</button>' : '') +
        (state.user.role === 'admin' ? '<button type="button" class="chip ' + (an.showExcluded ? 'on' : '') + '" id="anShowX" title="관리자만 보이는 버튼">제외된 행만 보기</button>' : '') +
        '</div></div>' : '') +
      '<div class="fgroup grow"><span class="flabel">검색</span><input class="input input-sm" id="anQ" placeholder="발지·착지·기사·차량·중량·비고에서 찾기 (Enter)" value="' + esc(f.q) + '"></div>' +
      '</div><div id="anChips" class="anchips"></div></div>' +
      (an.showExcluded ? '<p class="notice" style="margin-top:16px">지금은 <b>제외 규칙에 걸린 행만</b> 보고 있어요. (관리자 확인용) 다시 누르면 원래대로 돌아가요.</p>' : '') +
      '<div id="anKpi" class="kpis"></div><div id="anAlerts"></div><div id="anCats"></div>' +
      '<div class="an-charts"><div class="card" id="anTrend"></div><div class="card" id="anRate"></div></div>' +
      '<div class="card" id="anGroup" style="margin-top:16px"></div>' +
      '<div id="anAnom" style="margin-top:16px"></div>' +
      '<div class="card" id="anDetail" style="margin-top:16px"></div>';

    $('#anFrom').onchange = function () { f.from = this.value; if (f.to < f.from) f.to = f.from; refresh(); };
    $('#anTo').onchange = function () { f.to = this.value; if (f.from > f.to) f.from = f.to; refresh(); };
    $$('#anQuick button').forEach(function (b) {
      b.onclick = function () {
        var n = Number(b.dataset.n), last = months[months.length - 1];
        f.to = last; f.from = n ? months[Math.max(0, months.length - n)] : months[0];
        refresh();
      };
    });
    $$('#anBiz .chip').forEach(function (c) {
      c.onclick = function () { var i = f.biz.indexOf(c.dataset.b); if (i === -1) f.biz.push(c.dataset.b); else f.biz.splice(i, 1); refresh(); };
    });
    $('#anCustPick').onclick = openCustPicker;
    $('#anReport').onclick = openReport;
    var wc = $('#anWithCats'); if (wc) wc.onclick = function () { f.withCats = !f.withCats; refresh(); };
    var sx = $('#anShowX'); if (sx) sx.onclick = function () { an.showExcluded = !an.showExcluded; refresh(); };
    $('#anQ').onkeydown = function (e) { if (e.key === 'Enter') { f.q = this.value.trim(); refresh(); } };
    $('#anReset').onclick = function () { f.biz = []; f.sel = {}; f.q = ''; f.to = months[months.length - 1]; f.from = f.to; an.detailPage = 0; refresh(); };
    $('#anReload').onclick = function () { an.rows = null; renderAnalysis(); };

    function refresh() {
      an.detailPage = 0; an.groupLimit = 50;
      renderAnalysis();
    }
    drawAnalysisBody();
  }

  function drawAnalysisBody() {
    var an = state.an, f = an.f;
    $('#anFrom').value = f.from; $('#anTo').value = f.to;
    // 선택 칩
    var chips = [];
    Object.keys(f.sel).forEach(function (k) {
      (f.sel[k] || []).forEach(function (v) { chips.push('<button class="fchip" data-k="' + k + '" data-v="' + esc(v) + '"><b>' + esc(dimDef(k)[1]) + '</b> ' + esc(v || '(빈칸)') + ' ✕</button>'); });
    });
    if (f.q) chips.push('<button class="fchip" data-q="1"><b>검색</b> ' + esc(f.q) + ' ✕</button>');
    $('#anChips').innerHTML = chips.length ? chips.join('') : '<span class="hint">아래 순위표의 행을 누르면 그 항목으로 걸러져요. (예: 업체 → 발지 → 기사 순으로 좁혀 보기)</span>';
    $$('#anChips .fchip').forEach(function (c) {
      c.onclick = function () {
        if (c.dataset.q) f.q = '';
        else { var arr = f.sel[c.dataset.k]; arr.splice(arr.indexOf(c.dataset.v), 1); }
        an.detailPage = 0; renderAnalysis();
      };
    });

    var rows = anFilter(null);
    var t = agg(rows);
    var cr = cmpRange(), hasCmp = rangeHasData(cr);
    var c = hasCmp ? agg(anFilter(null, { from: cr.from, to: cr.to })) : null;
    var period = f.from === f.to ? f.from : f.from + ' ~ ' + f.to;
    var cmpText = cr.label + ' (' + (cr.from === cr.to ? cr.from : cr.from + ' ~ ' + cr.to) + ')';
    $('#anKpi').innerHTML = [
      ['이익', won(t.p) + '원', t.p < 0, c && deltaHtml(deltaPct(t.p, c.p), '%', true), c && won(c.p)],
      ['이익률', pctText(t.r), t.r != null && t.r < 0, c && (t.r != null && c.r != null ? deltaHtml(t.r - c.r, '%p', true) : deltaHtml(null)), c && pctText(c.r)],
      ['매출', won(t.s) + '원', false, c && deltaHtml(deltaPct(t.s, c.s), '%', true), c && won(c.s)],
      ['매입', won(t.b) + '원', false, c && deltaHtml(deltaPct(t.b, c.b), '%', false), c && won(c.b)],
      ['건수', won(t.n) + '건', false, c && deltaHtml(deltaPct(t.n, c.n), '%', true), c && won(c.n)]
    ].map(function (k, i) {
      return '<div class="card kpi' + (i < 2 ? ' main' : '') + '" style="--i:' + i + '"><div class="k">' + k[0] + '</div><div class="v num' + (k[2] ? ' neg' : '') + '">' + k[1] + '</div>' +
        '<div class="s">' + (hasCmp ? k[3] + ' <span class="muted">' + esc(cr.label) + ' ' + k[4] + '</span>' : esc(period)) + '</div></div>';
    }).join('') + '<div class="kpi-cmp"><span class="small muted">' + esc(period) + ' 기준 · 비교:</span><div class="segmented" id="anCmp">' +
      '<button type="button" data-c="prev" class="' + (an.cmp === 'prev' ? 'on' : '') + '">직전 기간</button><button type="button" data-c="yoy" class="' + (an.cmp === 'yoy' ? 'on' : '') + '">전년 같은 기간</button></div>' +
      '<span class="small muted">' + esc(cmpText) + (hasCmp ? '' : ' · <b>비교할 데이터가 없어요</b>') + '</span></div>';
    $$('#anCmp button').forEach(function (b) { b.onclick = function () { an.cmp = b.dataset.c; var y = window.scrollY; renderAnalysis(); window.scrollTo(0, y); }; });
    drawAlerts(cr, hasCmp);

    drawCats();
    if (an.dim === 'cat' && !(an.hasCats && f.withCats)) an.dim = 'cust';
    drawTrend();
    drawGroup();
    drawAnomalies(rows);
    drawDetail(rows);
  }

  /** 분류 규칙으로 따로 모은 항목 (분류 항목 포함을 끈 상태에서만) */
  function drawCats() {
    var an = state.an, box = $('#anCats');
    if (!box) return;
    if (!an.hasCats || an.f.withCats || an.showExcluded) { box.innerHTML = ''; return; }
    var g = {}, t = { n: 0, s: 0, b: 0 };
    anFilter(null, { catsOnly: true }).forEach(function (r) {
      var x = g[r[C.cat]] || (g[r[C.cat]] = { k: r[C.cat], n: 0, s: 0, b: 0 });
      x.n++; x.s += r[C.sales]; x.b += r[C.buys]; t.n++; t.s += r[C.sales]; t.b += r[C.buys];
    });
    var list = Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.s - a.s; });
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="card cats-card"><div class="row-between" style="flex-wrap:wrap;gap:8px;margin-bottom:8px"><div><div class="eyebrow">Other · 따로 분류한 항목</div><h3>위 숫자에 포함되지 않은 항목</h3></div>' +
      '<span class="small muted">"분류 항목 포함"을 켜면 운송과 합쳐서 볼 수 있어요</span></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th class="left">구분</th><th>건수</th><th>매출</th><th>매입</th><th>이익</th></tr></thead><tbody>' +
      list.map(function (x) { return '<tr><td class="left ton">' + esc(x.k) + '</td><td class="num">' + won(x.n) + '</td><td class="num">' + won(x.s) + '</td><td class="num">' + won(x.b) + '</td><td class="num' + (x.s - x.b < 0 ? ' neg' : '') + '">' + won(x.s - x.b) + '</td></tr>'; }).join('') +
      (list.length > 1 ? '<tr class="sum"><td class="left">합계</td><td class="num">' + won(t.n) + '</td><td class="num">' + won(t.s) + '</td><td class="num">' + won(t.b) + '</td><td class="num">' + won(t.s - t.b) + '</td></tr>' : '') +
      '</tbody></table></div></div>';
  }

  /** 월별 추이: 기간 필터는 무시하고 전체 월을 보여줘서 흐름을 볼 수 있게 (선택 기간은 강조) */
  function drawTrend() {
    var an = state.an;
    var all = anFilter(null, { from: '', to: '' });
    var byM = {};
    all.forEach(function (r) { var m = r[C.date].slice(0, 7); var x = byM[m] || (byM[m] = { s: 0, b: 0, n: 0 }); x.s += r[C.sales]; x.b += r[C.buys]; x.n++; });
    // 데이터가 없는 달도 빈칸으로 넣어서 실제 시간 간격대로 보이게 (최근 24개월)
    var have = anMonths(), months = [];
    if (have.length) {
      var lastM = have[have.length - 1], firstM = have[0];
      for (var mm = lastM, k = 0; k < 24 && mm >= firstM; k++, mm = addMonths(mm, -1)) months.unshift(mm);
    }
    var mk = function (m) { var x = byM[m] || { s: 0, b: 0, n: 0 }; return { m: m, s: x.s, b: x.b, n: x.n, p: x.s - x.b, rate: pct(x.s - x.b, x.s), has: !!byM[m] }; };
    var data = months.map(function (m) { var d = mk(m); d.ly = mk(addMonths(m, -12)); return d; });
    var profitMode = an.trendMode !== 'sb';
    $('#anTrend').innerHTML = '<div class="row-between" style="flex-wrap:wrap;gap:8px;margin-bottom:6px"><div><div class="eyebrow">Trend · 월별 추이</div><h3>' + (profitMode ? '월별 이익' : '월별 매출 · 매입') + '</h3></div>' +
      '<div class="actions" style="align-items:center"><div class="legend">' + (profitMode
        ? '<span><i style="background:' + AN_SALES_COLOR + '"></i>이익</span><span><i style="background:' + AN_BUYS_COLOR + '"></i>손실</span><span><i class="ly"></i>전년 같은 달</span>'
        : '<span><i style="background:' + AN_SALES_COLOR + '"></i>매출</span><span><i style="background:' + AN_BUYS_COLOR + '"></i>매입</span>') + '</div>' +
      '<div class="segmented" id="anTrendMode"><button type="button" data-m="profit" class="' + (profitMode ? 'on' : '') + '">이익</button><button type="button" data-m="sb" class="' + (!profitMode ? 'on' : '') + '">매출·매입</button></div></div></div>' +
      (profitMode ? profitChart(data) : columnChart(data)) + '<p class="hint" style="margin:6px 0 0">' + months.length + '개월 · 기간 외 조건(사업자·매출처 등)은 반영 · 선택 기간은 진하게</p>';
    $('#anRate').innerHTML = '<div class="eyebrow">Margin · 이익률</div><h3 style="margin-bottom:6px">월별 이익률</h3>' + lineChart(data) +
      '<p class="hint" style="margin:6px 0 0">이익률 = (매출 − 매입) ÷ 매출</p>';
    $$('#anTrendMode button').forEach(function (b) { b.onclick = function () { an.trendMode = b.dataset.m; drawTrend(); }; });
    var lyText = function (d) { return d.ly.has ? '<br><span style="opacity:.75">전년 ' + d.ly.m + ': 이익 ' + won(d.ly.p) + ' · ' + pctText(d.ly.rate) + '</span>' : ''; };
    bindChartHover($('#anTrend'), data, function (d) {
      return '<b>' + d.m + '</b><br><i style="background:' + AN_SALES_COLOR + '"></i>매출 ' + won(d.s) + '<br><i style="background:' + AN_BUYS_COLOR + '"></i>매입 ' + won(d.b) +
        '<br>이익 ' + won(d.p) + ' · ' + pctText(d.rate) + '<br>' + won(d.n) + '건' + lyText(d);
    });
    bindChartHover($('#anRate'), data, function (d) { return '<b>' + d.m + '</b><br>이익률 ' + pctText(d.rate) + '<br>이익 ' + won(d.p) + lyText(d); });
  }

  /** 월별 이익 막대 (손실은 아래로) + 전년 같은 달 이익 표시(가로 눈금) */
  function profitChart(data) {
    var W = 640, H = 240, L = 52, R = 8, T = 10, B = 26;
    var vals = [];
    data.forEach(function (d) { vals.push(d.p); if (d.ly.has) vals.push(d.ly.p); });
    var maxV = niceMax(Math.max.apply(null, vals.concat([1]))), minV = Math.min.apply(null, vals.concat([0]));
    minV = minV < 0 ? -niceMax(-minV) : 0;
    var n = data.length, band = (W - L - R) / Math.max(n, 1), bw = Math.min(24, Math.max(4, band * 0.55));
    var y = function (v) { return T + (H - T - B) * (maxV - v) / (maxV - minV); };
    var f = state.an.f;
    var ticks = [];
    for (var k = 0; k <= 4; k++) ticks.push(minV + (maxV - minV) * k / 4);
    var grid = ticks.map(function (v) { return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="gridl"/><text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" class="axis" text-anchor="end">' + shortWon(v) + '</text>'; }).join('');
    var bars = data.map(function (d, i) {
      var cx = L + band * i + band / 2, x0 = cx - bw / 2, inRange = d.m >= f.from && d.m <= f.to, op = inRange ? 1 : 0.35;
      var out = '';
      if (d.has && d.p !== 0) {
        var top = y(Math.max(d.p, 0)), bot = y(Math.min(d.p, 0)), h = bot - top, r = Math.min(4, bw / 2, h);
        var c = d.p >= 0 ? AN_SALES_COLOR : AN_BUYS_COLOR;
        out += d.p >= 0
          ? '<path d="M' + x0 + ',' + bot + 'V' + (top + r) + 'Q' + x0 + ',' + top + ' ' + (x0 + r) + ',' + top + 'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ',' + top + ' ' + (x0 + bw) + ',' + (top + r) + 'V' + bot + 'Z" fill="' + c + '" opacity="' + op + '"/>'
          : '<path d="M' + x0 + ',' + top + 'V' + (bot - r) + 'Q' + x0 + ',' + bot + ' ' + (x0 + r) + ',' + bot + 'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ',' + bot + ' ' + (x0 + bw) + ',' + (bot - r) + 'V' + top + 'Z" fill="' + c + '" opacity="' + op + '"/>';
      }
      if (d.ly.has) out += '<line x1="' + (cx - bw / 2 - 3) + '" x2="' + (cx + bw / 2 + 3) + '" y1="' + y(d.ly.p) + '" y2="' + y(d.ly.p) + '" class="lymark"/>';
      var lbl = (n <= 12 || i % Math.ceil(n / 12) === 0) ? '<text x="' + cx + '" y="' + (H - 8) + '" class="axis" text-anchor="middle">' + d.m.slice(2).replace('-', '.') + '</text>' : '';
      return out + lbl + '<rect class="hit" data-i="' + i + '" x="' + (L + band * i) + '" y="' + T + '" width="' + band + '" height="' + (H - T - B) + '" fill="transparent"/>';
    }).join('');
    return '<div class="chartbox"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="월별 이익 막대 차트">' + grid +
      '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="base"/>' + bars + '</svg><div class="tip hidden"></div></div>';
  }

  /** 비교 기간보다 이익률이 눈에 띄게 떨어졌거나 적자로 돌아선 매출처 */
  function drawAlerts(cr, hasCmp) {
    var an = state.an, box = $('#anAlerts'), al = an.alert;
    if (!box) return;
    if (!hasCmp || an.showExcluded) { box.innerHTML = ''; return; }
    var cur = {}, prev = {};
    var add = function (map, r) { var k = r[C.disp], x = map[k] || (map[k] = { k: k, n: 0, s: 0, b: 0 }); x.n++; x.s += r[C.sales]; x.b += r[C.buys]; };
    anFilter('cust').forEach(function (r) { add(cur, r); });
    anFilter('cust', { from: cr.from, to: cr.to }).forEach(function (r) { add(prev, r); });
    var sel = an.f.sel.cust || [];
    var list = Object.keys(cur).map(function (k) {
      var a = cur[k], b = prev[k];
      a.p = a.s - a.b; a.r = pct(a.p, a.s);
      if (!b) return null;
      b.p = b.s - b.b; b.r = pct(b.p, b.s);
      a.cr = b.r; a.cp = b.p; a.dr = a.r != null && b.r != null ? a.r - b.r : null; a.dp = a.p - b.p;
      a.turned = b.p > 0 && a.p < 0;
      return a;
    }).filter(function (x) {
      return x && (!sel.length || sel.indexOf(x.k) !== -1) && x.s >= al.minSales && (x.turned || (x.dr != null && x.dr <= -al.drop));
    }).sort(function (a, b) { return (a.turned === b.turned ? 0 : a.turned ? -1 : 1) || a.dr - b.dr; });
    box.innerHTML = '<div class="card alerts-card">' +
      '<div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:10px"><div><div class="eyebrow">Watch · 확인해 볼 곳</div><h3>' + esc(cr.label) + '보다 이익률이 떨어진 매출처 ' +
      '<span class="' + (list.length ? 'neg' : 'muted') + '">' + list.length + '곳</span></h3></div>' +
      '<div class="actions small" style="align-items:center">이익률 <input class="input input-sm num" id="alDrop" type="number" min="0" step="0.5" value="' + al.drop + '" style="width:64px">%p 이상 하락 · 매출 <select class="input input-sm" id="alMin" style="width:auto">' +
      [[0, '전체'], [500000, '50만↑'], [1000000, '100만↑'], [5000000, '500만↑'], [10000000, '1,000만↑']].map(function (o) { return '<option value="' + o[0] + '"' + (al.minSales === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div></div>' +
      (list.length ? '<div class="table-wrap"><table class="data grp"><thead><tr><th class="left">매출처</th><th>이익률</th><th>' + esc(cr.label) + '</th><th>변화</th><th>이익</th><th>이익 증감</th><th>매출</th><th>건수</th></tr></thead><tbody>' +
        list.slice(0, 15).map(function (x) {
          return '<tr class="pick" data-k="' + esc(x.k) + '"><td class="left wrap">' + (x.turned ? '<span class="badge down">적자 전환</span> ' : '') + esc(x.k) + ' <button class="cc-btn" data-cc="' + esc(x.k) + '">상세</button></td>' +
            '<td class="num' + (x.r < 0 ? ' neg' : '') + '">' + pctText(x.r) + '</td><td class="num muted">' + pctText(x.cr) + '</td>' +
            '<td class="num">' + deltaHtml(x.dr, '%p', true) + '</td><td class="num' + (x.p < 0 ? ' neg' : '') + '">' + won(x.p) + '</td>' +
            '<td class="num' + (x.dp < 0 ? ' neg' : '') + '">' + (x.dp > 0 ? '+' : '') + won(x.dp) + '</td><td class="num">' + won(x.s) + '</td><td class="num">' + won(x.n) + '</td></tr>';
        }).join('') + '</tbody></table></div>' + (list.length > 15 ? '<p class="hint" style="margin:6px 0 0">상위 15곳만 표시 · 아래 순위표에서 "이익률 하락 큰 순"으로 전체를 볼 수 있어요.</p>' : '') +
        '<p class="hint" style="margin:8px 0 0">행을 누르면 그 매출처로 걸러져서, 아래 "경로 조합" 탭에서 어느 경로에서 손실이 났는지 바로 볼 수 있어요.</p>'
        : '<p class="muted" style="margin:0">조건에 해당하는 매출처가 없어요. 👍</p>') + '</div>';
    var later = function () { clearTimeout(an.alertTimer); an.alertTimer = setTimeout(function () { drawAlerts(cr, hasCmp); }, 0); };
    $('#alDrop').onchange = function () { al.drop = Math.max(0, Number(this.value) || 0); later(); };
    $('#alMin').onchange = function () { al.minSales = Number(this.value); later(); };
    $$('#anAlerts [data-cc]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openCustCard(b.dataset.cc); }; });
    $$('#anAlerts tr.pick').forEach(function (tr) {
      tr.onclick = function () { an.f.sel.cust = [tr.dataset.k]; an.dim = 'route'; an.sort = { key: 'profit', dir: 1 }; an.detailPage = 0; renderAnalysis(); var g = $('#anGroup'); if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    });
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  function columnChart(data) {
    var W = 640, H = 240, L = 52, R = 8, T = 10, B = 26;
    var max = niceMax(Math.max.apply(null, data.map(function (d) { return Math.max(d.s, d.b); }).concat([1])));
    var n = data.length, band = (W - L - R) / Math.max(n, 1);
    var bw = Math.min(16, Math.max(3, (band - 8) / 2));
    var y = function (v) { return T + (H - T - B) * (1 - Math.max(0, v) / max); };
    var f = state.an.f;
    var grid = [0, 0.25, 0.5, 0.75, 1].map(function (k) {
      var v = max * k, yy = y(v);
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" class="gridl"/><text x="' + (L - 6) + '" y="' + (yy + 4) + '" class="axis" text-anchor="end">' + shortWon(v) + '</text>';
    }).join('');
    var bars = data.map(function (d, i) {
      var cx = L + band * i + band / 2, inRange = (!f.from || d.m >= f.from) && (!f.to || d.m <= f.to);
      var op = inRange ? 1 : 0.35;
      var col = function (v, x, c) {
        var top = y(v), h = Math.max(0, y(0) - top);
        if (h <= 0) return '';
        var r = Math.min(4, bw / 2, h);
        return '<path d="M' + x + ',' + y(0) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + y(0) + 'Z" fill="' + c + '" opacity="' + op + '"/>';
      };
      var lbl = (n <= 12 || i % Math.ceil(n / 12) === 0) ? '<text x="' + cx + '" y="' + (H - 8) + '" class="axis" text-anchor="middle">' + d.m.slice(2).replace('-', '.') + '</text>' : '';
      return col(d.s, cx - bw - 1, AN_SALES_COLOR) + col(d.b, cx + 1, AN_BUYS_COLOR) + lbl +
        '<rect class="hit" data-i="' + i + '" x="' + (L + band * i) + '" y="' + T + '" width="' + band + '" height="' + (H - T - B) + '" fill="transparent"/>';
    }).join('');
    return '<div class="chartbox"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="월별 매출 매입 막대 차트">' + grid + '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="base"/>' + bars + '</svg><div class="tip hidden"></div></div>';
  }

  function lineChart(data) {
    var W = 360, H = 240, L = 40, R = 14, T = 14, B = 26;
    var vals = data.map(function (d) { return d.rate; }).filter(function (v) { return v != null; });
    var lo = Math.min.apply(null, vals.concat([0])), hi = Math.max.apply(null, vals.concat([5]));
    lo = Math.floor(lo / 5) * 5; hi = Math.ceil(hi / 5) * 5; if (hi === lo) hi = lo + 5;
    var n = data.length, step = (W - L - R) / Math.max(n - 1, 1);
    var x = function (i) { return n === 1 ? (L + W - R) / 2 : L + step * i; };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var ticks = [];
    for (var t = lo; t <= hi; t += Math.max(5, Math.ceil((hi - lo) / 4 / 5) * 5)) ticks.push(t);
    var grid = ticks.map(function (t) { return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="' + (t === 0 ? 'base' : 'gridl') + '"/><text x="' + (L - 6) + '" y="' + (y(t) + 4) + '" class="axis" text-anchor="end">' + t + '%</text>'; }).join('');
    var path = '', pts = '';
    var gap = true;
    data.forEach(function (d, i) {
      if (d.rate == null) { gap = true; return; }
      path += (gap ? 'M' : 'L') + x(i) + ',' + y(d.rate);
      gap = false;
    });
    var dots = data.map(function (d, i) { return d.rate == null ? '' : '<circle cx="' + x(i) + '" cy="' + y(d.rate) + '" r="2.5" fill="var(--ink-2)"/>'; }).join('');
    var lastI = -1; data.forEach(function (d, i) { if (d.rate != null) lastI = i; });
    if (lastI >= 0) {
      var d = data[lastI];
      pts = '<circle cx="' + x(lastI) + '" cy="' + y(d.rate) + '" r="4.5" fill="var(--ink)" stroke="var(--panel)" stroke-width="2"/>' +
        '<text x="' + Math.min(x(lastI), W - R - 2) + '" y="' + (y(d.rate) - 10) + '" class="vlabel" text-anchor="end">' + d.rate.toFixed(1) + '%</text>';
    }
    var labels = data.map(function (d, i) { return (n <= 6 || i % Math.ceil(n / 6) === 0) ? '<text x="' + x(i) + '" y="' + (H - 8) + '" class="axis" text-anchor="middle">' + d.m.slice(2).replace('-', '.') + '</text>' : ''; }).join('');
    var hits = data.map(function (d, i) { var w = step || (W - L - R); return '<rect class="hit" data-i="' + i + '" x="' + (x(i) - w / 2) + '" y="' + T + '" width="' + w + '" height="' + (H - T - B) + '" fill="transparent"/>'; }).join('');
    return '<div class="chartbox"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="월별 이익률 선 차트">' + grid +
      '<path d="' + path + '" fill="none" stroke="var(--ink-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + (n <= 36 ? dots : '') + pts + labels + hits + '</svg><div class="tip hidden"></div></div>';
  }

  function bindChartHover(card, data, fmt) {
    var box = $('.chartbox', card), tip = $('.tip', card);
    if (!box) return;
    $$('.hit', box).forEach(function (h) {
      h.onmouseenter = function () { h.setAttribute('fill', 'rgba(30,28,25,.05)'); tip.innerHTML = fmt(data[h.dataset.i]); tip.classList.remove('hidden'); };
      h.onmousemove = function (e) {
        var rc = box.getBoundingClientRect(), x = e.clientX - rc.left, yy = e.clientY - rc.top;
        tip.style.left = Math.min(x + 14, rc.width - tip.offsetWidth - 4) + 'px';
        tip.style.top = Math.max(0, yy - tip.offsetHeight - 10) + 'px';
      };
      h.onmouseleave = function () { h.setAttribute('fill', 'transparent'); tip.classList.add('hidden'); };
    });
  }

  var SORT_PRESETS = [['profit', -1, '이익 높은 순'], ['rate', 1, '이익률 낮은 순'], ['profit', 1, '손실 큰 순'], ['drate', 1, '이익률 하락 큰 순'], ['unit', 1, '건당 이익 낮은 순'], ['n', -1, '건수 많은 순']];

  function drawGroup() {
    var an = state.an, f = an.f, dim = an.dim, def = dimDef(dim);
    var isRoute = dim === 'route';
    var group = function (rows) {
      var g = {};
      rows.forEach(function (r) {
        var k = def[2](r), x = g[k];
        if (!x) { x = g[k] = { k: k, n: 0, s: 0, b: 0 }; if (isRoute) x.parts = [r[C.from], r[C.to], r[C.weight]]; }
        x.n++; x.s += r[C.sales]; x.b += r[C.buys];
      });
      return g;
    };
    var g = group(anFilter(dim)); // 같은 차원의 선택은 빼고 집계 → 선택하지 않은 항목도 계속 보임
    var cr = cmpRange(), hasCmp = dim !== 'month' && rangeHasData(cr);
    var pg = hasCmp ? group(anFilter(dim, { from: cr.from, to: cr.to })) : {};
    var total = 0;
    var list = Object.keys(g).map(function (k) {
      var x = g[k]; x.p = x.s - x.b; x.r = pct(x.p, x.s); x.u = x.n ? x.p / x.n : 0; total += x.s;
      var y = pg[k];
      if (y) { var yr = pct(y.s - y.b, y.s); x.cr = yr; x.dr = x.r != null && yr != null ? x.r - yr : null; x.dp = x.p - (y.s - y.b); }
      return x;
    }).filter(function (x) { return x.n >= an.minN; });
    var sk = an.sort.key, dir = an.sort.dir;
    var val = function (x) {
      return sk === 'name' ? x.k : sk === 'n' ? x.n : sk === 'buys' ? x.b : sk === 'profit' ? x.p : sk === 'unit' ? x.u :
        sk === 'rate' ? (x.r == null ? (dir > 0 ? 1e9 : -1e9) : x.r) : sk === 'drate' ? (x.dr == null ? (dir > 0 ? 1e9 : -1e9) : x.dr) : x.s;
    };
    list.sort(function (a, b) { var va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir; });
    var gq = an.groupQ.trim();
    if (gq) list = list.filter(function (x) { return String(x.k).indexOf(gq) !== -1; });
    var selected = isRoute ? [] : (f.sel[dim] || []);
    var shown = list.slice(0, an.groupLimit);
    var maxAbs = Math.max.apply(null, list.map(function (x) { return Math.abs(x.p); }).concat([1]));
    var th = function (key, label, left) {
      var on = sk === key;
      return '<th class="sortable' + (left ? ' left' : '') + (on ? ' on' : '') + '" data-sort="' + key + '">' + label + (on ? (dir < 0 ? ' ▼' : ' ▲') : '') + '</th>';
    };
    var presetOn = function (p) { return p[0] === sk && p[1] === dir; };
    $('#anGroup').innerHTML =
      '<div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:12px"><div><div class="eyebrow">Ranking · 묶어 보기</div><h3>' + esc(def[1]) + '별 ' + (isRoute ? '수익' : '순위') + ' <span class="muted small">' + won(list.length) + '개</span></h3></div>' +
      '<div class="actions"><input class="input input-sm" id="anGQ" placeholder="' + esc(def[1]) + ' 찾기" value="' + esc(an.groupQ) + '" style="width:200px"><button class="btn btn-sm" id="anGX">엑셀</button></div></div>' +
      '<div class="tabs-line" id="anDims">' + AN_DIMS.filter(function (d) { return d[0] !== 'cat' || (an.hasCats && f.withCats); }).map(function (d) { return '<button type="button" data-d="' + d[0] + '" class="' + (d[0] === dim ? 'on' : '') + '">' + d[1] + ((f.sel[d[0]] || []).length ? ' <span class="cnt">' + f.sel[d[0]].length + '</span>' : '') + '</button>'; }).join('') + '</div>' +
      '<div class="toolbar">' +
      '<div class="chips" id="anPresets">' + SORT_PRESETS.filter(function (p) { return p[0] !== 'drate' || hasCmp; }).map(function (p, i) { return '<button type="button" class="chip' + (presetOn(p) ? ' on' : '') + '" data-pi="' + SORT_PRESETS.indexOf(p) + '">' + p[2] + '</button>'; }).join('') + '</div>' +
      '<span class="small muted" style="margin-left:auto">최소 건수</span><select class="input input-sm" id="anMinN" style="width:auto">' + [1, 2, 3, 5, 10, 20].map(function (n) { return '<option' + (an.minN === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>' +
      (isRoute ? '<label class="toggle small"><input type="checkbox" id="anRouteW"' + (an.routeWeight ? ' checked' : '') + '><span class="track"></span>중량까지 나누기</label>' : '') +
      '</div>' +
      '<div class="table-wrap"><table class="data grp"><thead><tr>' + th('name', esc(def[1]), true) + th('n', '건수') + th('sales', '매출') + th('buys', '매입') + th('profit', '이익') + th('rate', '이익률') +
      (hasCmp ? th('drate', '이익률 변화') : '') + th('unit', '건당 이익') + '<th class="left" style="width:15%">이익 크기</th></tr></thead><tbody>' +
      (shown.map(function (x) {
        var on = selected.indexOf(x.k) !== -1;
        var name = isRoute
          ? '<span class="route"><span>' + esc(x.parts[0] || '(빈칸)') + '</span><i>→</i><span>' + esc(x.parts[1] || '(빈칸)') + '</span>' + (an.routeWeight ? '<em>' + esc(x.parts[2] || '-') + '</em>' : '') + '</span>'
          : '<span class="pickbox">' + (on ? '✓' : '') + '</span>' + esc(x.k || '(빈칸)') + (dim === 'cust' ? ' <button class="cc-btn" data-cc="' + esc(x.k) + '" title="매출처 상세">상세</button>' : '');
        return '<tr class="pick' + (on ? ' picked' : '') + '" data-k="' + esc(x.k) + '"><td class="left wrap">' + name + '</td><td class="num">' + won(x.n) + '</td><td class="num">' + won(x.s) + '</td><td class="num">' + won(x.b) + '</td>' +
          '<td class="num strong' + (x.p < 0 ? ' neg' : '') + '">' + won(x.p) + '</td><td class="num' + (x.r != null && x.r < 0 ? ' neg' : '') + '">' + pctText(x.r) + '</td>' +
          (hasCmp ? '<td class="num" title="' + esc(cr.label) + ' ' + pctText(x.cr) + '">' + (x.dr == null ? '<span class="dl">신규</span>' : deltaHtml(x.dr, '%p', true)) + '</td>' : '') +
          '<td class="num' + (x.u < 0 ? ' neg' : '') + '">' + won(Math.round(x.u)) + '</td>' +
          '<td class="left"><div class="pbar"><i class="' + (x.p < 0 ? 'loss' : '') + '" style="width:' + (Math.abs(x.p) / maxAbs * 100).toFixed(1) + '%"></i></div></td></tr>';
      }).join('') || '<tr><td colspan="9" class="left muted" style="padding:20px">조건에 맞는 데이터가 없습니다.</td></tr>') +
      '</tbody></table></div>' +
      (list.length > shown.length ? '<div style="text-align:center;margin-top:10px"><button class="btn btn-sm" id="anMore">더 보기 (' + won(list.length - shown.length) + '개 남음)</button></div>' : '') +
      '<p class="hint" style="margin:10px 0 0">' + (isRoute
        ? '발지 → 착지' + (an.routeWeight ? ' → 중량' : '') + ' 조합별로 묶었어요. 매출처를 먼저 고르면 "그 업체가 주로 주는 오더"와 "어디서 손실이 나는지"가 보여요. 행을 누르면 그 조합으로 걸러져요.'
        : '행을 누르면 그 ' + esc(def[1]) + '(으)로 걸러지고, 다시 누르면 풀려요. 여러 개를 고를 수 있어요.') +
      (hasCmp ? ' · 이익률 변화는 ' + esc(cr.label) + ' 대비' : '') + '</p>';

    $$('#anDims button').forEach(function (b) { b.onclick = function () { an.dim = b.dataset.d; an.groupLimit = 50; an.groupQ = ''; drawGroup(); }; });
    $$('#anPresets .chip').forEach(function (c) { c.onclick = function () { var p = SORT_PRESETS[c.dataset.pi]; an.sort = { key: p[0], dir: p[1] }; drawGroup(); }; });
    $('#anMinN').onchange = function () { an.minN = Number(this.value); drawGroup(); };
    var rw = $('#anRouteW'); if (rw) rw.onchange = function () { an.routeWeight = this.checked; drawGroup(); };
    $$('#anGroup th[data-sort]').forEach(function (h) {
      h.onclick = function () { var k = h.dataset.sort; if (an.sort.key === k) an.sort.dir *= -1; else { an.sort.key = k; an.sort.dir = k === 'name' ? 1 : -1; } drawGroup(); };
    });
    var partsOf = {};
    list.forEach(function (x) { if (x.parts) partsOf[x.k] = x.parts; });
    $$('#anGroup [data-cc]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openCustCard(b.dataset.cc); }; });
    $$('#anGroup tr.pick').forEach(function (tr) {
      tr.onclick = function () {
        var k = tr.dataset.k;
        if (dim === 'month') { f.from = k; f.to = k; renderAnalysis(); return; }
        if (dim === 'biz') { var bi = f.biz.indexOf(k); if (bi === -1) f.biz.push(k); else f.biz.splice(bi, 1); renderAnalysis(); return; }
        if (isRoute) {
          var pt = partsOf[k];
          f.sel.from = [pt[0]]; f.sel.to = [pt[1]];
          if (an.routeWeight) f.sel.weight = [pt[2]];
          an.dim = 'driver';
        } else {
          var arr = f.sel[dim] || (f.sel[dim] = []), i = arr.indexOf(k);
          if (i === -1) arr.push(k); else arr.splice(i, 1);
        }
        an.detailPage = 0;
        var y = window.scrollY; renderAnalysis(); window.scrollTo(0, y);
      };
    });
    var st;
    $('#anGQ').oninput = function () { var v = this.value; clearTimeout(st); st = setTimeout(function () { an.groupQ = v; drawGroup(); var el = $('#anGQ'); el.focus(); el.setSelectionRange(v.length, v.length); }, 200); };
    var more = $('#anMore'); if (more) more.onclick = function () { an.groupLimit += 100; drawGroup(); };
    $('#anGX').onclick = function () {
      var btn = this; busy(btn, true, '…');
      var head = isRoute ? ['발지', '착지', '중량', '건수', '매출', '매입', '이익', '이익률(%)', '건당 이익'] : [def[1], '건수', '매출', '매입', '이익', '이익률(%)', '건당 이익'];
      if (hasCmp) head.push(cr.label + ' 이익률(%)', '이익률 변화(%p)');
      downloadXlsx('조일ver1_분석_' + def[1] + '별_' + f.from + '_' + f.to + '.xlsx', [{
        name: def[1] + '별', widths: isRoute ? [24, 24, 10, 8, 14, 14, 14, 9, 12, 12, 12] : [36, 8, 14, 14, 14, 9, 12, 12, 12],
        rows: [head].concat(list.map(function (x) {
          var row = (isRoute ? [x.parts[0], x.parts[1], an.routeWeight ? x.parts[2] : '(전체)'] : [x.k]).concat([x.n, x.s, x.b, x.p, x.r == null ? '' : Math.round(x.r * 10) / 10, Math.round(x.u)]);
          if (hasCmp) row.push(x.cr == null ? '' : Math.round(x.cr * 10) / 10, x.dr == null ? '' : Math.round(x.dr * 10) / 10);
          return row;
        }))
      }]).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  function drawDetail(rows) {
    var an = state.an, PAGE_N = 100, f = an.f;
    var sorted = rows.slice().sort(function (a, b) { return (a[C.date] < b[C.date] ? -1 : a[C.date] > b[C.date] ? 1 : 0) * an.detailSort; });
    var pages = Math.max(1, Math.ceil(sorted.length / PAGE_N));
    if (an.detailPage >= pages) an.detailPage = 0;
    var page = sorted.slice(an.detailPage * PAGE_N, (an.detailPage + 1) * PAGE_N);
    var heads = ['날짜', '사업자', '매출처', '발지', '착지', '중량', '매출', '매입', '이익', '차량번호', '기사명', '차량전화', '기타1', '비고'];
    $('#anDetail').innerHTML =
      '<div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:12px"><div><div class="eyebrow">Rows · 상세 내역</div><h3>' + won(rows.length) + '건</h3></div>' +
      '<div class="actions"><button class="btn btn-sm" id="anDSort">날짜 ' + (an.detailSort < 0 ? '최신순 ▼' : '오래된순 ▲') + '</button><button class="btn btn-sm btn-primary" id="anDX"' + (rows.length ? '' : ' disabled') + '>엑셀 다운로드 (' + won(rows.length) + '건)</button></div></div>' +
      '<div class="bulk-table" style="max-height:64vh"><table class="data bulk detailt"><thead><tr>' + heads.map(function (h, i) { return '<th class="' + (i < 6 || i > 8 ? 'left' : '') + '">' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (page.map(function (r) {
        var p = r[C.sales] - r[C.buys];
        return '<tr><td class="left small">' + esc(r[C.date]) + '</td><td class="left small">' + esc(r[C.biz]) + '</td><td class="left wrap">' + esc(r[C.disp]) + (r[C.disp] !== r[C.cust] ? '<div class="addr-in">' + esc(r[C.cust]) + '</div>' : '') + '</td>' +
          '<td class="left wrap">' + esc(r[C.from]) + '</td><td class="left wrap">' + esc(r[C.to]) + '</td><td class="left">' + esc(r[C.weight]) + '</td>' +
          '<td class="num">' + won(r[C.sales]) + '</td><td class="num">' + won(r[C.buys]) + '</td><td class="num' + (p < 0 ? ' neg' : '') + '">' + won(p) + '</td>' +
          '<td class="left">' + esc(r[C.car]) + '</td><td class="left">' + esc(r[C.driver]) + '</td><td class="left small">' + esc(r[C.phone]) + '</td><td class="left small wrap">' + esc(r[C.etc]) + '</td><td class="left small wrap">' + esc(r[C.note]) + '</td></tr>';
      }).join('') || '<tr><td colspan="14" class="left muted" style="padding:20px">조건에 맞는 내역이 없습니다.</td></tr>') +
      '</tbody></table></div>' +
      (pages > 1 ? '<div class="pager" style="margin-top:12px">' + pagerButtons(an.detailPage, pages) + '</div>' : '');
    $('#anDSort').onclick = function () { an.detailSort *= -1; an.detailPage = 0; drawDetail(rows); };
    $$('#anDetail .pager button').forEach(function (b) { b.onclick = function () { an.detailPage = Number(b.dataset.p); drawDetail(rows); $('#anDetail').scrollIntoView({ block: 'start' }); }; });
    $('#anDX').onclick = function () {
      var btn = this; busy(btn, true, '만드는 중…');
      var body = sorted.map(function (r) { return [r[C.date], r[C.biz], r[C.disp], r[C.cust], r[C.from], r[C.to], r[C.weight], r[C.sales], r[C.buys], r[C.sales] - r[C.buys], r[C.car], r[C.driver], r[C.phone], r[C.etc], r[C.note]]; });
      var cond = [['항목', '값'], ['기간', f.from + ' ~ ' + f.to], ['사업자', f.biz.join(', ') || '전체'], ['검색', f.q || '-']];
      Object.keys(f.sel).forEach(function (k) { if ((f.sel[k] || []).length) cond.push([dimDef(k)[1], f.sel[k].join(', ')]); });
      cond.push(['내려받은 사람', state.user.name + ' (' + state.user.id + ')'], ['내려받은 시각', new Date().toLocaleString('ko-KR')]);
      downloadXlsx('조일ver1_분석내역_' + f.from + '_' + f.to + '_' + rows.length + '건.xlsx', [
        { name: '상세 내역', widths: [11, 10, 26, 30, 16, 16, 8, 12, 12, 12, 13, 8, 14, 16, 20], rows: [['날짜', '사업자', '매출처(표시)', '매출처(원본)', '발지', '착지', '중량', '매출후불', '매입후불', '이익', '차량번호', '기사명', '차량전화', '기타1', '비고']].concat(body) },
        { name: '조건', widths: [14, 60], rows: cond }
      ]).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  function pagerButtons(cur, pages) {
    var out = [], push = function (p) { out.push('<button data-p="' + p + '" class="' + (p === cur ? 'on' : '') + '">' + (p + 1) + '</button>'); };
    for (var p = 0; p < pages; p++) {
      if (p === 0 || p === pages - 1 || Math.abs(p - cur) <= 2) push(p);
      else if (out[out.length - 1] !== '<span class="muted">…</span>') out.push('<span class="muted">…</span>');
    }
    return out.join('');
  }

  function openCustPicker() {
    var an = state.an, f = an.f;
    var saved = f.sel.cust;
    f.sel.cust = [];
    var rows = anFilter('cust');
    f.sel.cust = saved;
    var g = {};
    rows.forEach(function (r) { var x = g[r[C.disp]] || (g[r[C.disp]] = { k: r[C.disp], s: 0, n: 0 }); x.s += r[C.sales]; x.n++; });
    var list = Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.s - a.s; });
    var picked = (f.sel.cust || []).slice();
    modal({
      wide: true, eyebrow: '필터', title: '매출처 고르기',
      body: '<input class="input input-sm" id="cpQ" placeholder="매출처 검색" style="margin-bottom:10px"><div class="row-between small" style="margin-bottom:8px"><span class="muted" id="cpN"></span><span><button class="btn btn-ghost btn-sm" id="cpAll">보이는 것 모두 선택</button><button class="btn btn-ghost btn-sm" id="cpNone">선택 해제</button></span></div><div class="cplist" id="cpList"></div>',
      foot: '<button class="btn" data-close>취소</button><button class="btn btn-primary" id="cpOk">적용</button>',
      onMount: function (m, close) {
        var q = '';
        function draw() {
          var vis = list.filter(function (x) { return !q || x.k.indexOf(q) !== -1; });
          $('#cpList', m).innerHTML = vis.map(function (x) {
            var on = picked.indexOf(x.k) !== -1;
            return '<label class="cpitem' + (on ? ' on' : '') + '"><input type="checkbox" data-k="' + esc(x.k) + '"' + (on ? ' checked' : '') + '><span class="nm">' + esc(x.k) + '</span><span class="muted small num">' + shortWon(x.s) + ' · ' + won(x.n) + '건</span></label>';
          }).join('') || '<p class="muted">없습니다.</p>';
          $('#cpN', m).textContent = picked.length ? picked.length + '곳 선택됨' : '선택 없음 = 전체';
          $$('#cpList input', m).forEach(function (cb) {
            cb.onchange = function () { var i = picked.indexOf(cb.dataset.k); if (cb.checked && i === -1) picked.push(cb.dataset.k); if (!cb.checked && i !== -1) picked.splice(i, 1); draw(); };
          });
          return vis;
        }
        var vis = draw();
        $('#cpQ', m).oninput = function () { q = this.value.trim(); vis = draw(); };
        $('#cpAll', m).onclick = function () { vis.forEach(function (x) { if (picked.indexOf(x.k) === -1) picked.push(x.k); }); vis = draw(); };
        $('#cpNone', m).onclick = function () { picked = []; vis = draw(); };
        $('#cpOk', m).onclick = function () { f.sel.cust = picked; an.detailPage = 0; close(); renderAnalysis(); };
      }
    });
  }

  /* ───────── 관리자 ───────── */

  var ADMIN_TABS = [
    ['basic', '기본 설정', 'var(--orange)'],
    ['region', '지역 할증', 'var(--yellow)'],
    ['tariff', '타리프 단가', 'var(--red)'],
    ['users', '계정 관리', 'var(--cyan)'],
    ['andata', '분석 데이터', 'var(--green)'],
    ['anmap', '매출처 설정', 'var(--yellow)'],
    ['anrule', '분석 규칙', 'var(--red)'],
    ['diesel', '유가 기록', 'var(--cyan)'],
    ['keys', 'API 키', 'var(--ink-2)']
  ];

  function loadAdmin(force) {
    var a = state.admin;
    if (a.loaded && !force) return Promise.resolve();
    return api('admin.bootstrap').then(function (r) {
      if (!a.settingsDirty) a.settings = r.settings;
      a.keys = r.keys; a.users = r.users; a.logs = r.logs; a.cache = r.cache;
      a.loaded = true;
      loadTariff(); // 타리프는 크니까 뒤에서 미리 받아 둠
    });
  }

  function loadTariff() {
    var a = state.admin;
    if (a.tariff) return Promise.resolve();
    return api('admin.getTariff').then(function (r) {
      if (!a.tariff) { a.tariff = r.tariff; a.tariffOrig = clone(r.tariff); }
    });
  }

  function renderAdmin() {
    var a = state.admin;
    $('#main').innerHTML =
      '<div class="admin-grid"><nav class="card rail">' + ADMIN_TABS.map(function (t) {
        return '<button data-tab="' + t[0] + '" class="' + (a.tab === t[0] ? 'on' : '') + '"><span class="dot" style="--c:' + t[2] + '"></span>' + t[1] + '</button>';
      }).join('') + '</nav><section id="adminBody"></section></div>';
    $$('.rail button').forEach(function (b) {
      b.onclick = function () {
        a.tab = b.dataset.tab;
        $$('.rail button').forEach(function (x) { x.classList.toggle('on', x === b); });
        showAdminTab();
      };
    });
    showAdminTab();
  }

  function adminLoading(msg) {
    $('#adminBody').innerHTML = '<div class="card"><div class="row-between"><span class="muted"><span class="spinner dark"></span> ' + esc(msg) + '</span></div>' +
      '<p class="hint" style="margin:10px 0 0">서버가 한동안 쉬었다가 처음 깨어날 때는 몇 초 더 걸릴 수 있어요.</p></div>';
  }

  function showAdminTab() {
    var a = state.admin, tab = a.tab;
    var views = { basic: adminBasic, region: adminRegion, tariff: adminTariff, users: adminUsers, keys: adminKeys, andata: adminAnData, anmap: adminAnMap, anrule: adminAnRules, diesel: adminDiesel };
    var ready = a.loaded && (tab !== 'tariff' || a.tariff);
    if (ready) {
      views[tab]();
      return;
    }
    adminLoading(tab === 'tariff' && a.loaded ? '타리프 불러오는 중…' : '관리자 정보 불러오는 중…');
    loadAdmin().then(function () { return tab === 'tariff' ? loadTariff() : null; }).then(function () {
      if (state.view === 'admin' && state.admin.tab === tab) views[tab]();
    }).catch(function (err) {
      if (state.view !== 'admin' || state.admin.tab !== tab) return;
      $('#adminBody').innerHTML = '<div class="card"><p style="margin:0 0 14px">' + esc(err.message) + '</p><button class="btn btn-primary btn-sm" id="adminRetry">다시 불러오기</button></div>';
      $('#adminRetry').onclick = showAdminTab;
    });
  }

  function saveBar(dirty, label) {
    return '<div class="save-bar"><span class="small muted" style="margin-right:auto">' +
      (dirty ? '<span class="dirty-dot"></span>저장하지 않은 변경사항' : '변경사항 없음') + '</span>' +
      '<button class="btn btn-accent" id="saveBtn">' + esc(label || '저장') + '</button></div>';
  }

  function saveSettings(btn) {
    var a = state.admin;
    busy(btn, true, '저장 중…');
    return api('admin.saveSettings', { settings: a.settings }).then(function (r) {
      a.settings = r.settings; a.settingsDirty = false;
      return api('publicSettings');
    }).then(function (r) {
      state.pub = r.settings;
      state.calc.tons = state.calc.tons.filter(function (t) { return state.pub.tons.indexOf(t) !== -1; });
      state.calc.baseTon = state.pub.baseTon;
      state.calc.result = null;
      toast('설정을 저장했습니다.');
      renderAdmin();
    }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
  }

  function bindDirty(root, onChange) {
    $$('input, select, textarea', root).forEach(function (el) {
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', function () {
        onChange(el);
        state.admin.settingsDirty = true;
        var d = $('.save-bar .small');
        if (d) d.innerHTML = '<span class="dirty-dot"></span>저장하지 않은 변경사항';
      });
    });
  }

  function toggleHtml(id, checked, label) {
    return '<label class="toggle"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span class="track"></span>' + esc(label) + '</label>';
  }

  function adminBasic() {
    var s = state.admin.settings;
    var body = $('#adminBody');
    body.innerHTML =
      '<div class="card">' +
      '<div class="eyebrow">Settings · 기본 설정</div><h2 style="margin-bottom:22px">계산 규칙</h2>' +

      '<div class="group"><div class="group-head"><h3>하행 할증</h3>' + toggleHtml('dhOn', s.downhill.enabled, '사용') + '</div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>적용 시작 거리 (km 이상)</label><input class="input num" type="number" min="0" id="dhKm" value="' + esc(s.downhill.minKm) + '"></div>' +
      '<div class="field"><label>할증 비율 (%)</label><input class="input num" type="number" min="0" step="0.1" id="dhPct" value="' + esc(s.downhill.percent) + '"><span class="hint">하차지가 상차지보다 남쪽일 때 타리프 × 비율</span></div>' +
      '</div></div>' +

      '<div class="group"><div class="group-head"><h3>밀크런 (유류비 · 통행료)</h3></div>' +
      '<p class="hint" style="margin:-6px 0 14px">톤수별 견적에는 들어가지 않고, 기준 톤수 하나로 경로별 유류비·통행료를 따로 계산합니다. 직원이 계산 화면에서 기준 톤수를 바꿀 수 있습니다.</p>' +
      '<div class="form-grid">' +
      '<div class="field"><label>기본 기준 톤수</label><select class="input" id="mrTon">' + s.tons.map(function (t) {
        return '<option' + (t.name === s.milkrun.baseTon ? ' selected' : '') + '>' + esc(t.name) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>편도 / 왕복</label><select class="input" id="mrTrip"><option value="0"' + (s.milkrun.roundTrip ? '' : ' selected') + '>편도 (×1)</option><option value="1"' + (s.milkrun.roundTrip ? ' selected' : '') + '>왕복 (×2)</option></select><span class="hint">유류비·통행료 모두에 적용</span></div>' +
      '<div class="field"><label>경유가 기본 방식</label><select class="input" id="fuelMode"><option value="manual"' + (s.fuel.mode === 'manual' ? ' selected' : '') + '>직접 입력값 사용</option><option value="auto"' + (s.fuel.mode === 'auto' ? ' selected' : '') + '>오피넷 자동 조회</option></select><span class="hint">자동 조회는 API 키 탭에서 오피넷 키가 필요해요</span></div>' +
      '<div class="field"><label>기본 경유가 (원/L)</label><input class="input num" type="number" min="0" id="fuelPrice" value="' + esc(s.fuel.manualPrice) + '"></div>' +
      '</div></div>' +

      '<div class="group"><div class="group-head"><h3>톤수별 연비 · 통행료 차종</h3></div>' +
      '<p class="hint" style="margin:-6px 0 12px">밀크런 기준 톤수로 쓰일 때 적용됩니다. 통행료는 이 차종으로 카카오에서 조회합니다.</p>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>톤수</th><th>통행료 차종</th><th>연비 (km/L)</th></tr></thead><tbody>' +
      s.tons.map(function (t, i) {
        return '<tr><td class="ton">' + esc(t.name) + '</td>' +
          '<td><select class="input input-sm" data-tc="' + i + '" style="width:110px;margin-left:auto">' + [1, 2, 3, 4, 5].map(function (k) {
            return '<option value="' + k + '"' + (Number(t.tollClass) === k ? ' selected' : '') + '>' + k + '종</option>';
          }).join('') + '</select></td>' +
          '<td><input class="input input-sm num" type="number" min="0" step="0.1" data-kpl="' + i + '" value="' + esc(t.kmPerL) + '" style="width:110px;margin-left:auto;text-align:right"></td></tr>';
      }).join('') + '</tbody></table></div></div>' +

      '<div class="group"><div class="group-head"><h3>거리 · 금액 처리</h3></div><div class="form-grid">' +
      '<div class="field"><label>조회 상세 보관 기간 (일)</label><input class="input num" type="number" min="7" max="3650" id="retDays" value="' + esc(s.snapshot.retentionDays) + '"><span class="hint">지나면 조회기록의 상세 내용만 삭제 (견적모음은 유지)</span></div>' +
      '<div class="field"><label>대량 계산 최대 건수</label><input class="input num" type="number" min="1" max="3000" id="maxRows" value="' + esc(s.batch.maxRows) + '"></div>' +
      '<div class="field"><label>타리프 최대 거리 (km)</label><input class="input num" type="number" min="1" id="maxKm" value="' + esc(s.maxKm) + '"><span class="hint">초과 시 "별도 문의"</span></div>' +
      '<div class="field"><label>거리 소수점 처리</label><select class="input" id="kmRound">' +
      [['ceil', '올림'], ['round', '반올림'], ['floor', '내림']].map(function (o) { return '<option value="' + o[0] + '"' + (s.kmRounding === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>합계 금액 단위</label><select class="input" id="prUnit">' +
      [1, 10, 100, 1000, 10000].map(function (u) { return '<option value="' + u + '"' + (Number(s.priceRounding.unit) === u ? ' selected' : '') + '>' + won(u) + '원</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>금액 처리</label><select class="input" id="prMode">' +
      [['round', '반올림'], ['ceil', '올림'], ['floor', '내림']].map(function (o) { return '<option value="' + o[0] + '"' + (s.priceRounding.mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label>회신 문구 하단 안내</label><input class="input" id="footer" value="' + esc(s.quoteFooter) + '"></div></div>' +

      saveBar(state.admin.settingsDirty) + '</div>';

    bindDirty(body, function (el) {
      var v = el.type === 'checkbox' ? el.checked : el.value;
      switch (el.id) {
        case 'dhOn': s.downhill.enabled = v; break;
        case 'dhKm': s.downhill.minKm = Number(v); break;
        case 'dhPct': s.downhill.percent = Number(v); break;
        case 'mrTon': s.milkrun.baseTon = v; break;
        case 'mrTrip': s.milkrun.roundTrip = v === '1'; break;
        case 'fuelMode': s.fuel.mode = v; break;
        case 'fuelPrice': s.fuel.manualPrice = Number(v); break;
        case 'retDays': s.snapshot.retentionDays = Math.min(3650, Math.max(7, Number(v) || 90)); break;
        case 'maxRows': s.batch.maxRows = Math.min(3000, Math.max(1, Number(v) || 1000)); break;
        case 'maxKm': s.maxKm = Number(v); break;
        case 'kmRound': s.kmRounding = v; break;
        case 'prUnit': s.priceRounding.unit = Number(v); break;
        case 'prMode': s.priceRounding.mode = v; break;
        case 'footer': s.quoteFooter = v; break;
      }
      if (el.dataset.tc) s.tons[el.dataset.tc].tollClass = Number(v);
      if (el.dataset.kpl) s.tons[el.dataset.kpl].kmPerL = Number(v);
    });
    $('#saveBtn').onclick = function () { saveSettings(this); };
  }

  function adminRegion() {
    var s = state.admin.settings;
    var body = $('#adminBody');
    body.innerHTML =
      '<div class="card">' +
      '<div class="eyebrow">Region · 지역 할증</div><h2>지역 할증 규칙</h2>' +
      '<p class="muted small" style="margin:6px 0 20px">상차지와 하차지를 각각 검사해서 <b>해당하는 할증을 모두 더합니다.</b> (예: 서울→강원 = 1만 + 2만)<br>' +
      '<b>시·도</b> 기준은 "서울", "강원"처럼 시·도 이름에서 찾고, <b>전체 주소</b> 기준은 "울릉군", "신안군 흑산면"처럼 주소 전체에서 찾습니다. 키워드는 쉼표(,)로 구분하세요.</p>' +
      '<div class="rule-head"><span>이름</span><span>금액 (원)</span><span>검사 대상</span><span>키워드</span><span></span></div>' +
      '<div id="rules">' + s.regionRules.map(ruleRow).join('') + '</div>' +
      '<button class="btn" id="addRule">+ 규칙 추가</button>' +
      saveBar(state.admin.settingsDirty) + '</div>';

    function ruleRow(rule, i) {
      return '<div class="rule" data-i="' + i + '">' +
        '<input class="input input-sm" data-f="name" value="' + esc(rule.name) + '" placeholder="이름" aria-label="이름">' +
        '<input class="input input-sm num" type="number" min="0" step="1000" data-f="amount" value="' + esc(rule.amount) + '" aria-label="금액">' +
        '<select class="input input-sm" data-f="target" aria-label="검사 대상"><option value="sido"' + (rule.target === 'sido' ? ' selected' : '') + '>시·도</option><option value="address"' + (rule.target === 'address' ? ' selected' : '') + '>전체 주소</option></select>' +
        '<input class="input input-sm kw" data-f="keywords" value="' + esc((rule.keywords || []).join(', ')) + '" placeholder="예) 울릉군, 신안군, 옹진군" aria-label="키워드">' +
        '<button class="btn btn-ghost btn-sm btn-danger" data-del="' + i + '" title="삭제" aria-label="삭제">✕</button></div>';
    }
    bindDirty(body, function (el) {
      var row = el.closest('.rule'); if (!row) return;
      var rule = s.regionRules[Number(row.dataset.i)];
      var f = el.dataset.f;
      if (f === 'amount') rule.amount = Number(el.value);
      else if (f === 'keywords') rule.keywords = el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      else rule[f] = el.value;
    });
    $$('[data-del]', body).forEach(function (b) {
      b.onclick = function () {
        var rule = s.regionRules[Number(b.dataset.del)];
        if (!confirm('"' + rule.name + '" 규칙을 삭제할까요?')) return;
        s.regionRules.splice(Number(b.dataset.del), 1);
        state.admin.settingsDirty = true; adminRegion();
      };
    });
    $('#addRule').onclick = function () {
      s.regionRules.push({ name: '새 규칙', amount: 10000, target: 'address', keywords: [] });
      state.admin.settingsDirty = true; adminRegion();
    };
    $('#saveBtn').onclick = function () { saveSettings(this); };
  }

  var PAGE = 50;
  function adminTariff() {
    var a = state.admin, t = a.tariff, tons = t.tons;
    var pages = Math.ceil(t.rows.length / PAGE);
    if (a.page >= pages) a.page = 0;
    var from = a.page * PAGE;
    var body = $('#adminBody');
    body.innerHTML =
      '<div class="card">' +
      '<div class="row-between" style="flex-wrap:wrap;margin-bottom:16px"><div><div class="eyebrow">Tariff · 타리프</div><h2>km × 톤수 단가표</h2>' +
      '<p class="muted small" style="margin:6px 0 0">1~' + t.rows.length + 'km · ' + tons.length + '개 톤수 · 칸을 눌러 바로 수정하거나 엑셀에서 통째로 붙여넣으세요.</p></div>' +
      '<div class="actions"><button class="btn btn-sm" id="pasteBtn">엑셀 붙여넣기</button><button class="btn btn-sm" id="csvBtn">CSV 내려받기</button>' +
      (a.tariffDirty ? '<button class="btn btn-sm btn-danger" id="revertBtn">변경 취소</button>' : '') + '</div></div>' +
      '<div class="row-between" style="margin-bottom:10px;flex-wrap:wrap"><div class="pager">' +
      Array.apply(null, { length: pages }).map(function (_, p) {
        return '<button data-p="' + p + '" class="' + (p === a.page ? 'on' : '') + '">' + (p * PAGE + 1) + '–' + Math.min(t.rows.length, (p + 1) * PAGE) + '</button>';
      }).join('') + '</div>' +
      '<div style="display:flex;gap:6px;align-items:center"><input class="input input-sm num" id="jumpKm" type="number" min="1" max="' + t.rows.length + '" placeholder="km 찾기" style="width:110px"></div></div>' +
      '<div class="tariff-table"><table><thead><tr><th>km</th>' + tons.map(function (n) { return '<th>' + esc(n) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      t.rows.slice(from, from + PAGE).map(function (row, i) {
        var km = from + i + 1;
        return '<tr data-km="' + km + '"><td>' + km + '</td>' + row.map(function (v, j) {
          var changed = a.tariffOrig && a.tariffOrig.rows[km - 1] && a.tariffOrig.rows[km - 1][j] !== v;
          return '<td><input inputmode="numeric" data-r="' + (km - 1) + '" data-c="' + j + '" value="' + esc(won(v)) + '" class="' + (changed ? 'changed' : '') + '" aria-label="' + km + 'km ' + esc(tons[j]) + '"></td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      saveBar(a.tariffDirty, '타리프 저장') + '</div>';

    $$('.pager button', body).forEach(function (b) { b.onclick = function () { a.page = Number(b.dataset.p); adminTariff(); }; });
    $('#jumpKm').onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      var km = Number(this.value);
      if (!(km >= 1 && km <= t.rows.length)) return;
      a.page = Math.floor((km - 1) / PAGE); adminTariff();
      var row = $('tr[data-km="' + km + '"]');
      if (row) { row.scrollIntoView({ block: 'center' }); var inp = $('input', row); if (inp) inp.focus(); }
    };
    $$('.tariff-table input', body).forEach(function (inp) {
      inp.onfocus = function () { this.value = String(t.rows[this.dataset.r][this.dataset.c]); this.select(); };
      inp.onblur = function () { this.value = won(t.rows[this.dataset.r][this.dataset.c]); };
      inp.oninput = function () {
        var v = Number(String(this.value).replace(/[^0-9.]/g, '')) || 0;
        t.rows[this.dataset.r][this.dataset.c] = v;
        var orig = a.tariffOrig.rows[this.dataset.r][this.dataset.c];
        this.classList.toggle('changed', orig !== v);
        if (!a.tariffDirty) { a.tariffDirty = true; $('.save-bar .small').innerHTML = '<span class="dirty-dot"></span>저장하지 않은 변경사항'; }
      };
      inp.onkeydown = function (e) {
        if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        var r = Number(this.dataset.r) + (e.key === 'ArrowUp' ? -1 : 1);
        var next = $('.tariff-table input[data-r="' + r + '"][data-c="' + this.dataset.c + '"]');
        if (next) next.focus();
      };
    });
    $('#csvBtn').onclick = function () {
      downloadCsv('조일ver1_타리프_' + today() + '.csv', [['km'].concat(tons)].concat(t.rows.map(function (r, i) { return [i + 1].concat(r); })));
    };
    var rv = $('#revertBtn');
    if (rv) rv.onclick = function () {
      if (!confirm('저장하지 않은 타리프 변경을 모두 취소할까요?')) return;
      a.tariff = clone(a.tariffOrig); a.tariffDirty = false; adminTariff();
    };
    $('#pasteBtn').onclick = openTariffPaste;
    $('#saveBtn').onclick = function () {
      var btn = this;
      busy(btn, true, '저장 중…');
      api('admin.saveTariff', { tariff: t }).then(function () {
        a.tariffOrig = clone(t); a.tariffDirty = false;
        state.calc.result = null;
        toast('타리프를 저장했습니다.');
        adminTariff();
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
  }

  function openTariffPaste() {
    var a = state.admin, t = a.tariff, n = t.tons.length;
    modal({
      wide: true, eyebrow: '타리프', title: '엑셀에서 붙여넣기',
      body:
        '<p class="muted small" style="margin:0 0 12px">엑셀에서 단가 영역을 복사(Ctrl+C)해서 아래에 붙여넣으세요.<br>' +
        '· 한 줄 = 1km, 칸 순서 = <b>' + t.tons.map(esc).join(' · ') + '</b><br>' +
        '· 맨 앞에 km 열이 있으면(' + (n + 1) + '칸) 그 km 줄에 넣고, 없으면(' + n + '칸) 아래 시작 km부터 차례로 넣습니다.<br>' +
        '· 제목 줄처럼 숫자가 아닌 줄은 건너뜁니다.</p>' +
        '<div class="field" style="max-width:200px"><label>시작 km</label><input class="input input-sm num" id="pasteStart" type="number" min="1" value="1"></div>' +
        '<textarea class="input" id="pasteArea" placeholder="여기에 붙여넣기"></textarea>' +
        '<p class="hint" id="pastePreview" style="margin:8px 0 0"></p>',
      foot: '<button class="btn" data-close>취소</button><button class="btn btn-primary" id="pasteApply">적용</button>',
      onMount: function (m, close) {
        function parse() {
          var start = Math.max(1, Number($('#pasteStart', m).value) || 1);
          var out = [], skipped = 0, bad = 0;
          var seq = start;
          $('#pasteArea', m).value.split(/\r?\n/).forEach(function (line) {
            if (!line.trim()) return;
            var cells = line.indexOf('\t') !== -1 ? line.split('\t') : line.split(',');
            var nums = cells.map(function (c) { var s = String(c).replace(/[^0-9.\-]/g, ''); return s === '' ? NaN : Number(s); });
            if (nums.every(function (x) { return isNaN(x); })) { skipped++; return; }
            var km, vals;
            if (nums.length === n + 1) { km = nums[0]; vals = nums.slice(1); }
            else if (nums.length === n) { km = seq++; vals = nums; }
            else { bad++; return; }
            if (!(km >= 1 && km <= t.rows.length) || vals.some(function (x) { return isNaN(x) || x < 0; })) { bad++; return; }
            out.push({ km: km, vals: vals });
          });
          return { rows: out, skipped: skipped, bad: bad };
        }
        function preview() {
          var p = parse();
          $('#pastePreview', m).innerHTML = p.rows.length
            ? '<b>' + p.rows.length + '줄</b> 적용 예정 (' + p.rows[0].km + 'km ~ ' + p.rows[p.rows.length - 1].km + 'km)' + (p.skipped ? ' · 제목 줄 ' + p.skipped + '개 건너뜀' : '') + (p.bad ? ' · <span style="color:var(--red)">형식 오류 ' + p.bad + '줄 제외</span>' : '')
            : (p.bad ? '<span style="color:var(--red)">칸 수가 ' + n + '개 또는 ' + (n + 1) + '개인 줄이 없습니다.</span>' : '');
        }
        $('#pasteArea', m).oninput = preview;
        $('#pasteStart', m).oninput = preview;
        $('#pasteApply', m).onclick = function () {
          var p = parse();
          if (!p.rows.length) return toast('적용할 줄이 없습니다.', 'err');
          p.rows.forEach(function (r) { t.rows[r.km - 1] = r.vals; });
          a.tariffDirty = true;
          close(); adminTariff();
          toast(p.rows.length + '줄을 반영했습니다. "타리프 저장"을 눌러야 확정됩니다.');
        };
      }
    });
  }

  function refreshUsers() {
    return api('admin.listUsers').then(function (r) {
      state.admin.users = r.users;
      if (state.view === 'admin' && state.admin.tab === 'users') adminUsers();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function adminUsers() {
    var a = state.admin;
    var body = $('#adminBody');
    body.innerHTML =
      '<div class="card" style="margin-bottom:16px"><div class="eyebrow">Accounts · 계정</div><h2 style="margin-bottom:16px">새 계정 발급</h2>' +
      '<form id="newUser" class="form-grid" style="align-items:end">' +
      '<div class="field"><label>아이디 (영문·숫자)</label><input class="input" id="nuId" required pattern="[A-Za-z0-9_.\\-]{3,30}"></div>' +
      '<div class="field"><label>이름</label><input class="input" id="nuName" required></div>' +
      '<div class="field"><label>메뉴 권한</label><div class="chips" id="nuPerms">' +
      '<button type="button" class="chip on" data-p="quote">견적</button><button type="button" class="chip" data-p="analysis">분석</button><button type="button" class="chip" data-p="admin">관리자</button></div></div>' +
      '<div class="field"><button class="btn btn-primary" type="submit" style="width:100%;padding:12px">발급하기</button></div>' +
      '</form><p class="hint" style="margin:0">임시 비밀번호가 한 번만 표시됩니다. 직원은 첫 로그인 때 비밀번호를 바꿉니다.<br>' +
      '<b>견적</b> = 단건·대량 계산, 조회기록, 견적모음 · <b>분석</b> = 매출매입 분석 · <b>관리자</b> = 모든 메뉴와 설정</p></div>' +
      '<div class="card" style="--i:1"><h3 style="margin-bottom:12px">계정 목록 <span class="muted small">' + a.users.length + '명</span></h3>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>아이디</th><th style="text-align:left">이름</th><th style="text-align:left">메뉴 권한</th><th style="text-align:left">상태</th><th>마지막 로그인</th><th></th></tr></thead><tbody>' +
      a.users.map(function (u, i) {
        var self = u.id === state.user.id;
        return '<tr style="--i:' + i + '"><td class="ton">' + esc(u.id) + '</td><td style="text-align:left">' + esc(u.name) + '</td>' +
          '<td style="text-align:left">' + (u.role === 'admin'
            ? '<span class="role-badge">ADMIN</span>' + (self ? '' : ' <button class="btn btn-ghost btn-sm" data-demote="' + esc(u.id) + '">관리자 해제</button>')
            : '<div class="chips perm-chips">' + [['quote', '견적'], ['analysis', '분석']].map(function (p) {
              var on = (u.perms || []).indexOf(p[0]) !== -1;
              return '<button type="button" class="chip ' + (on ? 'on' : '') + '" data-uid="' + esc(u.id) + '" data-perm="' + p[0] + '">' + p[1] + '</button>';
            }).join('') + '<button type="button" class="chip ghost" data-promote="' + esc(u.id) + '">관리자로</button></div>') + '</td>' +
          '<td style="text-align:left"><span class="status-pill ' + (u.active ? 'ok' : 'no') + '">' + (u.active ? '사용' : '중지') + '</span>' + (u.mustChange ? ' <span class="badge off">비번 변경 대기</span>' : '') + '</td>' +
          '<td class="small muted">' + esc(u.lastLogin || '–') + '</td>' +
          '<td><div class="actions" style="justify-content:flex-end">' +
          (self ? '<span class="small muted">본인</span>' :
            '<button class="btn btn-sm" data-reset="' + esc(u.id) + '">비번 초기화</button>' +
            '<button class="btn btn-sm ' + (u.active ? 'btn-danger' : '') + '" data-toggle="' + esc(u.id) + '" data-active="' + (u.active ? 1 : 0) + '">' + (u.active ? '사용 중지' : '다시 사용') + '</button>') +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div></div>';

    function showTemp(title, id, pw) {
      modal({
        eyebrow: '임시 비밀번호', title: title,
        body: '<p class="muted small" style="margin:0 0 12px">아이디 <b>' + esc(id) + '</b> 의 임시 비밀번호입니다. <b>이 창을 닫으면 다시 볼 수 없어요.</b> 직원에게 직접 전달하세요.</p>' +
          '<div class="temp-pw">' + esc(pw) + '</div>',
        foot: '<button class="btn" id="copyPw">복사</button><button class="btn btn-primary" data-close>확인</button>',
        onMount: function (m) { $('#copyPw', m).onclick = function () { copyText('아이디: ' + id + '\n임시 비밀번호: ' + pw).then(function () { toast('복사했습니다.'); }); }; }
      });
    }
    $$('#nuPerms .chip').forEach(function (c) { c.onclick = function () { c.classList.toggle('on'); }; });
    $('#newUser').onsubmit = function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('button[type=submit]');
      var id = $('#nuId').value.trim();
      var picked = $$('#nuPerms .chip.on').map(function (c) { return c.dataset.p; });
      if (!picked.length) return toast('메뉴 권한을 하나 이상 고르세요.', 'err');
      var role = picked.indexOf('admin') !== -1 ? 'admin' : 'user';
      busy(btn, true, '발급 중…');
      api('admin.createUser', { id: id, name: $('#nuName').value, role: role, perms: picked.filter(function (p) { return p !== 'admin'; }) }).then(function (r) {
        refreshUsers();
        showTemp('계정을 발급했습니다', id, r.tempPassword);
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    $$('[data-reset]', body).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.reset;
        if (!confirm(id + ' 계정의 비밀번호를 초기화할까요?')) return;
        busy(b, true, '…');
        api('admin.resetPassword', { id: id }).then(function (r) {
          refreshUsers(); showTemp('비밀번호를 초기화했습니다', id, r.tempPassword);
        }).catch(function (err) { busy(b, false); toast(err.message, 'err'); });
      };
    });
    $$('[data-perm]', body).forEach(function (b) {
      b.onclick = function () {
        var u = a.users.filter(function (x) { return x.id === b.dataset.uid; })[0];
        var perms = (u.perms || []).slice(), i = perms.indexOf(b.dataset.perm);
        if (i === -1) perms.push(b.dataset.perm); else perms.splice(i, 1);
        b.disabled = true;
        api('admin.updateUser', { id: u.id, patch: { perms: perms } }).then(function () {
          u.perms = perms; toast(u.name + ' 권한을 바꿨습니다.'); adminUsers();
        }).catch(function (err) { b.disabled = false; toast(err.message, 'err'); });
      };
    });
    $$('[data-promote], [data-demote]', body).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.promote || b.dataset.demote, up = !!b.dataset.promote;
        if (!confirm(up ? id + ' 계정을 관리자로 바꿀까요? 모든 메뉴와 설정에 접근할 수 있게 됩니다.' : id + ' 계정의 관리자 권한을 해제할까요? (견적 메뉴만 남습니다)')) return;
        busy(b, true, '…');
        api('admin.updateUser', { id: id, patch: up ? { role: 'admin' } : { role: 'user', perms: ['quote'] } }).then(function () {
          toast('권한을 바꿨습니다.'); refreshUsers();
        }).catch(function (err) { busy(b, false); toast(err.message, 'err'); });
      };
    });
    $$('[data-toggle]', body).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.toggle, active = b.dataset.active === '1';
        if (active && !confirm(id + ' 계정을 사용 중지할까요? 즉시 로그아웃되고 계산할 수 없습니다.')) return;
        busy(b, true, '…');
        api('admin.updateUser', { id: id, patch: { active: !active } }).then(function () {
          toast(active ? '사용을 중지했습니다.' : '다시 사용하도록 했습니다.');
          refreshUsers();
        }).catch(function (err) { busy(b, false); toast(err.message, 'err'); });
      };
    });
  }

  function adminKeys() {
    var k = state.admin.keys || {};
    $('#adminBody').innerHTML =
      '<div class="card"><div class="eyebrow">Keys · API 키</div><h2>외부 서비스 연결</h2>' +
      '<p class="muted small" style="margin:6px 0 22px">키는 서버(Apps Script)에만 저장되고 <b>화면에는 다시 표시되지 않습니다.</b> 바꿀 때만 새로 입력하세요.</p>' +
      '<div class="group"><div class="group-head"><h3>카카오 REST API 키</h3><span class="status-pill ' + (k.kakao ? 'ok' : 'no') + '">' + (k.kakao ? '설정됨' : '미설정') + '</span></div>' +
      '<div class="field"><input class="input" id="kakaoKey" type="password" autocomplete="off" placeholder="' + (k.kakao ? '변경할 때만 입력' : 'REST API 키 붙여넣기') + '">' +
      '<span class="hint">주소 검색(로컬)과 길찾기(카카오모빌리티)에 사용합니다.</span></div>' +
      '<button class="btn btn-sm" id="testKakao"' + (k.kakao ? '' : ' disabled') + '>연결 테스트</button></div>' +
      '<div class="group"><div class="group-head"><h3>오피넷 API 키 (선택)</h3><span class="status-pill ' + (k.opinet ? 'ok' : 'no') + '">' + (k.opinet ? '설정됨' : '미설정') + '</span></div>' +
      '<div class="field"><input class="input" id="opinetKey" type="password" autocomplete="off" placeholder="' + (k.opinet ? '변경할 때만 입력' : '오피넷 무료 API 키') + '">' +
      '<span class="hint">경유가 자동 조회용입니다. 기본 설정 → 유류비에서 "오피넷 자동 조회"를 켜야 사용됩니다.</span></div></div>' +
      '<div class="group"><div class="group-head"><h3>주소 · 경로 저장소 (캐시)</h3><span class="small muted" id="cacheInfo">확인 중…</span></div>' +
      '<p class="hint" style="margin:-6px 0 12px">한 번 조회한 주소와 경로를 서버 시트에 저장해 두고 다시 씁니다. 도로·통행료가 바뀌었다고 생각되면 비우세요. (다음 조회 때 카카오에서 새로 받아옵니다)</p>' +
      '<button class="btn btn-sm btn-danger" id="clearCache">캐시 비우기</button></div>' +
      '<div class="save-bar"><span class="small muted" style="margin-right:auto">입력한 키만 저장됩니다</span><button class="btn btn-accent" id="saveBtn">키 저장</button></div></div>';
    $('#saveBtn').onclick = function () {
      var kakao = $('#kakaoKey').value.trim(), opinet = $('#opinetKey').value.trim();
      if (!kakao && !opinet) return toast('저장할 키를 입력하세요.', 'err');
      var btn = this; busy(btn, true, '저장 중…');
      api('admin.saveKeys', { kakao: kakao, opinet: opinet }).then(function (r) {
        state.admin.keys = r.keys; toast('키를 저장했습니다.'); adminKeys();
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    function showCache(c) { var el = $('#cacheInfo'); if (el) el.textContent = '주소 ' + won(c.addresses) + '개 · 경로 ' + won(c.routes) + '개 저장됨'; }
    if (state.admin.cache) showCache(state.admin.cache);
    $('#clearCache').onclick = function () {
      if (!confirm('저장된 주소·경로를 모두 지울까요? 다음 조회부터 카카오 호출이 다시 늘어납니다.')) return;
      var btn = this; busy(btn, true, '비우는 중…');
      api('admin.clearCache').then(function (r) { state.admin.cache = r.cache; showCache(r.cache); toast('캐시를 비웠습니다.'); })
        .catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
    $('#testKakao').onclick = function () {
      var btn = this; busy(btn, true, '확인 중…');
      api('admin.testKakao').then(function (r) { toast(r.message); }).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  /* ───────── 시작 ───────── */

  state.an = newAnState();

  window.addEventListener('beforeunload', function (e) {
    if (state.admin.tariffDirty || state.admin.settingsDirty || state.bulk.running) { e.preventDefault(); e.returnValue = ''; }
  });

  if (state.token) {
    app.innerHTML = '<div class="login-wrap"><div class="muted">불러오는 중…</div></div>';
    api('me').then(function (r) { state.user = r.user; return afterLogin(r.settings); })
      .catch(function (err) {
        // 네트워크 문제일 때는 로그인 정보를 지우지 않고 다시 시도할 수 있게
        if (/만료|필요|중지/.test(err.message)) { clearSession(); render(); return; }
        app.innerHTML = '<div class="login-wrap"><div class="card" style="max-width:420px;text-align:center"><p style="margin:0 0 14px">' + esc(err.message) + '</p><button class="btn btn-primary" onclick="location.reload()">다시 시도</button></div></div>';
      });
  } else {
    render();
  }
})();
