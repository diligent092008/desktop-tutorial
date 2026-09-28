/**
 * 조일ver1 — 서버 (구글 Apps Script)
 *
 * 설치 방법은 저장소의 SETUP.md 를 보세요.
 * 이 코드는 대리님 구글 계정에서 실행되며, 단가표·계정·API 키는
 * 이 스프레드시트와 스크립트 속성에만 저장됩니다. (GitHub에는 올라가지 않음)
 */

var SHEET_TARIFF = '타리프';
var SHEET_USERS = '계정';
var SHEET_LOG = '조회기록';
var SESSION_SECONDS = 6 * 60 * 60; // 6시간
var LOGIN_MAX_FAIL = 5;
var HASH_ROUNDS = 300;
var TZ = 'Asia/Seoul';

var USER_COLS = ['아이디', '이름', '권한', '사용여부', '비밀번호해시', '솔트', '비밀번호변경필요', '생성일', '마지막로그인'];

/* ───────────── 메뉴 & 초기 설정 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('조일ver1')
    .addItem('초기 설정 (처음 한 번)', 'setup')
    .addItem('관리자 비밀번호 초기화', 'resetAdminPassword')
    .addToUi();
}

/** 처음 한 번 실행: 시트 생성, 임의 타리프, 기본 설정, 관리자 계정 */
function setup() {
  var ss = SpreadsheetApp.getActive();
  var props = PropertiesService.getScriptProperties();

  if (!ss.getSheetByName(SHEET_TARIFF)) {
    writeTariff_(joilDummyTariff());
  }
  if (!ss.getSheetByName(SHEET_USERS)) {
    var us = ss.insertSheet(SHEET_USERS);
    us.getRange(1, 1, 1, USER_COLS.length).setValues([USER_COLS]).setFontWeight('bold');
    us.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_LOG)) {
    var ls = ss.insertSheet(SHEET_LOG);
    ls.getRange(1, 1, 1, 7).setValues([['일시', '아이디', '이름', '상차지', '하차지', '거리(km)', '비고']]).setFontWeight('bold');
    ls.setFrozenRows(1);
  }
  if (!props.getProperty('SETTINGS')) {
    props.setProperty('SETTINGS', JSON.stringify(joilDefaultSettings()));
  }

  var msg;
  if (!findUser_('admin')) {
    var temp = randomPassword_();
    createUserRow_('admin', '관리자', 'admin', temp);
    msg = '초기 설정 완료!\n\n관리자 아이디: admin\n임시 비밀번호: ' + temp + '\n\n첫 로그인 때 비밀번호를 바꾸게 됩니다. 이 창을 닫기 전에 적어 두세요.';
  } else {
    msg = '이미 설정되어 있습니다. (관리자 계정 있음)';
  }
  notify_(msg);
}

function resetAdminPassword() {
  var temp = randomPassword_();
  var u = findUser_('admin');
  if (!u) { notify_('admin 계정이 없습니다. 먼저 "초기 설정"을 실행하세요.'); return; }
  setPassword_(u.row, temp, true);
  setUserCell_(u.row, '사용여부', '사용');
  dropUserCache_('admin');
  notify_('admin 임시 비밀번호: ' + temp);
}

function notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 편집기에서 실행하면 실행 로그에서 확인 */ }
}

/* ───────────── 웹 요청 처리 ───────────── */

