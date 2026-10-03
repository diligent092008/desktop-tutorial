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

var USER_COLS = ['아이디', '이름', '권한', '사용여부', '비밀번호해시', '솔트', '비밀번호변경필요', '생성일', '마지막로그인', '메뉴권한'];

/* 메뉴 권한: quote(견적 계산·조회기록·견적모음), analysis(매출매입 분석). 관리자는 전부. */
var PERMS = ['quote', 'analysis'];
function permsOf_(role, raw) {
  if (role === 'admin') return ['quote', 'analysis', 'admin'];
  if (raw == null || raw === '') return ['quote']; // 예전에 만든 계정은 견적만
  return String(raw).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return PERMS.indexOf(x) !== -1; });
}
function requirePerm_(session, perm) {
  if (session.perms.indexOf(perm) === -1) throw new Error(perm === 'analysis' ? '분석 메뉴 권한이 없습니다. 관리자에게 요청하세요.' : '견적 메뉴 권한이 없습니다. 관리자에게 요청하세요.');
}

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
    ls.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
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
  }

  var QUOTE_ACTIONS = ['dieselPrice', 'quote', 'quoteBatch', 'history.list', 'history.get', 'quotes.save', 'quotes.list', 'quotes.get', 'quotes.update', 'quotes.delete'];
  if (QUOTE_ACTIONS.indexOf(action) !== -1) requirePerm_(session, 'quote');
  if (action === 'analysis.index' || action === 'analysis.load') requirePerm_(session, 'analysis');
  switch (action) {
    case 'analysis.index': return analysisIndex_(session);
    case 'analysis.load': return analysisLoad_(req.keys);
    case 'dieselPrice': return dieselPrice_();
    case 'quote': return quote_(session, req);
    case 'quoteBatch': return quoteBatch_(session, req);
    case 'history.list': return historyList_(session, req);
    case 'history.get': return historyGet_(session, req.recordId);
    case 'quotes.save': return quotesSave_(session, req);
    case 'quotes.list': return quotesList_(session, req);
    case 'quotes.get': return quotesGet_(session, req.id);
    case 'quotes.update': return quotesUpdate_(session, req.id, req.patch);
    case 'quotes.delete': return quotesDelete_(session, req.id);
  }

  if (session.role !== 'admin') throw new Error('관리자만 사용할 수 있습니다.');
  switch (action) {
    case 'admin.bootstrap': cleanupSnapshots_(); return { settings: getSettings_(), keys: keyStatus_(), users: listUsers_(), logs: getLogs_(200), cache: cacheInfo_() };
    case 'admin.getSettings': return { settings: getSettings_(), keys: keyStatus_() };
    case 'admin.saveSettings': return saveSettings_(req.settings);
    case 'admin.getTariff': return { tariff: readTariff_() };
    case 'admin.saveTariff': return saveTariff_(req.tariff);
    case 'admin.listUsers': return { users: listUsers_() };
    case 'admin.createUser': return createUser_(req.id, req.name, req.role, req.perms);
    case 'admin.updateUser': return updateUser_(session, req.id, req.patch || {});
    case 'admin.resetPassword': return resetPassword_(req.id);
    case 'admin.getLogs': return { logs: getLogs_(Number(req.limit) || 200) };
    case 'admin.saveKeys': return saveKeys_(req.kakao, req.opinet);
    case 'admin.testKakao': return testKakao_();
    case 'admin.cacheInfo': return { cache: cacheInfo_() };
    case 'admin.clearCache': return { cache: clearCache_() };
    case 'analysis.upload': return analysisUpload_(session, req);
    case 'analysis.delete': return analysisDelete_(req.key);
    case 'analysis.saveMap': return analysisSaveMap_(req.map);
    case 'analysis.accessLog': return { logs: analysisAccessLog_(50) };
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
  var session = { id: id, name: u.data['이름'], role: u.data['권한'], mustChange: u.data['비밀번호변경필요'] === 'Y', perms: permsOf_(u.data['권한'], u.data['메뉴권한']) };
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
  return { id: id, name: u.name, role: u.role, mustChange: u.mustChange, perms: permsOf_(u.role, u.perms) };
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
  var v = { name: String(u.data['이름']), role: String(u.data['권한']), active: u.data['사용여부'] === '사용', mustChange: u.data['비밀번호변경필요'] === 'Y', perms: u.data['메뉴권한'] == null ? '' : String(u.data['메뉴권한']) };
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

function usersSheet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_USERS);
  if (sh && String(sh.getRange(1, USER_COLS.length).getValue()) !== USER_COLS[USER_COLS.length - 1]) {
    sh.getRange(1, 1, 1, USER_COLS.length).setValues([USER_COLS]).setFontWeight('bold');
  }
  return sh;
}

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

