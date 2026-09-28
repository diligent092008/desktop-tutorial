/**
 * 데모 모드 서버 흉내 — config.js 의 API_URL 이 비어 있을 때만 사용됩니다.
 * 임의 타리프와 주요 도시 좌표로 직선거리 × 1.22 를 경로 거리로 가정합니다.
 * 실제 단가·실제 경로와 무관한 시연용입니다.
 */
(function () {
  var CITIES = [
    ['서울', '서울', 37.5665, 126.978], ['인천', '인천', 37.4563, 126.7052], ['수원', '경기', 37.2636, 127.0286],
    ['평택', '경기', 36.9921, 127.1129], ['이천', '경기', 37.2723, 127.435], ['군포', '경기', 37.3617, 126.9352],
    ['화성', '경기', 37.1995, 126.8312], ['용인', '경기', 37.2411, 127.1776], ['파주', '경기', 37.7599, 126.7802],
    ['춘천', '강원특별자치도', 37.8813, 127.7298], ['원주', '강원특별자치도', 37.3422, 127.9202], ['강릉', '강원특별자치도', 37.7519, 128.8761],
    ['대전', '대전', 36.3504, 127.3845], ['세종', '세종특별자치시', 36.48, 127.289], ['청주', '충북', 36.6424, 127.489],
    ['천안', '충남', 36.8151, 127.1139], ['아산', '충남', 36.7898, 127.0018], ['당진', '충남', 36.8898, 126.6459],
    ['전주', '전북특별자치도', 35.8242, 127.148], ['군산', '전북특별자치도', 35.9676, 126.7366], ['광주', '광주', 35.1595, 126.8526],
    ['목포', '전남', 34.8118, 126.3922], ['여수', '전남', 34.7604, 127.6622], ['순천', '전남', 34.9507, 127.4872],
    ['대구', '대구', 35.8714, 128.6014], ['구미', '경북', 36.1195, 128.3446], ['포항', '경북', 36.019, 129.3435],
    ['부산', '부산', 35.1796, 129.0756], ['울산', '울산', 35.5384, 129.3114], ['창원', '경남', 35.2285, 128.6811],
    ['김해', '경남', 35.2285, 128.8894], ['양산', '경남', 35.335, 129.0373], ['제주', '제주특별자치도', 33.4996, 126.5312]
  ];

  var store = load() || {
    settings: joilDefaultSettings(),
    tariff: joilDummyTariff(),
    keys: { kakao: false, opinet: false },
    users: [{ id: 'admin', name: '관리자(데모)', role: 'admin', active: true, mustChange: false, pw: 'demo1234', createdAt: today(), lastLogin: '' }],
    logs: []
  };
  store.settings = joilMergeSettings(store.settings);
  var sessions = loadSessions();

  function loadSessions() { try { return JSON.parse(sessionStorage.getItem('joil-demo-sessions') || '{}'); } catch (e) { return {}; } }
  function saveSessions() { try { sessionStorage.setItem('joil-demo-sessions', JSON.stringify(sessions)); } catch (e) { /* 무시 */ } }

  function load() { try { return JSON.parse(localStorage.getItem('joil-demo') || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem('joil-demo', JSON.stringify(store)); } catch (e) { /* 저장 불가 시 메모리만 사용 */ } }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function pad(n) { return ('0' + n).slice(-2); }
  function fail(msg) { throw new Error(msg); }
  function temp() { return 'demo' + Math.random().toString(36).slice(2, 8) + '7'; }

  function geocode(q) {
    var c = CITIES.filter(function (c) { return q.indexOf(c[0]) !== -1; })[0];
    if (!c) fail('데모 모드는 주요 도시명만 알아봅니다. 예) 서울, 부산, 평택, 강릉, 목포 … ("' + q + '")');
    return { lat: c[2], lng: c[3], sido: c[1], address: c[1] + ' ' + (c[0] === c[1] ? '' : c[0] + ' ') + '(데모 좌표)', query: q };
  }
  function haversine(a, b) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function session(token) {
    var id = sessions[token];
    if (!id) fail('로그인이 만료되었습니다. 다시 로그인하세요.');
    var u = store.users.filter(function (u) { return u.id === id; })[0];
    if (!u || !u.active) fail('사용이 중지된 계정입니다.');
    return { id: u.id, name: u.name, role: u.role, mustChange: u.mustChange };
  }
  function user(id) { var u = store.users.filter(function (u) { return u.id === id; })[0]; if (!u) fail('계정을 찾을 수 없습니다.'); return u; }
  function diesel() { var s = store.settings; return s.fuel.mode === 'auto' ? { price: 1520, source: '데모 경유가' } : { price: Number(s.fuel.manualPrice), source: '관리자 기본값' }; }

  function pubSettings() {
    var s = store.settings;
    return { tons: s.tons.map(function (t) { return t.name; }), fuelMode: s.fuel.mode, manualPrice: s.fuel.manualPrice, baseTon: s.milkrun.baseTon, roundTrip: s.milkrun.roundTrip, maxRows: s.batch.maxRows, quoteFooter: s.quoteFooter, maxKm: s.maxKm };
  }
  function userList() {
    return store.users.map(function (u) { return { id: u.id, name: u.name, role: u.role, active: u.active, mustChange: u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin }; });
  }
  function addLog(me, from, to, km, note) {
    store.logs.unshift({ at: today(), id: me.id, name: me.name, from: from, to: to, km: km, note: note });
    store.logs = store.logs.slice(0, 200); save();
  }
  function quoteMany(pairs, req) {
    var s = store.settings;
    var baseTon = joilFindTon(s, req.baseTon) || joilFindTon(s, s.milkrun.baseTon) || s.tons[0];
    var dp = req.dieselMode === 'manual' && Number(req.dieselPrice) > 0 ? { price: Number(req.dieselPrice), source: '직접 입력' } : diesel();
    var items = pairs.map(function (p) {
      var o, d;
      try { o = geocode(joilNormalizeAddress(p.origin)); } catch (e) { return { error: '상차지: ' + e.message }; }
      try { d = geocode(joilNormalizeAddress(p.dest)); } catch (e) { return { error: '하차지: ' + e.message }; }
      if (o.lat === d.lat && o.lng === d.lng) return { error: '경로 없음: 출발지와 도착지가 같습니다' };
      var km = Math.max(3, haversine(o, d) * 1.22);
      var toll = km < 15 ? 0 : Math.round((900 + km * 45) * (1 + 0.12 * (Number(baseTon.tollClass) - 1)) / 100) * 100;
      var r = joilComputeQuote({ origin: o, dest: d, distanceKm: km, toll: toll, dieselPrice: dp.price, baseTon: baseTon.name }, s, store.tariff);
      r.origin = o; r.dest = d; r.dieselSource = dp.source;
      return { result: r };
    });
    return { items: items, diesel: dp, baseTon: baseTon.name };
  }

  function handle(req) {
    if (req.action === 'login') {
      var u = store.users.filter(function (u) { return u.id === String(req.id || '').trim(); })[0];
      if (!u || !u.active || u.pw !== req.password) fail('아이디 또는 비밀번호가 올바르지 않습니다.');
      u.lastLogin = today(); save();
      var token = Math.random().toString(36).slice(2) + Date.now();
      sessions[token] = u.id; saveSessions();
      return { token: token, user: { id: u.id, name: u.name, role: u.role, mustChange: u.mustChange }, settings: pubSettings() };
    }
    var me = session(req.token);
    var s = store.settings;
    if (me.mustChange && ['me', 'logout', 'changePassword', 'publicSettings'].indexOf(req.action) === -1) fail('임시 비밀번호입니다. 비밀번호를 먼저 변경하세요.');
    switch (req.action) {
      case 'me': return { user: me, settings: pubSettings() };
      case 'logout': delete sessions[req.token]; saveSessions(); return {};
      case 'changePassword':
        var cu = user(me.id);
        if (cu.pw !== req.current) fail('현재 비밀번호가 올바르지 않습니다.');
        if (String(req.next || '').length < 8 || !/[A-Za-z]/.test(req.next) || !/[0-9]/.test(req.next)) fail('비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.');
        cu.pw = req.next; cu.mustChange = false; save(); return {};
      case 'publicSettings': return { settings: pubSettings() };
      case 'dieselPrice': return diesel();
      case 'quote':
        var one = quoteMany([{ origin: req.origin, dest: req.dest }], req).items[0];
        if (one.error) fail(one.error);
        addLog(me, one.result.origin.address, one.result.dest.address, one.result.distanceKm, '데모');
        return { result: one.result };
      case 'quoteBatch':
        if (!req.pairs || !req.pairs.length) fail('계산할 경로가 없습니다.');
        if (Number(req.batch && req.batch.count) > Number(s.batch.maxRows)) fail('대량 계산은 최대 ' + s.batch.maxRows + '건까지입니다.');
        var out = quoteMany(req.pairs, req);
        if (req.batch && Number(req.batch.index) === 0) addLog(me, req.pairs[0].origin, '하차지 ' + req.batch.count + '곳', '', '대량 ' + req.batch.count + '건 (데모)');
        return out;
    }
    if (me.role !== 'admin') fail('관리자만 사용할 수 있습니다.');
    switch (req.action) {
      case 'admin.bootstrap': return { settings: s, keys: store.keys, users: userList(), logs: store.logs, cache: { addresses: 0, routes: 0 } };
      case 'admin.getSettings': return { settings: s, keys: store.keys };
      case 'admin.saveSettings': store.settings = joilMergeSettings(req.settings); save(); return { settings: store.settings };
      case 'admin.getTariff': return { tariff: store.tariff };
      case 'admin.saveTariff':
        var err = joilValidateTariff(req.tariff, s.tons.length, Number(s.maxKm) || 600);
        if (err) fail(err);
        store.tariff = { tons: s.tons.map(function (t) { return t.name; }), rows: req.tariff.rows.map(function (r) { return r.map(Number); }) };
        save(); return {};
      case 'admin.listUsers':
        return { users: store.users.map(function (u) { return { id: u.id, name: u.name, role: u.role, active: u.active, mustChange: u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin }; }) };
      case 'admin.createUser':
        var id = String(req.id || '').trim();
        if (!/^[A-Za-z0-9_.-]{3,30}$/.test(id)) fail('아이디는 영문/숫자 3~30자로 입력하세요.');
        if (!String(req.name || '').trim()) fail('이름을 입력하세요.');
        if (store.users.some(function (u) { return u.id === id; })) fail('이미 있는 아이디입니다.');
        var t = temp();
        store.users.push({ id: id, name: String(req.name).trim(), role: req.role === 'admin' ? 'admin' : 'user', active: true, mustChange: true, pw: t, createdAt: today(), lastLogin: '' });
        save(); return { tempPassword: t };
      case 'admin.updateUser':
        var uu = user(req.id), p = req.patch || {};
        if (uu.id === me.id && (p.active === false || p.role === 'user')) fail('본인 계정은 중지하거나 권한을 낮출 수 없습니다.');
        if (p.hasOwnProperty('active')) uu.active = !!p.active;
        if (p.role) uu.role = p.role === 'admin' ? 'admin' : 'user';
        save(); return {};
      case 'admin.resetPassword':
        var ru = user(req.id), tp = temp(); ru.pw = tp; ru.mustChange = true; save(); return { tempPassword: tp };
      case 'admin.getLogs': return { logs: store.logs };
      case 'admin.saveKeys':
        if (req.kakao) store.keys.kakao = true;
        if (req.opinet) store.keys.opinet = true;
        save(); return { keys: store.keys };
      case 'admin.testKakao': return { message: '데모 모드에서는 실제 카카오 연결을 시험하지 않습니다.' };
      case 'admin.cacheInfo': return { cache: { addresses: 0, routes: 0 } };
      case 'admin.clearCache': return { cache: { addresses: 0, routes: 0 } };
    }
    fail('알 수 없는 요청입니다: ' + req.action);
  }

  window.JoilDemo = {
    call: function (req) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { var out = handle(JSON.parse(JSON.stringify(req))); resolve(JSON.parse(JSON.stringify(out))); }
          catch (e) { reject(e); }
        }, req.action === 'quote' ? 450 : req.action === 'quoteBatch' ? 250 + 15 * ((req.pairs || []).length) : 180);
      });
    },
    reset: function () { try { localStorage.removeItem('joil-demo'); } catch (e) { } location.reload(); }
  };
})();