function doGet() {
  return ContentService.createTextOutput('조일ver1 서버가 정상 작동 중입니다.');
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle_(req);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: (err && err.message) || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  var action = String(req.action || '');
  if (action === 'login') return login_(req.id, req.password);

  var session = requireSession_(req.token);
  var allowedBeforeChange = ['me', 'logout', 'changePassword', 'publicSettings'];
  if (session.mustChange && allowedBeforeChange.indexOf(action) === -1) throw new Error('임시 비밀번호입니다. 비밀번호를 먼저 변경하세요.');
  switch (action) {
    case 'me': return { user: session, settings: publicSettings_() };
    case 'logout': CacheService.getScriptCache().remove('S_' + req.token); return {};
    case 'changePassword': return changePassword_(session, req.current, req.next);
    case 'publicSettings': return { settings: publicSettings_() };
    case 'dieselPrice': return dieselPrice_();
    case 'quote': return quote_(session, req);
    case 'quoteBatch': return quoteBatch_(session, req);
  }

  if (session.role !== 'admin') throw new Error('관리자만 사용할 수 있습니다.');
  switch (action) {
    case 'admin.bootstrap': return { settings: getSettings_(), keys: keyStatus_(), users: listUsers_(), logs: getLogs_(200), cache: cacheInfo_() };
    case 'admin.getSettings': return { settings: getSettings_(), keys: keyStatus_() };
    case 'admin.saveSettings': return saveSettings_(req.settings);
    case 'admin.getTariff': return { tariff: readTariff_() };
    case 'admin.saveTariff': return saveTariff_(req.tariff);
    case 'admin.listUsers': return { users: listUsers_() };
    case 'admin.createUser': return createUser_(req.id, req.name, req.role);
    case 'admin.updateUser': return updateUser_(session, req.id, req.patch || {});
    case 'admin.resetPassword': return resetPassword_(req.id);
    case 'admin.getLogs': return { logs: getLogs_(Number(req.limit) || 200) };
    case 'admin.saveKeys': return saveKeys_(req.kakao, req.opinet);
    case 'admin.testKakao': return testKakao_();
    case 'admin.cacheInfo': return { cache: cacheInfo_() };
    case 'admin.clearCache': return { cache: clearCache_() };
  }
  throw new Error('알 수 없는 요청입니다: ' + action);
}

/* ───────────── 로그인 / 세션 ───────────── */

function login_(id, password) {
  id = String(id || '').trim();
  if (!id || !password) throw new Error('아이디와 비밀번호를 입력하세요.');
  var cache = CacheService.getScriptCache();
  var failKey = 'LF_' + id;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAIL) throw new Error('로그인 실패가 많아 10분간 잠겼습니다.');

  var u = findUser_(id);
  if (!u || u.data['사용여부'] !== '사용' || hash_(password, u.data['솔트']) !== u.data['비밀번호해시']) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  cache.remove(failKey);
  setUserCell_(u.row, '마지막로그인', now_());

  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  var session = { id: id, name: u.data['이름'], role: u.data['권한'], mustChange: u.data['비밀번호변경필요'] === 'Y' };
  cache.put('S_' + token, JSON.stringify({ id: id }), SESSION_SECONDS);
  return { token: token, user: session, settings: publicSettings_() };
}

/** 매 요청마다 계정 시트를 다시 확인 → 사용중지하면 즉시 차단 */
function requireSession_(token) {
  if (!token) throw new Error('로그인이 필요합니다.');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('S_' + token);
  if (!raw) throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  var id = JSON.parse(raw).id;
  var u = cachedUser_(id);
  if (!u || !u.active) {
    cache.remove('S_' + token);
    throw new Error('사용이 중지된 계정입니다.');
  }
  cache.put('S_' + token, raw, SESSION_SECONDS);
  return { id: id, name: u.name, role: u.role, mustChange: u.mustChange };
}

/**
 * 계정 정보를 5분간 서버 캐시에 둡니다. (매 요청마다 시트를 열지 않도록)
 * 이 화면에서 계정을 바꾸면 즉시 지워지고, 시트를 직접 고친 경우엔 최대 5분 뒤 반영됩니다.
 */
function cachedUser_(id) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('U_' + id);
  if (hit) return JSON.parse(hit);
  var u = findUser_(id);
  if (!u) return null;
  var v = { name: String(u.data['이름']), role: String(u.data['권한']), active: u.data['사용여부'] === '사용', mustChange: u.data['비밀번호변경필요'] === 'Y' };
  cache.put('U_' + id, JSON.stringify(v), 300);
  return v;
}