function createUserRow_(id, name, role, pw, perms) {
  var salt = Utilities.getUuid();
  usersSheet_().appendRow([id, name, role, '사용', hash_(pw, salt), salt, 'Y', now_(), '', perms || 'quote']);
}

function permsToCell_(list) {
  var p = (list || []).filter(function (x) { return PERMS.indexOf(x) !== -1; });
  return p.length ? p.join(',') : 'none';
}

function listUsers_() {
  var values = usersSheet_().getDataRange().getValues();
  return values.slice(1).map(function (r) {
    return { id: r[0], name: r[1], role: r[2], active: r[3] === '사용', mustChange: r[6] === 'Y', createdAt: fmt_(r[7]), lastLogin: fmt_(r[8]), perms: permsOf_(r[2], r[9]) };
  });
}

function createUser_(id, name, role, perms) {
  id = String(id || '').trim();
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(id)) throw new Error('아이디는 영문/숫자 3~30자로 입력하세요.');
  if (!name) throw new Error('이름을 입력하세요.');
  if (findUser_(id)) throw new Error('이미 있는 아이디입니다.');
  var temp = randomPassword_();
  createUserRow_(id, name, role === 'admin' ? 'admin' : 'user', temp, permsToCell_(perms || ['quote']));
  return { tempPassword: temp };
}

function updateUser_(session, id, patch) {
  var u = findUser_(id);
  if (!u) throw new Error('계정을 찾을 수 없습니다.');
  if (id === session.id && (patch.active === false || patch.role === 'user')) throw new Error('본인 계정은 중지하거나 권한을 낮출 수 없습니다.');
  if (patch.hasOwnProperty('active')) setUserCell_(u.row, '사용여부', patch.active ? '사용' : '중지');
  if (patch.role) setUserCell_(u.row, '권한', patch.role === 'admin' ? 'admin' : 'user');
  if (patch.name) setUserCell_(u.row, '이름', String(patch.name));
  if (Array.isArray(patch.perms)) setUserCell_(u.row, '메뉴권한', permsToCell_(patch.perms));
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
    retentionDays: s.snapshot.retentionDays,
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
  var recordId = newId_('R');
  var r = item.result;
  log_(session, r.origin.address, r.dest.address, r.distanceKm, '', recordId, '단건', 1);
  saveSnapshotSafe_(recordId, session, snapshotMeta_(session, '단건', 1, out), [{ no: 1, origin: originQ, dest: destQ, result: r }]);
  return { result: r, recordId: recordId };
}

/**
 * 대량 견적 (화면이 20건씩 나눠 여러 번 동시에 보냄)
 * req.pairs: [{ no, origin, dest }], req.batch: { id, index, total, count } — 첫 묶음일 때만 기록 1줄
 * 묶음마다 결과를 같은 기록ID로 스냅샷에 쌓아 둡니다.
 */
function quoteBatch_(session, req) {
  var pairs = (req.pairs || []).map(function (p, i) {
    return { no: Number(p.no) || i + 1, origin: joilNormalizeAddress(p.origin), dest: joilNormalizeAddress(p.dest) };
  });
  if (!pairs.length) throw new Error('계산할 경로가 없습니다.');
  if (pairs.length > BATCH_CHUNK_MAX) throw new Error('한 번에 ' + BATCH_CHUNK_MAX + '건까지만 보낼 수 있습니다.');
  var s = getSettings_();
  var b = req.batch || {};
  var count = Number(b.count) || pairs.length;
  if (count > Number(s.batch.maxRows)) throw new Error('대량 계산은 최대 ' + s.batch.maxRows + '건까지입니다.');
  var recordId = /^[A-Za-z0-9_-]{6,40}$/.test(String(b.id || '')) ? String(b.id) : null;

  var out = quoteMany_(pairs, req);
  if (Number(b.index) === 0) {
    var origins = {};
    pairs.forEach(function (p) { origins[p.origin] = true; });
    var originText = Object.keys(origins).length === 1 ? pairs[0].origin : '여러 상차지';
    log_(session, originText, '하차지 ' + count + '곳', '', '대량 ' + count + '건', recordId || '', '대량', count);
  }
  if (recordId) {
    saveSnapshotSafe_(recordId, session, snapshotMeta_(session, '대량', count, out), pairs.map(function (p, i) {
      var it = out.items[i];
      return { no: p.no, origin: p.origin, dest: p.dest, result: it.result || null, error: it.error || null };
    }));
  }
  out.recordId = recordId;
  return out;
}

