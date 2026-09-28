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
    calc: { origin: '', dest: '', dieselMode: null, dieselPrice: '', tons: null, result: null, busy: false },
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
      '<button data-view="calc" class="' + (state.view === 'calc' ? 'on' : '') + '">견적 계산</button>' +
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

    if (state.view === 'admin' && state.user.role === 'admin') renderAdmin(); else renderCalc();
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

  /* ───────── 견적 계산 ───────── */

  function renderCalc() {
    var c = state.calc;
    var main = $('#main');
    main.innerHTML =
      '<div class="calc-grid">' +
      '<form class="card" id="calcForm" autocomplete="off">' +
      '<div class="eyebrow">Route · 경로</div><h2 style="margin-bottom:18px">견적 계산</h2>' +
      '<div class="route-inputs">' +
      '<div class="field"><label for="origin"><span class="pin from"></span>상차지</label><input class="input" id="origin" placeholder="예) 경기 평택시 포승읍 평택항로 …" value="' + esc(c.origin) + '"></div>' +
      '<button type="button" class="swap-btn" id="swap" title="상차지·하차지 바꾸기" aria-label="상차지와 하차지 바꾸기">⇅</button>' +
      '<div class="field"><label for="dest"><span class="pin to"></span>하차지</label><input class="input" id="dest" placeholder="예) 부산 강서구 녹산산단 …" value="' + esc(c.dest) + '"></div>' +
      '</div>' +
      '<div class="section-gap"></div>' +
      '<div class="row-between" style="margin-bottom:10px"><div class="eyebrow" style="margin:0">Diesel · 경유가</div>' +
      '<div class="segmented" id="dieselSeg"><button type="button" data-m="auto" class="' + (c.dieselMode === 'auto' ? 'on' : '') + '">자동</button><button type="button" data-m="manual" class="' + (c.dieselMode === 'manual' ? 'on' : '') + '">직접 입력</button></div></div>' +
      '<div class="field ' + (c.dieselMode === 'manual' ? '' : 'hidden') + '" id="dieselField"><input class="input num" id="dieselPrice" type="number" min="0" step="1" value="' + esc(c.dieselPrice) + '" placeholder="원/L"><span class="hint">원/L 기준</span></div>' +
      '<p class="hint ' + (c.dieselMode === 'auto' ? '' : 'hidden') + '" id="dieselHint" style="margin:-2px 0 14px">관리자 설정의 자동 조회(오피넷) 값을 사용합니다.</p>' +
      '<div class="row-between" style="margin-bottom:10px"><div class="eyebrow" style="margin:0">Tonnage · 톤수</div>' +
      '<div><button type="button" class="btn btn-ghost btn-sm" id="tonAll">전체</button><button type="button" class="btn btn-ghost btn-sm" id="tonNone">해제</button></div></div>' +
      '<div class="chips" id="tonChips">' + state.pub.tons.map(function (t) {
        return '<button type="button" class="chip ' + (c.tons.indexOf(t) !== -1 ? 'on' : '') + '" data-t="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div>' +
      '<div class="section-gap"></div><div class="section-gap"></div>' +
      '<button class="btn btn-accent btn-lg" type="submit" id="calcBtn">견적 계산하기</button>' +
      '</form>' +
      '<div id="result"></div></div>';

    var form = $('#calcForm');
    $('#origin').oninput = function () { c.origin = this.value; };
    $('#dest').oninput = function () { c.dest = this.value; };
    $('#dieselPrice').oninput = function () { c.dieselPrice = this.value; };
    $('#swap').onclick = function () {
      var o = c.origin; c.origin = c.dest; c.dest = o;
      $('#origin').value = c.origin; $('#dest').value = c.dest;
    };
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
      if (c.result) renderResult(false);
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

    form.onsubmit = function (e) {
      e.preventDefault();
      if (!c.origin.trim() || !c.dest.trim()) return toast('상차지와 하차지를 모두 입력하세요.', 'err');
      if (c.dieselMode === 'manual' && !(Number(c.dieselPrice) > 0)) return toast('경유가를 입력하세요.', 'err');
      var btn = $('#calcBtn');
      busy(btn, true, '경로 조회 중…');
      api('quote', { origin: c.origin, dest: c.dest, dieselMode: c.dieselMode, dieselPrice: Number(c.dieselPrice) })
        .then(function (r) { c.result = r.result; renderResult(true); })
        .catch(function (err) { toast(err.message, 'err'); })
        .then(function () { busy(btn, false); });
    };

    if (c.result) renderResult(false); else renderEmpty();
  }

  function renderEmpty() {
    $('#result').innerHTML =
      '<div class="card empty" style="--i:1"><div><div class="big-stripes"></div>' +
      '<h3>주소를 넣고 계산해 보세요</h3>' +
      '<p class="muted" style="margin:0">거리 · 유류비 · 통행료 · 톤수별 운임이 한 번에 나옵니다.</p>' +
      (DEMO ? '<p class="hint" style="margin-top:14px">데모 모드: 서울, 평택, 부산, 강릉, 목포 같은 도시명으로 시험할 수 있어요.</p>' : '') +
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
      '<div class="stat"><div class="k">지역 할증 (합산)</div><div class="v" style="font-size:14px;font-weight:600">' + regionHtml + '</div></div>' +
      '<div class="stat"><div class="k">경유가</div><div class="v num">' + won(r.dieselPrice) + '<span class="small"> 원/L</span></div><div class="s">' + esc(r.dieselSource) + '</div></div>' +
      '<div class="stat"><div class="k">통행료 (1종)</div><div class="v num">' + won(r.toll1) + '<span class="small"> 원</span></div><div class="s">' + (r.tollIncluded ? '합계에 포함' : '참고용') + '</div></div>' +
      '</div></div>';

    if (r.overMax) {
      html += '<div class="over-max" style="margin-top:16px;animation:rise .45s var(--ease) both"><h3>' + r.maxKm + 'km 초과 — 별도 문의</h3>' +
        '<p class="muted" style="margin:0">요금 기준 거리 ' + r.km + 'km는 타리프 범위를 넘어 자동 견적을 낼 수 없습니다.</p></div>';
    } else {
      var fuelTag = r.fuelIncluded ? '' : '<span class="tag">참고</span>';
      var tollTag = r.tollIncluded ? '' : '<span class="tag">참고</span>';
      html +=
        '<div class="card" style="--i:1;margin-top:16px">' +
        '<div class="row-between" style="margin-bottom:14px;flex-wrap:wrap"><div><div class="eyebrow">Quote · 톤수별 견적</div><h3>' + rows.length + '개 톤수</h3></div>' +
        '<div class="actions"><button class="btn btn-sm" id="copyQuote">회신 문구 복사</button><button class="btn btn-sm" id="csvQuote">엑셀(CSV) 저장</button></div></div>' +
        (rows.length ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>톤수</th><th>타리프</th><th>지역할증</th><th>하행할증</th><th>유류비' + fuelTag + '</th><th>통행료' + tollTag + '</th><th>합계</th>' +
          '</tr></thead><tbody>' + rows.map(function (row, i) {
            return '<tr style="--i:' + i + '"><td class="ton">' + esc(row.ton) + '</td>' +
              '<td class="num">' + won(row.tariff) + '</td>' +
              '<td class="num">' + won(row.region) + '</td>' +
              '<td class="num">' + won(row.downhill) + '</td>' +
              '<td class="num ' + (r.fuelIncluded ? '' : 'ref') + '">' + won(row.fuel) + '</td>' +
              '<td class="num ' + (r.tollIncluded ? '' : 'ref') + '"><span title="' + row.tollClass + '종">' + won(row.toll) + '</span></td>' +
              '<td class="total"><span class="num" data-total="' + row.total + '">' + won(row.total) + '</span></td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted" style="margin:0">선택된 톤수가 없습니다. 왼쪽에서 톤수를 골라 주세요.</p>') +
        '<p class="hint" style="margin:14px 0 0">합계 = 타리프 + 지역할증 + 하행할증' + (r.fuelIncluded ? ' + 유류비' : '') + (r.tollIncluded ? ' + 통행료' : '') + ' (금액 단위 반올림 적용)</p>' +
        '</div>';
    }

    var box = $('#result');
    box.innerHTML = html;
    if (!animate) $$('.card, tr', box).forEach(function (el) { el.style.animation = 'none'; });
    else $$('[data-total]', box).forEach(function (el) { countUp(el, Number(el.dataset.total)); });

    var copyBtn = $('#copyQuote'), csvBtn = $('#csvQuote');
    if (copyBtn) copyBtn.onclick = function () {
      copyText(quoteText(r, rows)).then(function () { toast('회신 문구를 복사했습니다.'); });
    };
    if (csvBtn) csvBtn.onclick = function () {
      var head = ['상차지', '하차지', '거리(km)', '톤수', '타리프', '지역할증', '하행할증', '유류비', '통행료', '합계'];
      downloadCsv('조일ver1_견적_' + today() + '.csv', [head].concat(rows.map(function (row) {
        return [r.origin.address, r.dest.address, r.distanceKm, row.ton, row.tariff, row.region, row.downhill, row.fuel, row.toll, row.total];
      })));
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

      '<div class="group"><div class="group-head"><h3>유류비</h3>' + toggleHtml('fuelOn', s.fuel.include, '합계에 포함') + '</div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>경유가 기본 방식</label><select class="input" id="fuelMode"><option value="manual"' + (s.fuel.mode === 'manual' ? ' selected' : '') + '>직접 입력값 사용</option><option value="auto"' + (s.fuel.mode === 'auto' ? ' selected' : '') + '>오피넷 자동 조회</option></select><span class="hint">자동 조회는 API 키 탭에서 오피넷 키가 필요해요</span></div>' +
      '<div class="field"><label>기본 경유가 (원/L)</label><input class="input num" type="number" min="0" id="fuelPrice" value="' + esc(s.fuel.manualPrice) + '"></div>' +
      '<div class="field"><label>유류비 거리 배수</label><input class="input num" type="number" min="0" step="0.1" id="fuelFactor" value="' + esc(s.fuel.distanceFactor) + '"><span class="hint">편도 1, 공차 복귀 포함 시 2</span></div>' +
      '</div></div>' +

      '<div class="group"><div class="group-head"><h3>통행료</h3>' + toggleHtml('tollOn', s.toll.include, '합계에 포함') + '</div>' +
      '<div class="field" style="max-width:420px"><label>계산 방식</label><select class="input" id="tollMode">' +
      '<option value="ratio"' + (s.toll.mode === 'ratio' ? ' selected' : '') + '>1종만 조회 후 차종 비율로 환산 (호출 절약)</option>' +
      '<option value="api"' + (s.toll.mode === 'api' ? ' selected' : '') + '>차종별로 카카오에서 직접 조회 (정확, 호출 많음)</option></select></div>' +
      '<div class="form-grid">' + [1, 2, 3, 4, 5].map(function (k) {
        return '<div class="field"><label>' + k + '종 비율 (1종 대비)</label><input class="input num input-sm" type="number" min="0" step="0.01" data-ratio="' + k + '" value="' + esc(s.toll.ratios[k]) + '"></div>';
      }).join('') + '</div></div>' +

      '<div class="group"><div class="group-head"><h3>톤수별 연비 · 통행료 차종</h3></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>톤수</th><th>통행료 차종</th><th>연비 (km/L)</th></tr></thead><tbody>' +
      s.tons.map(function (t, i) {
        return '<tr><td class="ton">' + esc(t.name) + '</td>' +
          '<td><select class="input input-sm" data-tc="' + i + '" style="width:110px;margin-left:auto">' + [1, 2, 3, 4, 5].map(function (k) {
            return '<option value="' + k + '"' + (Number(t.tollClass) === k ? ' selected' : '') + '>' + k + '종</option>';
          }).join('') + '</select></td>' +
          '<td><input class="input input-sm num" type="number" min="0" step="0.1" data-kpl="' + i + '" value="' + esc(t.kmPerL) + '" style="width:110px;margin-left:auto;text-align:right"></td></tr>';
      }).join('') + '</tbody></table></div></div>' +

      '<div class="group"><div class="group-head"><h3>거리 · 금액 처리</h3></div><div class="form-grid">' +
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
        case 'fuelOn': s.fuel.include = v; break;
        case 'fuelMode': s.fuel.mode = v; break;
        case 'fuelPrice': s.fuel.manualPrice = Number(v); break;
        case 'fuelFactor': s.fuel.distanceFactor = Number(v); break;
        case 'tollOn': s.toll.include = v; break;
        case 'tollMode': s.toll.mode = v; break;
        case 'maxKm': s.maxKm = Number(v); break;
        case 'kmRound': s.kmRounding = v; break;
        case 'prUnit': s.priceRounding.unit = Number(v); break;
        case 'prMode': s.priceRounding.mode = v; break;
        case 'footer': s.quoteFooter = v; break;
      }
      if (el.dataset.ratio) s.toll.ratios[el.dataset.ratio] = Number(v);
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
            '<td style="text-align:left;white-space:normal;min-width:180px">' + esc(l.from) + '</td><td style="text-align:left;white-space:normal;min-width:180px">' + esc(l.to) + '</td><td class="num">' + esc(l.km) + 'km</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted" style="margin:0">아직 조회 기록이 없습니다.</p>') + '</div>';
    $('#logReload').onclick = function () { state.admin.logs = null; renderAdmin(); };
    $('#logCsv').onclick = function () {
      downloadCsv('조일ver1_조회기록_' + today() + '.csv', [['일시', '아이디', '이름', '상차지', '하차지', '거리(km)']].concat(logs.map(function (l) { return [l.at, l.id, l.name, l.from, l.to, l.km]; })));
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
      '<div class="save-bar"><span class="small muted" style="margin-right:auto">입력한 키만 저장됩니다</span><button class="btn btn-accent" id="saveBtn">키 저장</button></div></div>';
    $('#saveBtn').onclick = function () {
      var kakao = $('#kakaoKey').value.trim(), opinet = $('#opinetKey').value.trim();
      if (!kakao && !opinet) return toast('저장할 키를 입력하세요.', 'err');
      var btn = this; busy(btn, true, '저장 중…');
      api('admin.saveKeys', { kakao: kakao, opinet: opinet }).then(function (r) {
        state.admin.keys = r.keys; toast('키를 저장했습니다.'); adminKeys();
      }).catch(function (err) { busy(btn, false); toast(err.message, 'err'); });
    };
    $('#testKakao').onclick = function () {
      var btn = this; busy(btn, true, '확인 중…');
      api('admin.testKakao').then(function (r) { toast(r.message); }).catch(function (err) { toast(err.message, 'err'); }).then(function () { busy(btn, false); });
    };
  }

  /* ───────── 시작 ───────── */

  window.addEventListener('beforeunload', function (e) {
    if (state.admin.tariffDirty || state.admin.settingsDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  if (state.token) {
    app.innerHTML = '<div class="login-wrap"><div class="muted">불러오는 중…</div></div>';
    api('me').then(function (r) { state.user = r.user; return afterLogin(); })
      .catch(function () { clearSession(); render(); });
  } else {
    render();
  }
})();