function dropUserCache_(id) {
  CacheService.getScriptCache().remove('U_' + id);
}

function changePassword_(session, current, next) {
  var u = findUser_(session.id);
  if (hash_(current || '', u.data['솔트']) !== u.data['비밀번호해시']) throw new Error('현재 비밀번호가 올바르지 않습니다.');
  checkPasswordRule_(next);
  setPassword_(u.row, next, false);
  dropUserCache_(session.id);
  return {};
}

function checkPasswordRule_(pw) {
  pw = String(pw || '');
  if (pw.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('비밀번호에 영문과 숫자를 모두 넣어 주세요.');
}

/* ───────────── 계정 시트 ───────────── */

function usersSheet_() { return SpreadsheetApp.getActive().getSheetByName(SHEET_USERS); }

function findUser_(id) {
  var sh = usersSheet_();
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  var head = values[0];
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(id)) {
      var data = {};
      head.forEach(function (h, i) { data[h] = values[r][i]; });
      return { row: r + 1, data: data };
    }
  }
  return null;
}

function setUserCell_(row, col, value) {
  usersSheet_().getRange(row, USER_COLS.indexOf(col) + 1).setValue(value);
}

function setPassword_(row, pw, mustChange) {
  var salt = Utilities.getUuid();
  setUserCell_(row, '솔트', salt);
  setUserCell_(row, '비밀번호해시', hash_(pw, salt));
  setUserCell_(row, '비밀번호변경필요', mustChange ? 'Y' : 'N');
}

function createUserRow_(id, name, role, pw) {
  var salt = Utilities.getUuid();
  usersSheet_().appendRow([id, name, role, '사용', hash_(pw, salt), salt, 'Y', now_(), '']);
}

function listUsers_() {
  var values = usersSheet_().getDataRange().getValues();
  return values.slice(1).map(function (r) {
    return { id: r[0], name: r[1], role: r[2], active: r[3] === '사용', mustChange: r[6] === 'Y', createdAt: fmt_(r[7]), lastLogin: fmt_(r[8]) };
  });
}

function createUser_(id, name, role) {
  id = String(id || '').trim();
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(id)) throw new Error('아이디는 영문/숫자 3~30자로 입력하세요.');
  if (!name) throw new Error('이름을 입력하세요.');
  if (findUser_(id)) throw new Error('이미 있는 아이디입니다.');
  var temp = randomPassword_();
  createUserRow_(id, name, role === 'admin' ? 'admin' : 'user', temp);
  return { tempPassword: temp };
}

function updateUser_(session, id, patch) {
  var u = findUser_(id);
  if (!u) throw new Error('계정을 찾을 수 없습니다.');
  if (id === session.id && (patch.active === false || patch.role === 'user')) throw new Error('본인 계정은 중지하거나 권한을 낮출 수 없습니다.');
  if (patch.hasOwnProperty('active')) setUserCell_(u.row, '사용여부', patch.active ? '사용' : '중지');
  if (patch.role) setUserCell_(u.row, '권한', patch.role === 'admin' ? 'admin' : 'user');
  if (patch.name) setUserCell_(u.row, '이름', String(patch.name));
  dropUserCache_(id);
  return {};
}

function resetPassword_(id) {
  var u = findUser_(id);
  if (!u) throw new Error('계정을 찾을 수 없습니다.');
  var temp = randomPassword_();
  setPassword_(u.row, temp, true);
  dropUserCache_(id);
  return { tempPassword: temp };
}

/* ───────────── 설정 / 키 ───────────── */

function getSettings_() {
  var raw = PropertiesService.getScriptProperties().getProperty('SETTINGS');
  return joilMergeSettings(raw ? JSON.parse(raw) : null);
}