/* ───────────── 조회기록 ───────────── */

var LOG_HEADER = ['일시', '아이디', '이름', '상차지', '하차지', '거리(km)', '비고', '기록ID', '종류', '건수'];

function logSheet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  if (sh && String(sh.getRange(1, 8).getValue()) !== '기록ID') {
    sh.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
  }
  return sh;
}

function log_(session, from, to, km, note, recordId, type, count) {
  var sh = logSheet_();
  if (sh) sh.appendRow([now_(), session.id, session.name, from, to, km, note, recordId || '', type || '', count || '']);
}

function logRowToObj_(r) {
  return { at: fmt_(r[0]), id: String(r[1]), name: String(r[2]), from: r[3], to: r[4], km: r[5], note: r[6], recordId: String(r[7] || ''), type: String(r[8] || ''), count: r[9] };
}

function getLogs_(limit) {
  var sh = logSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(limit, last - 1);
  return sh.getRange(last - n + 1, 1, n, LOG_HEADER.length).getValues().reverse().map(logRowToObj_);
}

/** 조회기록 목록: 직원은 본인 것만, 관리자는 전체 (+사용자 필터) */
function historyList_(session, req) {
  cleanupSnapshots_();
  var sh = logSheet_();
  var last = sh.getLastRow();
  var isAdmin = session.role === 'admin';
  var days = Number(req.days) || 0;
  var since = days ? Date.now() - days * 86400000 : 0;
  var q = String(req.q || '').trim();
  var who = isAdmin ? String(req.userId || '') : session.id;
  var type = String(req.type || '');
  var limit = Math.min(Number(req.limit) || 300, 1000);

  var snapIds = snapshotIdSet_();
  var out = [];
  if (last >= 2) {
    var values = sh.getRange(2, 1, last - 1, LOG_HEADER.length).getValues();
    for (var i = values.length - 1; i >= 0 && out.length < limit; i--) {
      var r = values[i];
      var t = r[0] instanceof Date ? r[0].getTime() : Date.parse(String(r[0]).replace(' ', 'T') + '+09:00');
      if (since && t < since) break; // 아래로 갈수록 오래된 기록
      var o = logRowToObj_(r);
      if (who && o.id !== who) continue;
      if (type && (o.type || (o.note && /^대량/.test(o.note) ? '대량' : '단건')) !== type) continue;
      if (q && (o.from + ' ' + o.to + ' ' + o.name + ' ' + o.id).indexOf(q) === -1) continue;
      o.hasSnapshot = !!(o.recordId && snapIds[o.recordId]);
      out.push(o);
    }
  }
  var res = { logs: out };
  if (isAdmin) res.users = listUsers_().map(function (u) { return { id: u.id, name: u.name }; });
  return res;
}

function findLogByRecord_(recordId) {
  var sh = logSheet_();
  if (!recordId || sh.getLastRow() < 2) return null;
  var hit = sh.getRange(2, 8, sh.getLastRow() - 1, 1).createTextFinder(recordId).matchEntireCell(true).findNext();
  if (!hit) return null;
  return logRowToObj_(sh.getRange(hit.getRow(), 1, 1, LOG_HEADER.length).getValues()[0]);
}

function historyGet_(session, recordId) {
  var log = findLogByRecord_(String(recordId || ''));
  if (!log) throw new Error('기록을 찾을 수 없습니다.');
  if (session.role !== 'admin' && log.id !== session.id) throw new Error('본인 기록만 볼 수 있습니다.');
  var snap = readPacked_(SHEET_SNAP, log.recordId);
  if (!snap) throw new Error('보관 기간(' + getSettings_().snapshot.retentionDays + '일)이 지나 상세 내용이 삭제된 기록입니다.');
  return { log: log, meta: snap.meta, items: snap.items };
}

