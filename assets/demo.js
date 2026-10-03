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
    logs: [],
    snaps: {},
    quotes: []
  };
  store.snaps = store.snaps || {}; store.quotes = store.quotes || []; store.companies = store.companies || {};
  var docs = [], docData = {}; // 서류함: 메모리에만 (새로고침하면 사라짐)
  store.settings = joilMergeSettings(store.settings);
  var sessions = loadSessions();
  var anData = {}, anIndex = [], anMap = [], anLog = [], anRules = [];
  var dieselRows = (function () { // 데모용 가짜 유가 (최근 120일)
    var out = [], p = 1480, d = new Date(); d.setDate(d.getDate() - 120);
    for (var i = 0; i < 120; i++) { d.setDate(d.getDate() + 1); p += Math.sin(i / 9) * 2.2 + (i % 7 === 0 ? -1.5 : 0.6); out.push([d.toISOString().slice(0, 10), Math.round(p * 100) / 100, '데모']); }
    return out;
  })();
  function dieselStatus() { return { count: dieselRows.length, first: dieselRows[0][0], last: dieselRows[dieselRows.length - 1][0], lastPrice: dieselRows[dieselRows.length - 1][1], triggerOn: false, hasKey: !!store.keys.opinet }; } // 분석 데이터는 용량이 커서 메모리에만 (새로고침하면 사라짐)
  function permsOf(u) { return u.role === 'admin' ? ['quote', 'analysis', 'admin'] : (u.perms || ['quote']); }
  function needPerm(me, p) { if (me.perms.indexOf(p) === -1) fail(p === 'analysis' ? '분석 메뉴 권한이 없습니다. 관리자에게 요청하세요.' : '견적 메뉴 권한이 없습니다. 관리자에게 요청하세요.'); }

  function loadSessions() { try { return JSON.parse(sessionStorage.getItem('joil-demo-sessions') || '{}'); } catch (e) { return {}; } }
  function saveSessions() { try { sessionStorage.setItem('joil-demo-sessions', JSON.stringify(sessions)); } catch (e) { /* 무시 */ } }

  function load() { try { return JSON.parse(localStorage.getItem('joil-demo') || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem('joil-demo', JSON.stringify(store)); } catch (e) { /* 저장 불가 시 메모리만 사용 */ } }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function pad(n) { return ('0' + n).slice(-2); }
  function fail(msg) { throw new Error(msg); }
  function docMeta(m) {
    var name = String(m.name || '').trim(); if (!name) fail('서류명을 입력하세요.');
    return { name: name, biz: String(m.biz || ''), cat: String(m.cat || '기타'), issued: String(m.issued || ''), expires: String(m.expires || ''), memo: String(m.memo || '') };
  }
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
    return { id: u.id, name: u.name, role: u.role, mustChange: u.mustChange, perms: permsOf(u) };
  }
  function user(id) { var u = store.users.filter(function (u) { return u.id === id; })[0]; if (!u) fail('계정을 찾을 수 없습니다.'); return u; }
  function diesel() { var s = store.settings; return s.fuel.mode === 'auto' ? { price: 1520, source: '데모 경유가' } : { price: Number(s.fuel.manualPrice), source: '관리자 기본값' }; }

  function pubSettings() {
    var s = store.settings;
    return { tons: s.tons.map(function (t) { return t.name; }), fuelMode: s.fuel.mode, manualPrice: s.fuel.manualPrice, baseTon: s.milkrun.baseTon, roundTrip: s.milkrun.roundTrip, maxRows: s.batch.maxRows, retentionDays: s.snapshot.retentionDays, quoteFooter: s.quoteFooter, maxKm: s.maxKm, priceRounding: s.priceRounding };
  }
  function userList() {
    return store.users.map(function (u) { return { id: u.id, name: u.name, role: u.role, active: u.active, mustChange: u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin, perms: permsOf(u) }; });
  }
  function addLog(me, from, to, km, note, recordId, type, count) {
    store.logs.unshift({ at: today(), id: me.id, name: me.name, from: from, to: to, km: km, note: note, recordId: recordId || '', type: type || '', count: count || '' });
    store.logs = store.logs.slice(0, 300); save();
  }
  function snapMeta(me, type, count, out) {
    var s = store.settings;
    return { type: type, at: today(), user: { id: me.id, name: me.name }, count: count, baseTon: out.baseTon, diesel: out.diesel, roundTrip: !!s.milkrun.roundTrip, tons: s.tons.map(function (t) { return t.name; }) };
  }
  function addSnap(id, meta, items) {
    var sn = store.snaps[id] || (store.snaps[id] = { meta: meta, items: {} });
    items.forEach(function (it) { var prev = sn.items[it.no]; if (!prev || it.result || !prev.result) sn.items[it.no] = it; });
    save();
  }
  function readSnap(id) {
    var sn = store.snaps[id]; if (!sn) return null;
    return { meta: sn.meta, items: Object.keys(sn.items).map(function (k) { return sn.items[k]; }).sort(function (a, b) { return a.no - b.no; }) };
  }
  function findLog(id) { return store.logs.filter(function (l) { return l.recordId === id; })[0]; }
  function quoteOf(me, id) {
    var q = store.quotes.filter(function (x) { return x.id === id; })[0];
    if (!q) fail('견적을 찾을 수 없습니다.');
    if (me.role !== 'admin' && q.userId !== me.id) fail('본인 견적만 볼 수 있습니다.');
    return q;
  }
  function quoteFields(f) {
    var name = String(f.name || '').trim(); if (!name) fail('견적명을 입력하세요.');
    return { name: name, client: String(f.client || '').trim(), memo: String(f.memo || ''), status: ['작성', '제출', '수주', '미수주'].indexOf(f.status) !== -1 ? f.status : '작성' };
  }
  function publicQuote(q) { var o = JSON.parse(JSON.stringify(q)); delete o.data; return o; }
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
      return { token: token, user: { id: u.id, name: u.name, role: u.role, mustChange: u.mustChange, perms: permsOf(u) }, settings: pubSettings() };
    }
    var me = session(req.token);
    var s = store.settings;
    if (me.mustChange && ['me', 'logout', 'changePassword', 'publicSettings'].indexOf(req.action) === -1) fail('임시 비밀번호입니다. 비밀번호를 먼저 변경하세요.');
    if (['dieselPrice', 'quote', 'quoteBatch', 'history.list', 'history.get', 'quotes.save', 'quotes.list', 'quotes.get', 'quotes.update', 'quotes.delete',
      'docs.list', 'docs.upload', 'docs.update', 'docs.get', 'docs.zip', 'docs.delete', 'addr.list', 'companies', 'diesel.recent'].indexOf(req.action) !== -1) needPerm(me, 'quote');
    if (req.action === 'analysis.index' || req.action === 'analysis.load') needPerm(me, 'analysis');
    switch (req.action) {
      case 'analysis.index':
        anLog.unshift({ at: today(), id: me.id, name: me.name, n: anIndex.length });
        return { index: anIndex.slice(), mapping: anMap.slice(), businesses: ['조일물류', '명일로지스', '조일로지스'], rules: JSON.parse(JSON.stringify(anRules)) };
      case 'analysis.load':
        var dd = {}; (req.keys || []).forEach(function (k) { if (anData[k]) dd[k] = anData[k]; }); return { data: dd };
      case 'me': return { user: me, settings: pubSettings() };
      case 'logout': delete sessions[req.token]; saveSessions(); return {};
      case 'changePassword':
        var cu = user(me.id);
        if (cu.pw !== req.current) fail('현재 비밀번호가 올바르지 않습니다.');
        if (String(req.next || '').length < 8 || !/[A-Za-z]/.test(req.next) || !/[0-9]/.test(req.next)) fail('비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.');
        cu.pw = req.next; cu.mustChange = false; save(); return {};
      case 'publicSettings': return { settings: pubSettings() };
      case 'info.diesel': return { now: diesel(), rows: dieselRows.map(function (r) { return [r[0], r[1]]; }) };
      case 'info.news':
        var ago = function (h) { return Date.now() - h * 3600000; };
        return { at: today(), failed: 0, keywords: { include: ['화물연대', '안전운임', '경유 가격', '항만 파업'], exclude: ['교통사고'], watch: ['쿠팡'] }, items: [
          { title: '[데모] 화물연대, 다음 달 총파업 예고…운송 차질 우려', source: '데모뉴스', at: ago(2), link: 'https://news.google.com/', kws: ['화물연대'], watch: false },
          { title: '[데모] 안전운임제 재도입 법안 국회 상임위 통과', source: '데모일보', at: ago(5), link: 'https://news.google.com/', kws: ['안전운임', '화물연대'], watch: false },
          { title: '[데모] 경유 가격 3주 연속 상승…리터당 1,500원 넘어', source: '데모경제', at: ago(9), link: 'https://news.google.com/', kws: ['경유 가격'], watch: false },
          { title: '[데모] 쿠팡, 충청권 새 물류센터 착공', source: '데모산업', at: ago(20), link: 'https://news.google.com/', kws: ['쿠팡'], watch: true },
          { title: '[데모] 부산항 컨테이너 부두 노조 부분 파업', source: '데모항만', at: ago(30), link: 'https://news.google.com/', kws: ['항만 파업'], watch: false }
        ] };
      case 'info.weather':
        var dd = function (k) { var d = new Date(); d.setDate(d.getDate() + k); return d.toISOString().slice(0, 10); };
        var mk = function (name, city, c, tmp, snow, rain) { return { name: name, city: city, now: { temp: tmp, code: c, wind: 10 }, days: [0, 1, 2].map(function (k) { return { date: dd(k), code: k ? 3 : c, max: tmp + 4 - k, min: tmp - 6 + k, pop: k ? 20 : (rain || snow ? 80 : 10), rain: k ? 0 : rain, snow: k ? 0 : snow, wind: 15 }; }) }; };
        return { at: today(), regions: [mk('경기도', '수원', 2, 14, 0, 0), mk('충청도', '대전', 61, 13, 0, 14), mk('전라도', '광주', 0, 17, 0, 0), mk('강원도', '강릉', 71, 3, 4, 0), mk('경상도', '대구', 1, 16, 0, 0)] };
      case 'dieselPrice': return diesel();
      case 'quote':
        var one = quoteMany([{ origin: req.origin, dest: req.dest }], req).items[0];
        if (one.error) fail(one.error);
        var rid = 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        addLog(me, one.result.origin.address, one.result.dest.address, one.result.distanceKm, '', rid, '단건', 1);
        var qo = quoteMany([{ origin: req.origin, dest: req.dest }], req);
        addSnap(rid, snapMeta(me, '단건', 1, qo), [{ no: 1, origin: req.origin, dest: req.dest, result: one.result }]);
        return { result: one.result, recordId: rid };
      case 'quoteBatch':
        if (!req.pairs || !req.pairs.length) fail('계산할 경로가 없습니다.');
        if (Number(req.batch && req.batch.count) > Number(s.batch.maxRows)) fail('대량 계산은 최대 ' + s.batch.maxRows + '건까지입니다.');
        var out = quoteMany(req.pairs, req);
        var bt = req.batch || {};
        if (Number(bt.index) === 0) addLog(me, req.pairs[0].origin, '하차지 ' + bt.count + '곳', '', '대량 ' + bt.count + '건', bt.id, '대량', bt.count);
        if (bt.id) addSnap(bt.id, snapMeta(me, '대량', bt.count, out), req.pairs.map(function (p, i) { return { no: p.no || i + 1, origin: p.origin, dest: p.dest, result: out.items[i].result || null, error: out.items[i].error || null }; }));
        out.recordId = bt.id || null;
        return out;
      case 'history.list':
        var since = Number(req.days) ? Date.now() - Number(req.days) * 86400000 : 0;
        var who = me.role === 'admin' ? String(req.userId || '') : me.id;
        var logs = store.logs.filter(function (l) {
          if (since && Date.parse(l.at.replace(' ', 'T')) < since) return false;
          if (who && l.id !== who) return false;
          if (req.type && (l.type || '단건') !== req.type) return false;
          if (req.q && (l.from + ' ' + l.to + ' ' + l.name + ' ' + l.id).indexOf(req.q) === -1) return false;
          return true;
        }).map(function (l) { var o = JSON.parse(JSON.stringify(l)); o.hasSnapshot = !!(l.recordId && store.snaps[l.recordId]); return o; });
        var hr = { logs: logs };
        if (me.role === 'admin') hr.users = store.users.map(function (u) { return { id: u.id, name: u.name }; });
        return hr;
      case 'history.get':
        var lg = findLog(req.recordId); if (!lg) fail('기록을 찾을 수 없습니다.');
        if (me.role !== 'admin' && lg.id !== me.id) fail('본인 기록만 볼 수 있습니다.');
        var sn = readSnap(lg.recordId); if (!sn) fail('보관 기간이 지나 상세 내용이 삭제된 기록입니다.');
        return { log: lg, meta: sn.meta, items: sn.items };
      case 'quotes.save':
        var sl = findLog(req.recordId); if (!sl) fail('저장할 조회 기록을 찾을 수 없습니다.');
        if (me.role !== 'admin' && sl.id !== me.id) fail('본인 조회만 저장할 수 있습니다.');
        var ss = readSnap(sl.recordId); if (!ss) fail('보관 기간이 지나 저장할 수 없는 기록입니다.');
        var f = quoteFields(req), first = ss.items[0] || {}, isB = ss.meta.type === '대량';
        var nq = { id: 'E' + Date.now().toString(36), savedAt: today(), userId: me.id, userName: me.name, name: f.name, client: f.client, memo: f.memo, status: f.status,
          type: ss.meta.type, count: ss.items.length, from: isB ? first.origin : (first.result ? first.result.origin.address : first.origin),
          to: isB ? '하차지 ' + ss.items.length + '곳' : (first.result ? first.result.dest.address : first.dest), recordId: sl.recordId, queriedAt: sl.at, updatedAt: today(), data: ss };
        store.quotes.push(nq); save();
        return { quote: publicQuote(nq) };
      case 'quotes.list':
        return { quotes: store.quotes.filter(function (q) { return me.role === 'admin' || q.userId === me.id; }).map(publicQuote).reverse() };
      case 'quotes.get':
        var gq = quoteOf(me, req.id);
        return { quote: publicQuote(gq), meta: gq.data.meta, items: gq.data.items };
      case 'quotes.update':
        var uq = quoteOf(me, req.id), uf = quoteFields(Object.assign({}, uq, req.patch || {}));
        if (req.patch && req.patch.hasOwnProperty('link')) {
          if (req.patch.link && !req.patch.link.cust) fail('연결할 매출처를 고르세요.');
          uq.link = req.patch.link || null;
        }
        uq.name = uf.name; uq.client = uf.client; uq.memo = uf.memo; uq.status = uf.status; uq.updatedAt = today(); save();
        return { quote: publicQuote(uq) };
      case 'diesel.recent': return { now: diesel(), rows: dieselRows.slice(-60).map(function (r) { return [r[0], r[1]]; }) };
      case 'docs.list': return { docs: docs.slice() };
      case 'docs.upload':
        var dm = docMeta(req);
        if (!req.data) fail('파일이 비어 있습니다.');
        var did = 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        docData[did] = req.data;
        var nd = Object.assign({ id: did, fileName: String(req.fileName || dm.name), mime: req.mime || 'application/octet-stream', size: Math.round(req.data.length * 3 / 4), by: me.name + ' (' + me.id + ')', at: today(), updated: today() }, dm);
        docs.push(nd); return { doc: nd };
      case 'docs.update':
        var ud = docs.filter(function (x) { return x.id === req.id; })[0]; if (!ud) fail('서류를 찾을 수 없습니다.');
        Object.assign(ud, docMeta(Object.assign({}, ud, req.patch || {})), { updated: today() }); return { doc: ud };
      case 'docs.get':
        var gd = docs.filter(function (x) { return x.id === req.id; })[0]; if (!gd) fail('서류를 찾을 수 없습니다.');
        return { doc: gd, data: docData[gd.id] };
      case 'docs.zip': fail('데모 모드에서는 ZIP 묶음을 만들 수 없어요. (실제 서버에서는 됩니다)');
      case 'docs.delete': docs = docs.filter(function (x) { return x.id !== req.id; }); delete docData[req.id]; return {};
      case 'addr.list':
        var seenA = {}, al = [];
        store.logs.slice().reverse().forEach(function (l) { [l.from, l.to].forEach(function (a) { if (a && !/^하차지 \d+곳$/.test(a) && !seenA[a]) { seenA[a] = true; al.push([a, '']); } }); });
        CITIES.forEach(function (c) { if (!seenA[c[0]]) al.push([c[0], c[1]]); });
        return { list: al };
      case 'companies':
        var co = JSON.parse(JSON.stringify(store.companies));
        ['조일물류', '명일로지스', '조일로지스'].forEach(function (b) { co[b] = co[b] || {}; });
        return { companies: co };
      case 'quotes.delete':
        var dq = quoteOf(me, req.id);
        store.quotes = store.quotes.filter(function (q) { return q !== dq; }); save();
        return {};
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
      case 'admin.listUsers': return { users: userList() };
      case 'analysis.upload':
        if (['조일물류', '명일로지스', '조일로지스'].indexOf(req.biz) === -1) fail('사업자를 선택하세요.');
        var key = req.biz + '|' + req.month;
        anData[key] = req.data;
        anIndex = anIndex.filter(function (x) { return x.key !== key; });
        anIndex.push({ key: key, biz: req.biz, month: req.month, count: req.count, sales: req.sales || 0, buys: req.buys || 0, fileName: req.fileName || '', uploadedAt: today(), uploader: me.name + ' (' + me.id + ')' });
        return { key: key };
      case 'analysis.delete': delete anData[req.key]; anIndex = anIndex.filter(function (x) { return x.key !== req.key; }); return {};
      case 'analysis.saveMap': anMap = (req.map || []).slice(); return { count: anMap.length };
      case 'analysis.saveRules':
        (req.rules || []).forEach(function (r) { if (!String(r.word || '').trim()) fail('단어가 비어 있는 규칙이 있습니다.'); if (r.action === 'class' && !String(r.cat || '').trim()) fail('분류 규칙은 분류 이름이 필요합니다.'); });
        anRules = JSON.parse(JSON.stringify(req.rules || [])).map(function (r) { r.word = String(r.word).trim(); r.on = r.on !== false; return r; });
        return { rules: anRules };
      case 'admin.dieselHistory': return { rows: dieselRows.slice(), status: dieselStatus() };
      case 'admin.dieselRecordNow': fail('데모 모드에서는 오피넷을 부르지 않습니다.');
      case 'admin.dieselImport':
        var byD = {}; dieselRows.forEach(function (r) { byD[r[0]] = r; });
        (req.rows || []).forEach(function (r) { if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[1] > 0) byD[r[0]] = [r[0], Number(r[1]), '엑셀 가져오기']; });
        dieselRows = Object.keys(byD).sort().map(function (k) { return byD[k]; });
        return { count: (req.rows || []).length, status: dieselStatus() };
      case 'analysis.accessLog': return { logs: anLog.slice(0, 50) };
      case 'admin.saveNews': return { rules: req.rules };
      case 'admin.saveCompanies':
        var nc = {};
        ['조일물류', '명일로지스', '조일로지스'].forEach(function (b) {
          var c = (req.companies || {})[b] || {}; nc[b] = {};
          ['name', 'ceo', 'bizNo', 'addr', 'tel', 'fax', 'email', 'manager', 'bank', 'stamp'].forEach(function (k) { nc[b][k] = String(c[k] || ''); });
          if (nc[b].stamp && !/^data:image\/(png|jpeg|webp);base64,/.test(nc[b].stamp)) fail(b + ' 직인 이미지 형식이 맞지 않습니다.');
        });
        store.companies = nc; save(); return { companies: JSON.parse(JSON.stringify(nc)) };
      case 'admin.createUser':
        var id = String(req.id || '').trim();
        if (!/^[A-Za-z0-9_.-]{3,30}$/.test(id)) fail('아이디는 영문/숫자 3~30자로 입력하세요.');
        if (!String(req.name || '').trim()) fail('이름을 입력하세요.');
        if (store.users.some(function (u) { return u.id === id; })) fail('이미 있는 아이디입니다.');
        var t = temp();
        store.users.push({ id: id, name: String(req.name).trim(), role: req.role === 'admin' ? 'admin' : 'user', perms: req.perms || ['quote'], active: true, mustChange: true, pw: t, createdAt: today(), lastLogin: '' });
        save(); return { tempPassword: t };
      case 'admin.updateUser':
        var uu = user(req.id), p = req.patch || {};
        if (uu.id === me.id && (p.active === false || p.role === 'user')) fail('본인 계정은 중지하거나 권한을 낮출 수 없습니다.');
        if (p.hasOwnProperty('active')) uu.active = !!p.active;
        if (p.role) uu.role = p.role === 'admin' ? 'admin' : 'user';
        if (Array.isArray(p.perms)) uu.perms = p.perms.filter(function (x) { return x === 'quote' || x === 'analysis'; });
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