/** 일반 직원 화면에 필요한 것만 (단가 정보 없음) */
function publicSettings_() {
  var s = getSettings_();
  return {
    tons: s.tons.map(function (t) { return t.name; }),
    fuelMode: s.fuel.mode,
    manualPrice: s.fuel.manualPrice,
    baseTon: s.milkrun.baseTon,
    roundTrip: s.milkrun.roundTrip,
    maxRows: s.batch.maxRows,
    quoteFooter: s.quoteFooter,
    maxKm: s.maxKm
  };
}

function saveSettings_(settings) {
  if (!settings || !Array.isArray(settings.tons) || !Array.isArray(settings.regionRules)) throw new Error('설정 형식이 올바르지 않습니다.');
  var merged = joilMergeSettings(settings);
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(merged));
  return { settings: merged };
}

function keyStatus_() {
  var p = PropertiesService.getScriptProperties();
  return { kakao: !!p.getProperty('KAKAO_REST_KEY'), opinet: !!p.getProperty('OPINET_KEY') };
}

/** 키는 저장만 하고 절대 화면으로 돌려보내지 않습니다. */
function saveKeys_(kakao, opinet) {
  var p = PropertiesService.getScriptProperties();
  if (kakao) p.setProperty('KAKAO_REST_KEY', String(kakao).trim());
  if (opinet) p.setProperty('OPINET_KEY', String(opinet).trim());
  return { keys: keyStatus_() };
}

/* ───────────── 타리프 ───────────── */

function readTariff_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('TARIFF');
  if (hit) return JSON.parse(hit);
  var values = SpreadsheetApp.getActive().getSheetByName(SHEET_TARIFF).getDataRange().getValues();
  var tariff = {
    tons: values[0].slice(1).map(String),
    rows: values.slice(1).map(function (r) { return r.slice(1).map(function (v) { return Number(v) || 0; }); })
  };
  try { cache.put('TARIFF', JSON.stringify(tariff), 21600); } catch (e) { /* 용량 초과 시 캐시 생략 */ }
  return tariff;
}

function writeTariff_(tariff) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_TARIFF) || ss.insertSheet(SHEET_TARIFF);
  sh.clear();
  var header = [['km'].concat(tariff.tons)];
  var body = tariff.rows.map(function (r, i) { return [i + 1].concat(r); });
  sh.getRange(1, 1, 1, header[0].length).setValues(header).setFontWeight('bold');
  sh.getRange(2, 1, body.length, header[0].length).setValues(body);
  sh.getRange(2, 2, body.length, tariff.tons.length).setNumberFormat('#,##0');
  sh.setFrozenRows(1);
  CacheService.getScriptCache().remove('TARIFF');
}

function saveTariff_(tariff) {
  var s = getSettings_();
  var err = joilValidateTariff(tariff, s.tons.length, Number(s.maxKm) || 600);
  if (err) throw new Error(err);
  tariff.tons = s.tons.map(function (t) { return t.name; });
  tariff.rows = tariff.rows.map(function (r) { return r.map(Number); });
  writeTariff_(tariff);
  return {};
}

/* ───────────── 견적 ───────────── */

var BATCH_CHUNK_MAX = 50;          // 한 번 요청에 받는 최대 경로 수 (화면은 20개씩 보냄)
var SHEET_GEO_CACHE = '주소캐시';
var SHEET_ROUTE_CACHE = '경로캐시';

/** 단건 견적 */
function quote_(session, req) {
  var originQ = joilNormalizeAddress(req.origin);
  var destQ = joilNormalizeAddress(req.dest);
  if (!originQ || !destQ) throw new Error('상차지와 하차지를 모두 입력하세요.');
  var out = quoteMany_([{ origin: originQ, dest: destQ }], req);
  var item = out.items[0];
  if (item.error) throw new Error(item.error);
  log_(session, item.result.origin.address, item.result.dest.address, item.result.distanceKm, '');
  return { result: item.result };
}

/**
 * 대량 견적 (화면이 20건씩 나눠 여러 번 동시에 보냄)
 * req.pairs: [{ origin, dest }], req.batch: { index, total, count } — 첫 묶음일 때만 기록 1줄
 */