/* ───────────── 스냅샷 (그때 결과 그대로 보관) ───────────── */
/*
 * 결과를 압축(gzip+base64)해서 시트 한 칸에 넣습니다. 한 칸 제한(5만 자)을 넘으면 나눠서 여러 줄로 저장.
 * 스냅샷: 기록ID | 저장시각(ms) | 아이디 | 데이터       견적데이터: 견적ID | 저장시각 | 아이디 | 데이터
 */

var SHEET_SNAP = '스냅샷';
var SHEET_QUOTES = '견적모음';
var SHEET_QDATA = '견적데이터';
var PACK_HEADER = ['ID', '저장시각', '아이디', '데이터'];
var CELL_LIMIT = 45000;

function newId_(prefix) {
  return prefix + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Utilities.getUuid().replace(/-/g, '').slice(0, 5);
}

function packJson_(obj) {
  var blob = Utilities.newBlob(JSON.stringify(obj), 'application/json');
  return Utilities.base64Encode(Utilities.gzip(blob).getBytes());
}

function unpackJson_(s) {
  var blob = Utilities.newBlob(Utilities.base64Decode(String(s)), 'application/x-gzip');
  return JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
}

function snapshotMeta_(session, type, count, out) {
  var s = getSettings_();
  return {
    type: type, at: now_(), user: { id: session.id, name: session.name }, count: count,
    baseTon: out.baseTon, diesel: out.diesel, roundTrip: !!s.milkrun.roundTrip,
    tons: s.tons.map(function (t) { return t.name; })
  };
}

/** items를 한 칸에 들어가는 크기로 나눠 [데이터문자열] 반환 */
function packChunks_(meta, items) {
  var packed = packJson_({ meta: meta, items: items });
  if (packed.length <= CELL_LIMIT || items.length <= 1) return [packed];
  var half = Math.ceil(items.length / 2);
  return packChunks_(meta, items.slice(0, half)).concat(packChunks_(meta, items.slice(half)));
}

function appendPacked_(sheetName, id, userId, meta, items) {
  var sh = cacheSheet_(sheetName, PACK_HEADER);
  var now = Date.now();
  var rows = packChunks_(meta, items).map(function (d) { return [id, now, userId, d]; });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, PACK_HEADER.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
}

/** 스냅샷 저장이 실패해도 견적 계산 결과는 그대로 돌려줍니다. */
function saveSnapshotSafe_(recordId, session, meta, items) {
  try { appendPacked_(SHEET_SNAP, recordId, session.id, meta, items); } catch (e) { Logger.log('스냅샷 저장 실패: ' + e); }
}

function packedRows_(sheetName, id) {
  var sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findAll().map(function (rg) { return rg.getRow(); });
}

/** 같은 ID로 나뉘어 저장된 줄을 합칩니다. 같은 번호는 나중 것(재계산 성공분)이 우선. */
function readPacked_(sheetName, id) {
  var rows = packedRows_(sheetName, id);
  if (!rows.length) return null;
  var sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  var meta = null, byNo = {};
  rows.forEach(function (row) {
    var d = unpackJson_(sh.getRange(row, 4).getValue());
    meta = meta || d.meta;
    d.items.forEach(function (it) {
      var prev = byNo[it.no];
      if (!prev || it.result || !prev.result) byNo[it.no] = it;
    });
  });
  var items = Object.keys(byNo).map(function (k) { return byNo[k]; }).sort(function (a, b) { return a.no - b.no; });
  return { meta: meta, items: items };
}

function snapshotIdSet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SNAP);
  var set = {};
  if (!sh || sh.getLastRow() < 2) return set;
  sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { set[r[0]] = true; });
  return set;
}

/** 보관 기간이 지난 스냅샷 삭제 (하루 한 번만 실제로 검사) */
function cleanupSnapshots_() {
  var props = PropertiesService.getScriptProperties();
  var lastRun = Number(props.getProperty('SNAP_CLEAN_AT') || 0);
  if (Date.now() - lastRun < 86400000) return;
  props.setProperty('SNAP_CLEAN_AT', String(Date.now()));
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SNAP);
  if (!sh || sh.getLastRow() < 2) return;
  var cutoff = Date.now() - Number(getSettings_().snapshot.retentionDays || 90) * 86400000;
  var times = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  var n = 0;
  while (n < times.length && Number(times[n][0]) < cutoff) n++;
  if (n) sh.deleteRows(2, n);
}

