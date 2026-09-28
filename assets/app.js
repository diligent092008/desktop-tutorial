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
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function api(action, payload) {
    var req = Object.assign({ action: action, token: state.token }, payload || {});
    var p = DEMO
      ? window.JoilDemo.call(req)
      : fetch(API_URL, { method: 'POST', body: JSON.stringify(req) })
        .then(function (res) {
          if (!res.ok) throw new Error('서버 연결 오류 (' + res.status + ')');
          return res.json();
        })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || '알 수 없는 오류');
          return data;
        });
    return p.catch(function (err) {
      var msg = (err && err.message) || String(err);
      if (/Failed to fetch|NetworkError/.test(msg)) msg = '서버에 연결할 수 없습니다. 인터넷 또는 서버 주소를 확인하세요.';
      if (/알 수 없는 요청/.test(msg)) msg = '서버 코드가 예전 버전입니다. 관리자가 Apps Script 코드를 최신으로 바꾸고 새 버전으로 배포해야 합니다. (SETUP.md "업데이트가 나왔을 때")';
      if (/로그인이 만료|로그인이 필요|사용이 중지/.test(msg) && action !== 'login') {
        clearSession();
        toast(msg, 'err');
        render();
      }
      throw new Error(msg);
    });
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
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /* ───────── 세션 ───────── */

  function clearSession() {
    state.token = null; state.user = null; state.pub = null;
    state.admin = { tab: 'basic', settings: null, keys: null, tariff: null, tariffDirty: false, settingsDirty: false, page: 0, users: null, logs: null };
    state.calc.result = null;
    state.calc.baseTon = null;
    state.bulk.results = []; state.bulk.meta = null; state.bulk.cancel = true;
    storage('del', 'joil-token');
  }

  function afterLogin() {
    return api('publicSettings').then(function (r) {
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

  function render() {
    if (!state.user) return renderLogin();
    if (!state.pub) { app.innerHTML = '<div class="login-wrap"><div class="muted">불러오는 중…</div></div>'; return; }
    app.innerHTML =
      '<header class="topbar"><div class="stripe-bar"></div><div class="row">' +
      '<div class="brand"><span class="logo"></span>조일ver1</div>' +
      '<nav class="nav">' +
      '<button data-view="calc" class="' + (state.view === 'calc' ? 'on' : '') + '">단건 계산</button>' +
      '<button data-view="bulk" class="' + (state.view === 'bulk' ? 'on' : '') + '">대량 계산</button>' +
      (state.user.role === 'admin' ? '<button data-view="admin" class="' + (state.view === 'admin' ? 'on' : '') + '">관리자</button>' : '') +
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
        if (state.view === 'admin' && b.dataset.view !== 'admin' && (state.admin.tariffDirty || state.admin.settingsDirty) &&
          !confirm('저장하지 않은 관리자 변경사항이 있습니다. 이동할까요? (변경사항은 화면에 남아 있습니다)')) return;
        state.view = b.dataset.view; render();
      };
    });
    $('[data-act="logout"]').onclick = function () {
      api('logout').catch(function () { });
      clearSession(); render();
    };
    $('[data-act="pw"]').onclick = function () { openChangePassword(false); };

    if (state.view === 'admin' && state.user.role === 'admin') renderAdmin();
    else if (state.view === 'bulk') renderBulk();
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
        state.view = 'calc';
        return afterLogin();
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
            state.user.mustChange = false;
            close(); toast('비밀번호를 변경했습니다.');
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
      X.writeFile(wb, filename);
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
          c.result = r.result; renderResult(true);
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
    var r = state.calc.result;
    var sel = state.calc.tons;
    var rows = r.rows.filter(function (row) { return sel.indexOf(row.ton) !== -1; });
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
        '<div class="actions"><button class="btn btn-sm" id="copyQuote">회신 문구 복사</button><button class="btn btn-sm" id="xlsxQuote">엑셀 저장</button></div></div>' +
        (rows.length ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>톤수</th><th>타리프</th><th>지역할증</th><th>하행할증</th><th>합계</th>' +
          '</tr></thead><tbody>' + rows.map(function (row, i) {
            return '<tr style="--i:' + i + '"><td class="ton">' + esc(row.ton) + '</td>' +
              '<td class="num">' + won(row.tariff) + '</td>' +
              '<td class="num">' + won(row.region) + '</td>' +
              '<td class="num">' + won(row.downhill) + '</td>' +
              '<td class="total"><span class="num" data-total="' + row.total + '">' + won(row.total) + '</span></td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted" style="margin:0">선택된 톤수가 없습니다. 왼쪽에서 톤수를 골라 주세요.</p>') +
        '<p class="hint" style="margin:14px 0 0">합계 = 타리프 + 지역할증 + 하행할증 (금액 단위 반올림 적용) · 유류비·통행료는 아래 밀크런에 따로 표시</p>' +
        '</div>';
    }
    html += '<div style="margin-top:16px">' + milkrunCard(r, 2) + '</div>';

    var box = $('#result');
    box.innerHTML = html;
    if (!animate) $$('.card, tr', box).forEach(function (el) { el.style.animation = 'none'; });
    else $$('[data-total]', box).forEach(function (el) { countUp(el, Number(el.dataset.total)); });

    var copyBtn = $('#copyQuote'), xBtn = $('#xlsxQuote');
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
      downloadXlsx('조일ver1_견적_' + today() + '.xlsx', [
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
        pairs: chunk.map(function (r) { return { origin: r.origin, dest: r.dest }; }),
        batch: { index: isNew ? idx : -1, total: chunks.length, count: total }
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

  function bulkView() {
    var b = state.bulk;
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
    var b = state.bulk;
    var box = $('#bulkResult');
    if (!box) return;
    var all = b.results;
    var okRows = all.filter(function (r) { return r.status === 'ok'; });
    var fail = all.length - okRows.length;
    var avg = okRows.length ? Math.round(okRows.reduce(function (s, r) { return s + r.result.distanceKm; }, 0) / okRows.length) : 0;
    var tons = state.calc.tons;
    var detail = b.detail !== false;
    var list = bulkView();
    var pages = Math.max(1, Math.ceil(list.length / BULK_PAGE));
    if (b.page >= pages) b.page = 0;
    var pageRows = list.slice(b.page * BULK_PAGE, (b.page + 1) * BULK_PAGE);
    var meta = b.meta || {};
    var mrTon = meta.baseTon || state.calc.baseTon;
    var perTon = detail ? 3 : 1;

    var head1 = '<tr><th class="sticky c0" rowspan="2">#</th><th class="sticky c1" rowspan="2">하차지</th><th rowspan="2" class="left">상차지</th>' +
      '<th rowspan="2">거리</th><th rowspan="2" class="left">방향</th><th rowspan="2" class="left">지역할증</th>' +
      '<th colspan="3" class="grp mr">밀크런 · ' + esc(mrTon) + ' ' + (state.pub.roundTrip ? '왕복' : '편도') + '</th>' +
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
      '<div class="actions">' + (fail && !b.running ? '<button class="btn btn-sm btn-danger" id="bRetry">실패 ' + won(fail) + '건 다시 계산</button>' : '') +
      '<button class="btn btn-sm btn-primary" id="bXlsx"' + (okRows.length ? '' : ' disabled') + '>엑셀 다운로드</button></div></div>' +
      '<div class="toolbar">' +
      '<input class="input input-sm" id="bSearch" placeholder="주소 검색" value="' + esc(b.search || '') + '" style="max-width:240px">' +
      '<select class="input input-sm" id="bSort" style="width:auto"><option value="no">입력 순서</option><option value="kmAsc">거리 가까운 순</option><option value="kmDesc">거리 먼 순</option><option value="mrDesc">밀크런 금액 큰 순</option></select>' +
      '<div class="segmented" id="bFilter"><button type="button" data-f="all" class="' + (b.filter !== 'fail' ? 'on' : '') + '">전체</button><button type="button" data-f="fail" class="' + (b.filter === 'fail' ? 'on' : '') + '">실패만</button></div>' +
      '<label class="toggle" style="margin-left:auto"><input type="checkbox" id="bDetail"' + (detail ? ' checked' : '') + '><span class="track"></span>톤수별 상세</label>' +
      '</div>' +
      (tons.length ? '' : '<p class="hint" style="margin:0 0 10px">표시할 톤수를 위에서 골라 주세요.</p>') +
      '<div class="bulk-table"><table class="data bulk"><thead>' + head1 + head2 + '</thead><tbody>' + (body || '<tr><td colspan="' + colCount + '" class="left muted" style="padding:24px">조건에 맞는 결과가 없습니다.</td></tr>') + '</tbody></table></div>' +
      (pages > 1 ? '<div class="pager" style="margin-top:12px">' + Array.apply(null, { length: pages }).map(function (_, p) {
        return '<button data-p="' + p + '" class="' + (p === b.page ? 'on' : '') + '">' + (p * BULK_PAGE + 1) + '–' + Math.min(list.length, (p + 1) * BULK_PAGE) + '</button>';
      }).join('') + '</div>' : '') +
      '</div>';

    if (!animate) $$('.card', box).forEach(function (el) { el.style.animation = 'none'; });
    $('#bSort').value = b.sort || 'no';
    $('#bSort').onchange = function () { b.sort = this.value; b.page = 0; renderBulkResult(); };
    var st;
    $('#bSearch').oninput = function () {
      var v = this.value; clearTimeout(st);
      st = setTimeout(function () { b.search = v; b.page = 0; renderBulkResult(); var el = $('#bSearch'); el.focus(); el.setSelectionRange(v.length, v.length); }, 250);
    };
    $$('#bFilter button').forEach(function (x) { x.onclick = function () { b.filter = x.dataset.f; b.page = 0; renderBulkResult(); }; });
    $('#bDetail').onchange = function () { b.detail = this.checked; renderBulkResult(); };
    $$('.pager button', box).forEach(function (x) { x.onclick = function () { b.page = Number(x.dataset.p); renderBulkResult(); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
    var rt = $('#bRetry'); if (rt) rt.onclick = retryFailed;
    $('#bXlsx').onclick = function () { exportBulk(this); };
  }

  function exportBulk(btn) {
    var b = state.bulk, tons = state.calc.tons, meta = b.meta || {};
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
    var cond = [['항목', '값'], ['조회 일시', new Date().toLocaleString('ko-KR')], ['조회자', state.user.name + ' (' + state.user.id + ')'],
      ['전체 건수', b.results.length], ['성공', ok], ['실패', b.results.length - ok],
      ['밀크런 기준 톤수', meta.baseTon || ''], ['편도/왕복', state.pub.roundTrip ? '왕복' : '편도'],
      ['경유가(원/L)', meta.diesel ? meta.diesel.price : ''], ['경유가 출처', meta.diesel ? meta.diesel.source : ''],
      ['비고', '톤수별 합계 = 타리프 + 지역할증 + 하행할증 / 유류비·통행료는 밀크런 기준 톤수로 별도 계산']];
    busy(btn, true, '만드는 중…');
    downloadXlsx('조일ver1_대량견적_' + today() + '_' + b.results.length + '건.xlsx', [
      { name: '대량 견적', rows: [head].concat(rows), widths: widths },
      { name: '조건', rows: cond, widths: [16, 60] }
    ]).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
  }

  /* ───────── 관리자 ───────── */

  var ADMIN_TABS = [
    ['basic', '기본 설정', 'var(--orange)'],
    ['region', '지역 할증', 'var(--yellow)'],
    ['tariff', '타리프 단가', 'var(--red)'],
    ['users', '계정 관리', 'var(--cyan)'],
    ['logs', '조회 기록', 'var(--green)'],
    ['keys', 'API 키', 'var(--ink-2)']
  ];

  function renderAdmin() {
    var a = state.admin;
    $('#main').innerHTML =
      '<div class="admin-grid"><nav class="card rail">' + ADMIN_TABS.map(function (t) {
        return '<button data-tab="' + t[0] + '" class="' + (a.tab === t[0] ? 'on' : '') + '"><span class="dot" style="--c:' + t[2] + '"></span>' + t[1] + '</button>';
      }).join('') + '</nav><section id="adminBody"><div class="card muted">불러오는 중…</div></section></div>';
    $$('.rail button').forEach(function (b) { b.onclick = function () { a.tab = b.dataset.tab; renderAdmin(); }; });

    var need = [];
    if ((a.tab === 'basic' || a.tab === 'region' || a.tab === 'keys' || a.tab === 'tariff') && !a.settings) {
      need.push(api('admin.getSettings').then(function (r) { a.settings = r.settings; a.keys = r.keys; }));
    }
    if (a.tab === 'tariff' && !a.tariff) need.push(api('admin.getTariff').then(function (r) { a.tariff = r.tariff; a.tariffOrig = clone(r.tariff); }));
    if (a.tab === 'users') need.push(api('admin.listUsers').then(function (r) { a.users = r.users; }));
    if (a.tab === 'logs') need.push(api('admin.getLogs', { limit: 200 }).then(function (r) { a.logs = r.logs; }));

    Promise.all(need).then(function () {
      if (state.view !== 'admin' || a.tab !== (($('.rail button.on') || {}).dataset || {}).tab) return;
      ({ basic: adminBasic, region: adminRegion, tariff: adminTariff, users: adminUsers, logs: adminLogs, keys: adminKeys })[a.tab]();
    }).catch(function (err) {
      $('#adminBody').innerHTML = '<div class="card"><p style="margin:0">' + esc(err.message) + '</p></div>';
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

  function adminUsers() {
    var a = state.admin;
    var body = $('#adminBody');
    body.innerHTML =
      '<div class="card" style="margin-bottom:16px"><div class="eyebrow">Accounts · 계정</div><h2 style="margin-bottom:16px">새 계정 발급</h2>' +
      '<form id="newUser" class="form-grid" style="align-items:end">' +
      '<div class="field"><label>아이디 (영문·숫자)</label><input class="input" id="nuId" required pattern="[A-Za-z0-9_.\\-]{3,30}"></div>' +
      '<div class="field"><label>이름</label><input class="input" id="nuName" required></div>' +
      '<div class="field"><label>권한</label><select class="input" id="nuRole"><option value="user">직원 (계산만)</option><option value="admin">관리자</option></select></div>' +
      '<div class="field"><button class="btn btn-primary" type="submit" style="width:100%;padding:12px">발급하기</button></div>' +
      '</form><p class="hint" style="margin:0">임시 비밀번호가 한 번만 표시됩니다. 직원은 첫 로그인 때 비밀번호를 바꿉니다.</p></div>' +
      '<div class="card" style="--i:1"><h3 style="margin-bottom:12px">계정 목록 <span class="muted small">' + a.users.length + '명</span></h3>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>아이디</th><th style="text-align:left">이름</th><th style="text-align:left">권한</th><th style="text-align:left">상태</th><th>마지막 로그인</th><th></th></tr></thead><tbody>' +
      a.users.map(function (u, i) {
        var self = u.id === state.user.id;
        return '<tr style="--i:' + i + '"><td class="ton">' + esc(u.id) + '</td><td style="text-align:left">' + esc(u.name) + '</td>' +
          '<td style="text-align:left">' + (u.role === 'admin' ? '<span class="role-badge">ADMIN</span>' : '직원') + '</td>' +
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
    $('#newUser').onsubmit = function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('button[type=submit]');
      var id = $('#nuId').value.trim();
      busy(btn, true, '발급 중…');
      api('admin.createUser', { id: id, name: $('#nuName').value, role: $('#nuRole').value }).then(function (r) {
        a.users = null; renderAdmin();
        showTemp('계정을 발급했습니다', id, r.tempPassword);
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    $$('[data-reset]', body).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.reset;
        if (!confirm(id + ' 계정의 비밀번호를 초기화할까요?')) return;
        busy(b, true, '…');
        api('admin.resetPassword', { id: id }).then(function (r) {
          a.users = null; renderAdmin(); showTemp('비밀번호를 초기화했습니다', id, r.tempPassword);
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
          a.users = null; renderAdmin();
        }).catch(function (err) { busy(b, false); toast(err.message, 'err'); });
      };
    });
  }

  function adminLogs() {
    var logs = state.admin.logs;
    $('#adminBody').innerHTML =
      '<div class="card"><div class="row-between" style="margin-bottom:14px;flex-wrap:wrap"><div><div class="eyebrow">Logs · 조회 기록</div><h2>최근 조회 ' + logs.length + '건</h2></div>' +
      '<div class="actions"><button class="btn btn-sm" id="logReload">새로고침</button><button class="btn btn-sm" id="logCsv">CSV 내려받기</button></div></div>' +
      (logs.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>일시</th><th style="text-align:left">사용자</th><th style="text-align:left">상차지</th><th style="text-align:left">하차지</th><th>거리</th></tr></thead><tbody>' +
        logs.map(function (l, i) {
          return '<tr style="--i:' + Math.min(i, 20) + '"><td class="small muted">' + esc(l.at) + '</td><td style="text-align:left">' + esc(l.name) + ' <span class="muted small">' + esc(l.id) + '</span></td>' +
            '<td style="text-align:left;white-space:normal;min-width:180px">' + esc(l.from) + '</td><td style="text-align:left;white-space:normal;min-width:180px">' + esc(l.to) + (l.note ? ' <span class="badge off">' + esc(l.note) + '</span>' : '') + '</td><td class="num">' + (l.km === '' || l.km == null ? '–' : esc(l.km) + 'km') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted" style="margin:0">아직 조회 기록이 없습니다.</p>') + '</div>';
    $('#logReload').onclick = function () { state.admin.logs = null; renderAdmin(); };
    $('#logCsv').onclick = function () {
      downloadCsv('조일ver1_조회기록_' + today() + '.csv', [['일시', '아이디', '이름', '상차지', '하차지', '거리(km)', '비고']].concat(logs.map(function (l) { return [l.at, l.id, l.name, l.from, l.to, l.km, l.note]; })));
    };
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
    api('admin.cacheInfo').then(function (r) { showCache(r.cache); }).catch(function () { var el = $('#cacheInfo'); if (el) el.textContent = ''; });
    $('#clearCache').onclick = function () {
      if (!confirm('저장된 주소·경로를 모두 지울까요? 다음 조회부터 카카오 호출이 다시 늘어납니다.')) return;
      var btn = this; busy(btn, true, '비우는 중…');
      api('admin.clearCache').then(function (r) { showCache(r.cache); toast('캐시를 비웠습니다.'); })
        .catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
    $('#testKakao').onclick = function () {
      var btn = this; busy(btn, true, '확인 중…');
      api('admin.testKakao').then(function (r) { toast(r.message); }).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  /* ───────── 시작 ───────── */

  window.addEventListener('beforeunload', function (e) {
    if (state.admin.tariffDirty || state.admin.settingsDirty || state.bulk.running) { e.preventDefault(); e.returnValue = ''; }
  });

  if (state.token) {
    app.innerHTML = '<div class="login-wrap"><div class="muted">불러오는 중…</div></div>';
    api('me').then(function (r) { state.user = r.user; return afterLogin(); })
      .catch(function () { clearSession(); render(); });
  } else {
    render();
  }
})();