function quoteBatch_(session, req) {
  var pairs = (req.pairs || []).map(function (p) {
    return { origin: joilNormalizeAddress(p.origin), dest: joilNormalizeAddress(p.dest) };
  });
  if (!pairs.length) throw new Error('계산할 경로가 없습니다.');
  if (pairs.length > BATCH_CHUNK_MAX) throw new Error('한 번에 ' + BATCH_CHUNK_MAX + '건까지만 보낼 수 있습니다.');
  var s = getSettings_();
  var b = req.batch || {};
  if (Number(b.count) > Number(s.batch.maxRows)) throw new Error('대량 계산은 최대 ' + s.batch.maxRows + '건까지입니다.');

  var out = quoteMany_(pairs, req);
  if (Number(b.index) === 0) {
    var origins = {};
    pairs.forEach(function (p) { origins[p.origin] = true; });
    var originText = Object.keys(origins).length === 1 ? pairs[0].origin : '여러 상차지';
    log_(session, originText, '하차지 ' + (Number(b.count) || pairs.length) + '곳', '', '대량 ' + (Number(b.count) || pairs.length) + '건');
  }
  return out;
}

/** 공통: 주소 → 좌표 → 경로 → 계산. 한 건이 실패해도 나머지는 계속합니다. */
function quoteMany_(pairs, req) {
  var s = getSettings_();
  var tariff = readTariff_();
  var baseTon = joilFindTon(s, req.baseTon) || joilFindTon(s, s.milkrun.baseTon) || s.tons[0];
  var tollClass = Number(baseTon.tollClass) || 1;

  var diesel = (req.dieselMode === 'manual' && Number(req.dieselPrice) > 0)
    ? { price: Number(req.dieselPrice), source: '직접 입력' }
    : dieselPrice_();

  var queries = [];
  pairs.forEach(function (p) { queries.push(p.origin, p.dest); });
  var points = geocodeMany_(queries);

  var routeReqs = [];
  pairs.forEach(function (p) {
    var o = points[p.origin], d = points[p.dest];
    if (o && !o.error && d && !d.error) routeReqs.push({ origin: o, dest: d });
  });
  var routes = routeMany_(routeReqs, tollClass);

  var items = pairs.map(function (p) {
    var o = points[p.origin], d = points[p.dest];
    if (!o || o.error) return { error: '상차지: ' + ((o && o.error) || '주소를 찾지 못했습니다') };
    if (!d || d.error) return { error: '하차지: ' + ((d && d.error) || '주소를 찾지 못했습니다') };
    var r = routes[routeKey_(o, d, tollClass)];
    if (!r || r.error) return { error: (r && r.error) || '경로를 찾지 못했습니다' };
    var result = joilComputeQuote({
      origin: o, dest: d, distanceKm: r.km, toll: r.toll, dieselPrice: diesel.price, baseTon: baseTon.name
    }, s, tariff);
    result.origin = o;
    result.dest = d;
    result.dieselSource = diesel.source;
    return { result: result };
  });
  return { items: items, diesel: diesel, baseTon: baseTon.name };
}

function log_(session, from, to, km, note) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  if (sh) sh.appendRow([now_(), session.id, session.name, from, to, km, note]);
}

function getLogs_(limit) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(limit, last - 1);
  var values = sh.getRange(last - n + 1, 1, n, 7).getValues().reverse();
  return values.map(function (r) { return { at: fmt_(r[0]), id: r[1], name: r[2], from: r[3], to: r[4], km: r[5], note: r[6] }; });
}

/* ───────────── 영구 캐시 (시트) ───────────── */
/*
 * 조회한 주소와 경로는 시트에 계속 저장해 두고 다시 씁니다. → 같은 상차지에서 전국으로 보내는 반복 견적이 빠르고
 * 카카오 호출도 줄어듭니다. 도로·요금이 바뀌었다고 생각되면 관리자 > API 키 > "캐시 비우기".
 * 빠른 조회를 위해 스크립트 캐시(6시간)를 앞에 한 겹 더 둡니다.
 */