/* ───────────── 견적모음 ───────────── */

var QUOTE_HEADER = ['견적ID', '저장일', '아이디', '이름', '견적명', '거래처', '메모', '상태', '종류', '건수', '상차지', '하차지', '원본기록ID', '조회일', '수정일'];
var QUOTE_STATUS = ['작성', '제출', '수주', '미수주'];

function quotesSheet_() { return cacheSheet_(SHEET_QUOTES, QUOTE_HEADER); }

function quoteRowToObj_(r) {
  return {
    id: String(r[0]), savedAt: fmt_(r[1]), userId: String(r[2]), userName: String(r[3]), name: String(r[4]), client: String(r[5]),
    memo: String(r[6]), status: String(r[7]), type: String(r[8]), count: r[9], from: String(r[10]), to: String(r[11]),
    recordId: String(r[12]), queriedAt: fmt_(r[13]), updatedAt: fmt_(r[14])
  };
}

function findQuote_(id) {
  var sh = quotesSheet_();
  if (!id || sh.getLastRow() < 2) return null;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return null;
  return { row: hit.getRow(), data: quoteRowToObj_(sh.getRange(hit.getRow(), 1, 1, QUOTE_HEADER.length).getValues()[0]) };
}

function checkQuoteFields_(f) {
  var name = String(f.name || '').trim();
  if (!name) throw new Error('견적명을 입력하세요.');
  if (name.length > 100) throw new Error('견적명은 100자 이내로 입력하세요.');
  var status = QUOTE_STATUS.indexOf(f.status) !== -1 ? f.status : '작성';
  return { name: name, client: String(f.client || '').trim().slice(0, 100), memo: String(f.memo || '').slice(0, 2000), status: status };
}

function quotesSave_(session, req) {
  var log = findLogByRecord_(String(req.recordId || ''));
  if (!log) throw new Error('저장할 조회 기록을 찾을 수 없습니다.');
  if (session.role !== 'admin' && log.id !== session.id) throw new Error('본인 조회만 저장할 수 있습니다.');
  var snap = readPacked_(SHEET_SNAP, log.recordId);
  if (!snap) throw new Error('보관 기간이 지나 저장할 수 없는 기록입니다.');
  var f = checkQuoteFields_(req);
  var id = newId_('E');
  appendPacked_(SHEET_QDATA, id, session.id, snap.meta, snap.items);
  var isBatch = snap.meta.type === '대량';
  var first = snap.items[0] || {};
  var origins = {};
  snap.items.forEach(function (it) { origins[it.origin] = true; });
  var from = isBatch ? (Object.keys(origins).length === 1 ? first.origin : '여러 상차지') : (first.result ? first.result.origin.address : first.origin);
  var to = isBatch ? '하차지 ' + snap.items.length + '곳' : (first.result ? first.result.dest.address : first.dest);
  var now = now_();
  quotesSheet_().appendRow([id, now, session.id, session.name, f.name, f.client, f.memo, f.status, snap.meta.type, snap.items.length, from, to, log.recordId, log.at, now]);
  return { quote: findQuote_(id).data };
}

function quotesList_(session, req) {
  var sh = quotesSheet_();
  var isAdmin = session.role === 'admin';
  var q = String(req.q || '').trim();
  var out = [];
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, QUOTE_HEADER.length).getValues().forEach(function (r) {
      var o = quoteRowToObj_(r);
      if (!isAdmin && o.userId !== session.id) return;
      if (q && (o.name + ' ' + o.client + ' ' + o.memo + ' ' + o.from + ' ' + o.to + ' ' + o.userName).indexOf(q) === -1) return;
      out.push(o);
    });
  }
  return { quotes: out.reverse() };
}

function quoteAccess_(session, id) {
  var found = findQuote_(id);
  if (!found) throw new Error('견적을 찾을 수 없습니다.');
  if (session.role !== 'admin' && found.data.userId !== session.id) throw new Error('본인 견적만 볼 수 있습니다.');
  return found;
}

function quotesGet_(session, id) {
  var found = quoteAccess_(session, id);
  var data = readPacked_(SHEET_QDATA, found.data.id);
  if (!data) throw new Error('견적 데이터가 없습니다.');
  return { quote: found.data, meta: data.meta, items: data.items };
}