function cacheSheet_(name, header) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** keys → { key: value } (스크립트 캐시 → 시트 순서로 찾음) */
function cacheGetMany_(prefix, sheetName, header, keys, parseRow) {
  var found = {};
  if (!keys.length) return found;
  var sc = CacheService.getScriptCache();
  var hashed = {};
  keys.forEach(function (k) { hashed[prefix + md5_(k)] = k; });
  var hits = sc.getAll(Object.keys(hashed));
  Object.keys(hits).forEach(function (hk) { found[hashed[hk]] = JSON.parse(hits[hk]); });

  var missing = keys.filter(function (k) { return !found.hasOwnProperty(k); });
  if (!missing.length) return found;
  var sh = cacheSheet_(sheetName, header);
  var last = sh.getLastRow();
  if (last < 2) return found;
  var want = {};
  missing.forEach(function (k) { want[k] = true; });
  var warm = {};
  sh.getRange(2, 1, last - 1, header.length).getValues().forEach(function (row) {
    var k = String(row[0]);
    if (want[k]) { found[k] = parseRow(row); warm[prefix + md5_(k)] = JSON.stringify(found[k]); }
  });
  if (Object.keys(warm).length) sc.putAll(warm, 21600);
  return found;
}

function cachePutMany_(prefix, sheetName, header, entries) {
  if (!entries.length) return;
  var sc = CacheService.getScriptCache();
  var warm = {};
  entries.forEach(function (e) { warm[prefix + md5_(e.key)] = JSON.stringify(e.value); });
  sc.putAll(warm, 21600);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return; // 저장 못 해도 계산 결과에는 영향 없음
  try {
    var sh = cacheSheet_(sheetName, header);
    var rows = entries.map(function (e) { return e.row; });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
}

var GEO_HEADER = ['주소(입력)', '위도', '경도', '시도', '찾은 주소', '저장일'];
var ROUTE_HEADER = ['경로키', '거리(km)', '통행료', '저장일'];

function cacheInfo_() {
  var ss = SpreadsheetApp.getActive();
  var g = ss.getSheetByName(SHEET_GEO_CACHE), r = ss.getSheetByName(SHEET_ROUTE_CACHE);
  return { addresses: g ? Math.max(0, g.getLastRow() - 1) : 0, routes: r ? Math.max(0, r.getLastRow() - 1) : 0 };
}

function clearCache_() {
  var ss = SpreadsheetApp.getActive();
  [SHEET_GEO_CACHE, SHEET_ROUTE_CACHE].forEach(function (n) { var sh = ss.getSheetByName(n); if (sh) ss.deleteSheet(sh); });
  // 스크립트 캐시는 키를 모두 알 수 없으므로 접두어를 바꿔서 무효화
  PropertiesService.getScriptProperties().setProperty('CACHE_GEN', String(Date.now()));
  return cacheInfo_();
}

function cacheGen_() {
  return PropertiesService.getScriptProperties().getProperty('CACHE_GEN') || '0';
}

/* ───────────── 카카오 API ───────────── */

function kakaoKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('KAKAO_REST_KEY');
  if (!key) throw new Error('카카오 REST 키가 설정되지 않았습니다. 관리자 > API 키에서 입력하세요.');
  return key;
}

/**
 * 여러 요청을 동시에 보내고, 한도 초과(429)나 일시 오류(5xx)는 1초 쉬고 한 번 더 시도합니다.
 * 반환: [{ code, json }]
 */