function quotesUpdate_(session, id, patch) {
  var found = quoteAccess_(session, id);
  var f = checkQuoteFields_(Object.assign({}, found.data, patch || {}));
  quotesSheet_().getRange(found.row, 5, 1, 4).setValues([[f.name, f.client, f.memo, f.status]]);
  quotesSheet_().getRange(found.row, 15).setValue(now_());
  return { quote: findQuote_(id).data };
}

function quotesDelete_(session, id) {
  var found = quoteAccess_(session, id);
  var dsh = SpreadsheetApp.getActive().getSheetByName(SHEET_QDATA);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    packedRows_(SHEET_QDATA, found.data.id).sort(function (a, b) { return b - a; }).forEach(function (row) { dsh.deleteRow(row); });
    quotesSheet_().deleteRow(findQuote_(id).row);
  } finally {
    lock.releaseLock();
  }
  return {};
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

/* ───────────── 매출매입 분석 ───────────── */
/*
 * 사업자 × 월 단위로 저장합니다. (같은 사업자·월을 다시 올리면 덮어씀)
 * 화면에서 엑셀을 읽어 JSON → gzip → base64 로 보내고, 서버는 그 문자열을 4.5만 자씩 잘라 시트에 보관.
 * 분석은 권한이 있는 사람의 브라우저에서 이뤄지고, 서버는 저장·전달·권한 확인만 합니다.
 *  분석목록: 키 | 사업자 | 월 | 건수 | 매출합 | 매입합 | 파일명 | 업로드일시 | 업로더
 *  분석데이터: 키 | 순번 | 데이터조각
 *  매출처설정: 원본 매출처 | 표시 이름 | 숨김
 */

var SHEET_AN_INDEX = '분석목록';
var SHEET_AN_DATA = '분석데이터';
var SHEET_AN_MAP = '매출처설정';
var SHEET_AN_LOG = '분석접속기록';
var AN_INDEX_HEADER = ['키', '사업자', '월', '건수', '매출합', '매입합', '파일명', '업로드일시', '업로더'];
var AN_DATA_HEADER = ['키', '순번', '데이터'];
var AN_MAP_HEADER = ['원본 매출처', '표시 이름', '숨김'];
var AN_BUSINESSES = ['조일물류', '명일로지스', '조일로지스'];
var AN_LOAD_MAX = 12; // 한 번 요청에 보내는 사업자·월 묶음 수

function anKey_(biz, month) { return biz + '|' + month; }

function analysisIndex_(session) {
  var idx = cacheSheet_(SHEET_AN_INDEX, AN_INDEX_HEADER);
  var list = idx.getLastRow() < 2 ? [] : idx.getRange(2, 1, idx.getLastRow() - 1, AN_INDEX_HEADER.length).getValues().map(function (r) {
    var kp = String(r[0]).split('|'); // 시트가 월을 날짜로 바꾸므로 키에서 꺼냄
    return { key: String(r[0]), biz: kp[0], month: kp[1], count: Number(r[3]), sales: Number(r[4]), buys: Number(r[5]), fileName: String(r[6]), uploadedAt: fmt_(r[7]), uploader: String(r[8]) };
  });
  var map = cacheSheet_(SHEET_AN_MAP, AN_MAP_HEADER);
  var mapping = map.getLastRow() < 2 ? [] : map.getRange(2, 1, map.getLastRow() - 1, 3).getValues().map(function (r) {
    return { raw: String(r[0]), display: String(r[1] || ''), hidden: r[2] === 'Y' || r[2] === true };
  });
  var log = cacheSheet_(SHEET_AN_LOG, ['일시', '아이디', '이름', '데이터 묶음 수']);
  log.appendRow([now_(), session.id, session.name, list.length]);
  return { index: list, mapping: mapping, businesses: AN_BUSINESSES };
}

/** 압축된 데이터 문자열을 그대로 돌려줌 (풀기는 브라우저에서) */
function analysisLoad_(keys) {
  keys = (keys || []).map(String).slice(0, AN_LOAD_MAX);
  var sh = cacheSheet_(SHEET_AN_DATA, AN_DATA_HEADER);
  var out = {};
  if (!keys.length || sh.getLastRow() < 2) return { data: out };
  var want = {};
  keys.forEach(function (k) { want[k] = []; });
  // 키 열만 먼저 읽어서 필요한 줄만 골라 읽음
  var keyCol = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var rowsByKey = {};
  keyCol.forEach(function (r, i) { if (want[r[0]]) (rowsByKey[r[0]] = rowsByKey[r[0]] || []).push(i + 2); });
  Object.keys(rowsByKey).forEach(function (k) {
    var rows = rowsByKey[k];
    var first = rows[0], last = rows[rows.length - 1];
    var vals = sh.getRange(first, 1, last - first + 1, 3).getValues();
    var parts = vals.filter(function (v) { return v[0] === k; }).sort(function (a, b) { return a[1] - b[1]; });
    out[k] = parts.map(function (v) { return String(v[2]); }).join('');
  });
  return { data: out };
}

function analysisUpload_(session, req) {
  var biz = String(req.biz || '');
  var month = String(req.month || '');
  if (AN_BUSINESSES.indexOf(biz) === -1) throw new Error('사업자를 선택하세요.');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('월 형식이 올바르지 않습니다: ' + month);
  var data = String(req.data || '');
  if (!data) throw new Error('데이터가 비어 있습니다.');

  // 서버에서 한 번 풀어서 건수·합계를 직접 확인 (화면이 보낸 숫자를 그대로 믿지 않음)
  var rows = JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(data), 'application/x-gzip')).getDataAsString('UTF-8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('행이 없습니다.');
  var sales = 0, buys = 0;
  rows.forEach(function (r) {
    if (String(r[0]).slice(0, 7) !== month) throw new Error('다른 달 행이 섞여 있습니다: ' + r[0]);
    sales += Number(r[5]) || 0; buys += Number(r[6]) || 0;
  });
  if (req.count != null && Number(req.count) !== rows.length) throw new Error('건수가 맞지 않습니다. 다시 시도하세요.');

  var key = anKey_(biz, month);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    removeAnalysisRows_(key);
    var sh = cacheSheet_(SHEET_AN_DATA, AN_DATA_HEADER);
    var parts = [];
    for (var i = 0; i < data.length; i += CELL_LIMIT) parts.push([key, parts.length + 1, data.slice(i, i + CELL_LIMIT)]);
    sh.getRange(sh.getLastRow() + 1, 1, parts.length, 3).setValues(parts);
    cacheSheet_(SHEET_AN_INDEX, AN_INDEX_HEADER).appendRow([key, biz, "'" + month, rows.length, sales, buys, String(req.fileName || '').slice(0, 200), now_(), session.name + ' (' + session.id + ')']);
  } finally {
    lock.releaseLock();
  }
  return { key: key, count: rows.length, sales: sales, buys: buys };
}

function removeAnalysisRows_(key) {
  [[SHEET_AN_DATA, AN_DATA_HEADER], [SHEET_AN_INDEX, AN_INDEX_HEADER]].forEach(function (s) {
    var sh = cacheSheet_(s[0], s[1]);
    if (sh.getLastRow() < 2) return;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(key).matchEntireCell(true).findAll()
      .map(function (rg) { return rg.getRow(); }).sort(function (a, b) { return b - a; });
    // 이어진 줄은 한 번에 지움
    var i = 0;
    while (i < rows.length) {
      var end = rows[i], start = end;
      while (i + 1 < rows.length && rows[i + 1] === start - 1) { i++; start = rows[i]; }
      sh.deleteRows(start, end - start + 1);
      i++;
    }
  });
}

function analysisDelete_(key) {
  key = String(key || '');
  if (!key) throw new Error('삭제할 데이터를 선택하세요.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { removeAnalysisRows_(key); } finally { lock.releaseLock(); }
  return {};
}

function analysisSaveMap_(map) {
  if (!Array.isArray(map)) throw new Error('매출처 설정 형식이 올바르지 않습니다.');
  var rows = map.filter(function (m) { return m && String(m.raw || '') !== ''; }).map(function (m) {
    return [String(m.raw), String(m.display || '').trim().slice(0, 100), m.hidden ? 'Y' : ''];
  });
  var sh = cacheSheet_(SHEET_AN_MAP, AN_MAP_HEADER);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
  return { count: rows.length };
}

function analysisAccessLog_(limit) {
  var sh = cacheSheet_(SHEET_AN_LOG, ['일시', '아이디', '이름', '데이터 묶음 수']);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(limit, last - 1);
  return sh.getRange(last - n + 1, 1, n, 4).getValues().reverse().map(function (r) { return { at: fmt_(r[0]), id: r[1], name: r[2], n: r[3] }; });
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