function fetchAllKakao_(urls) {
  var key = kakaoKey_();
  var out = new Array(urls.length);
  var todo = urls.map(function (u, i) { return i; });
  for (var attempt = 0; attempt < 2 && todo.length; attempt++) {
    if (attempt > 0) Utilities.sleep(1200);
    var res = UrlFetchApp.fetchAll(todo.map(function (i) {
      return { url: urls[i], headers: { Authorization: 'KakaoAK ' + key }, muteHttpExceptions: true };
    }));
    var retry = [];
    res.forEach(function (r, j) {
      var i = todo[j], code = r.getResponseCode();
      if ((code === 429 || code >= 500) && attempt === 0) { retry.push(i); return; }
      var json = null;
      try { json = JSON.parse(r.getContentText()); } catch (e) { /* 무시 */ }
      out[i] = { code: code, json: json };
    });
    todo = retry;
  }
  return out;
}

function kakaoError_(code) {
  if (code === 401 || code === 403) return '카카오 키 인증 실패 (키와 사용 설정을 확인하세요)';
  if (code === 429) return '카카오 호출 한도 초과 (잠시 후 다시 시도)';
  return '카카오 API 오류 (' + code + ')';
}

/** 주소 여러 개 → { 주소: point | {error} } */
function geocodeMany_(queries) {
  var uniq = [];
  var seen = {};
  queries.forEach(function (q) { if (q && !seen[q]) { seen[q] = true; uniq.push(q); } });
  var prefix = 'G' + cacheGen_() + '_';
  var found = cacheGetMany_(prefix, SHEET_GEO_CACHE, GEO_HEADER, uniq, function (row) {
    return { lat: Number(row[1]), lng: Number(row[2]), sido: String(row[3]), address: String(row[4]) };
  });
  var missing = uniq.filter(function (q) { return !found[q]; });
  if (!missing.length) return found;

  // 1차: 주소 검색
  var res = fetchAllKakao_(missing.map(function (q) {
    return 'https://dapi.kakao.com/v2/local/search/address.json?size=1&query=' + encodeURIComponent(q);
  }));
  var needKeyword = [];
  res.forEach(function (r, i) {
    var q = missing[i];
    if (r.code !== 200) { found[q] = { error: kakaoError_(r.code) }; return; }
    var doc = r.json.documents && r.json.documents[0];
    if (!doc) { needKeyword.push(q); return; }
    var region = doc.address || doc.road_address || {};
    found[q] = { lat: Number(doc.y), lng: Number(doc.x), sido: region.region_1depth_name || firstToken_(doc.address_name), address: doc.address_name };
  });

  // 2차: 주소로 안 나오면 장소(키워드) 검색 — 예) "쿠팡 평택1센터"
  if (needKeyword.length) {
    fetchAllKakao_(needKeyword.map(function (q) {
      return 'https://dapi.kakao.com/v2/local/search/keyword.json?size=1&query=' + encodeURIComponent(q);
    })).forEach(function (r, i) {
      var q = needKeyword[i];
      if (r.code !== 200) { found[q] = { error: kakaoError_(r.code) }; return; }
      var doc = r.json.documents && r.json.documents[0];
      if (!doc) { found[q] = { error: '주소를 찾지 못했습니다 ("' + q + '")' }; return; }
      found[q] = {
        lat: Number(doc.y), lng: Number(doc.x), sido: firstToken_(doc.address_name),
        address: doc.address_name + (doc.place_name ? ' (' + doc.place_name + ')' : '')
      };
    });
  }

  var today = now_();
  cachePutMany_(prefix, SHEET_GEO_CACHE, GEO_HEADER, missing.filter(function (q) { return found[q] && !found[q].error; }).map(function (q) {
    var p = found[q];
    return { key: q, value: p, row: [q, p.lat, p.lng, p.sido, p.address, today] };
  }));
  return found;
}

function routeKey_(o, d, tollClass) {
  return o.lng.toFixed(6) + ',' + o.lat.toFixed(6) + '>' + d.lng.toFixed(6) + ',' + d.lat.toFixed(6) + '#' + tollClass;
}

/** 경로 여러 개 → { 경로키: { km, toll } | {error} }  (기준 톤수 차종으로 1번씩만 조회) */
function routeMany_(list, tollClass) {
  var keys = [], byKey = {};
  list.forEach(function (x) {
    var k = routeKey_(x.origin, x.dest, tollClass);
    if (!byKey[k]) { byKey[k] = x; keys.push(k); }
  });
  var prefix = 'R' + cacheGen_() + '_';
  var found = cacheGetMany_(prefix, SHEET_ROUTE_CACHE, ROUTE_HEADER, keys, function (row) {
    return { km: Number(row[1]), toll: Number(row[2]) };
  });
  var missing = keys.filter(function (k) { return !found[k]; });
  if (!missing.length) return found;

  var res = fetchAllKakao_(missing.map(function (k) {
    var x = byKey[k];
    return 'https://apis-navi.kakaomobility.com/v1/directions?summary=true&priority=RECOMMEND&car_fuel=DIESEL&car_type=' + tollClass +
      '&origin=' + x.origin.lng + ',' + x.origin.lat + '&destination=' + x.dest.lng + ',' + x.dest.lat;
  }));
  var fresh = [];
  var today = now_();
  res.forEach(function (r, i) {
    var k = missing[i];
    if (r.code !== 200) { found[k] = { error: kakaoError_(r.code) }; return; }
    var route = r.json && r.json.routes && r.json.routes[0];
    if (!route || route.result_code !== 0) { found[k] = { error: '경로 없음: ' + ((route && route.result_msg) || '알 수 없음') }; return; }
    var v = { km: route.summary.distance / 1000, toll: (route.summary.fare && route.summary.fare.toll) || 0 };
    found[k] = v;
    fresh.push({ key: k, value: v, row: [k, v.km, v.toll, today] });
  });
  cachePutMany_(prefix, SHEET_ROUTE_CACHE, ROUTE_HEADER, fresh);
  return found;
}

function testKakao_() {
  var p = geocodeMany_(['서울특별시 중구 세종대로 110'])['서울특별시 중구 세종대로 110'];
  if (p.error) throw new Error(p.error);
  return { message: '카카오 연결 정상: ' + p.address };
}

/* ───────────── 경유가 (오피넷) ───────────── */

function dieselPrice_() {
  var s = getSettings_();
  var manual = { price: Number(s.fuel.manualPrice) || 0, source: '관리자 기본값' };
  if (s.fuel.mode !== 'auto') return manual;
  var key = PropertiesService.getScriptProperties().getProperty('OPINET_KEY');
  if (!key) return manual;

  var cache = CacheService.getScriptCache();
  var hit = cache.get('DIESEL');
  if (hit) return JSON.parse(hit);
  try {
    var res = UrlFetchApp.fetch('https://www.opinet.co.kr/api/avgAllPrice.do?out=json&code=' + encodeURIComponent(key), { muteHttpExceptions: true });
    var oils = JSON.parse(res.getContentText()).RESULT.OIL;
    var d = oils.filter(function (o) { return o.PRODCD === 'D047'; })[0];
    var out = { price: Math.round(Number(d.PRICE)), source: '오피넷 전국평균 (' + d.TRADE_DT + ')' };
    cache.put('DIESEL', JSON.stringify(out), 3 * 60 * 60);
    return out;
  } catch (e) {
    manual.source = '관리자 기본값 (오피넷 조회 실패)';
    return manual;
  }
}

/* ───────────── 도구 ───────────── */

function hash_(pw, salt) {
  var h = String(salt) + ':' + String(pw);
  for (var i = 0; i < HASH_ROUNDS; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + String(salt), Utilities.Charset.UTF_8));
  }
  return h;
}

function md5_(s) {
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}

function toHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function randomPassword_() {
  var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  for (var i = 0; i < 10; i++) out += chars.charAt((bytes[i] & 0xff) % chars.length);
  return out + '7';
}

function firstToken_(s) { return String(s || '').split(' ')[0]; }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function fmt_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v || ''); }
