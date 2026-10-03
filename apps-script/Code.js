/**
 * JOIL 조일그룹 견적·실적 시스템 — 서버 (구글 Apps Script)
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
  SpreadsheetApp.getUi().createMenu('조일그룹 시스템')
    .addItem('초기 설정 (처음 한 번)', 'setup')
    .addItem('관리자 비밀번호 초기화', 'resetAdminPassword')
    .addItem('유가 자동 기록 켜기', 'installDieselTrigger')
    .addItem('서류함 준비 (드라이브 권한)', 'setupDocs')
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
  return ContentService.createTextOutput('조일그룹 견적·실적 시스템 서버가 정상 작동 중입니다.');
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
    case 'info.diesel': return dieselAll_();
    case 'info.news': return news_(!!req.force && session.role === 'admin');
    case 'info.weather': return weather_();
  }

  var QUOTE_ACTIONS = ['dieselPrice', 'quote', 'quoteBatch', 'history.list', 'history.get', 'quotes.save', 'quotes.list', 'quotes.get', 'quotes.update', 'quotes.delete',
    'docs.list', 'docs.upload', 'docs.update', 'docs.get', 'docs.zip', 'docs.delete', 'addr.list', 'companies', 'diesel.recent', 'quotes.addRoutes', 'rates.list', 'rates.get', 'rates.upload', 'rates.saveSpecials'];
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
    case 'quotes.addRoutes': return quotesAddRoutes_(session, req);
    case 'rates.list': return ratesList_();
    case 'rates.get': return ratesGet_(req.cust);
    case 'rates.upload': return ratesUpload_(session, req);
    case 'rates.saveSpecials': return saveCustSpecials_(req.cust, req.specials);
    case 'docs.list': return docsList_();
    case 'docs.upload': return docsUpload_(session, req);
    case 'docs.update': return docsUpdate_(session, req.id, req.patch);
    case 'docs.get': return docsGet_(req.id);
    case 'docs.zip': return docsZip_(req.ids);
    case 'docs.delete': return docsDelete_(session, req.id);
    case 'addr.list': return addrList_();
    case 'companies': return { companies: companies_() };
    case 'diesel.recent': return dieselRecent_(60);
  }

  if (session.role !== 'admin') throw new Error('관리자만 사용할 수 있습니다.');
  switch (action) {
    case 'admin.bootstrap': cleanupSnapshots_(); return { settings: getSettings_(), keys: keyStatus_(), users: listUsers_(), logs: getLogs_(200), cache: cacheInfo_(), diesel: dieselStatus_(), tariffWarn: tariffWarn_() };
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
    case 'analysis.saveRules': return analysisSaveRules_(req.rules);
    case 'admin.dieselHistory': return dieselHistory_();
    case 'admin.dieselRecordNow': recordDieselDaily(); return dieselHistory_();
    case 'admin.dieselImport': return dieselImport_(req.rows);
    case 'analysis.accessLog': return { logs: analysisAccessLog_(50) };
    case 'admin.saveCompanies': return saveCompanies_(req.companies);
    case 'admin.saveNews': return saveNewsRules_(req.rules);
    case 'rates.delete': return ratesDelete_(req.cust);
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
    maxKm: s.maxKm,
    priceRounding: s.priceRounding,
    specials: (s.specials || []).map(function (x) { return { id: x.id, name: x.name, mode: x.mode, set: Object.keys(x.values || {}).some(function (k) { return Number(x.values[k]); }) }; })
  };
}

function saveSettings_(settings) {
  if (!settings || !Array.isArray(settings.tons) || !Array.isArray(settings.regionRules)) throw new Error('설정 형식이 올바르지 않습니다.');
  var merged = joilMergeSettings(settings);
  var tonNames = merged.tons.map(function (t) { return t.name; }), seen = {};
  merged.specials = (Array.isArray(merged.specials) ? merged.specials : []).slice(0, 40).map(function (sp, i) {
    var name = String(sp && sp.name || '').trim().slice(0, 30);
    if (!name) throw new Error('특수 운임 ' + (i + 1) + '번째 항목의 이름을 입력하세요.');
    var id = /^[A-Za-z0-9_-]{1,20}$/.test(String(sp.id || '')) && !seen[sp.id] ? String(sp.id) : 'sp' + Date.now().toString(36) + i;
    seen[id] = true;
    var vals = {};
    tonNames.forEach(function (t) { var v = Number((sp.values || {})[t]); if (v) { if (!isFinite(v) || v < 0 || v > 100000000) throw new Error(name + ' ' + t + ' 금액이 올바르지 않습니다.'); vals[t] = Math.round(v * 100) / 100; } });
    return { id: id, name: name, mode: sp.mode === 'percent' ? 'percent' : 'amount', values: vals };
  });
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(merged));
  dropCalcCache_();
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
  dropCalcCache_();
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
  var ver = '';
  try { ver = currentVersion_(session); } catch (e) { /* 버전 기록 실패해도 조회는 계속 */ }
  return {
    ver: ver,
    type: type, at: now_(), user: { id: session.id, name: session.name }, count: count,
    baseTon: out.baseTon, diesel: out.diesel, roundTrip: !!s.milkrun.roundTrip, specials: out.specials || [], cust: out.cust || '',
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
    meta = d.meta; // 나중에 붙인 묶음(구간 추가)의 정보가 최신
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

/* ───────────── 타리프 버전 ─────────────
 * 계산에 영향을 주는 것(타리프 표 + 톤수·지역할증·하행·반올림 설정)을 묶어 내용이 바뀔 때마다 버전으로 보관합니다.
 * 버전 ID = 내용의 지문(MD5) → 사이트에서 저장하든 시트를 직접 고치든 내용이 같으면 같은 버전.
 * 견적에는 계산할 때의 버전 ID가 남아서, 나중에 구간을 추가해도 그때 기준으로 계산합니다.
 */
var SHEET_VER = '타리프버전';
var VER_HEADER = ['버전ID', '처음 사용', '사용자', '데이터1', '데이터2', '데이터3'];
var CALC_KEYS = ['tons', 'maxKm', 'kmRounding', 'priceRounding', 'regionRules', 'downhill', 'specials'];

function calcPart_(s) { var o = {}; CALC_KEYS.forEach(function (k) { o[k] = s[k]; }); return o; }

/** 지금 기준의 버전 ID (없으면 새로 기록) */
function currentVersion_(session) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('VER_CUR');
  if (hit) return hit;
  var content = { s: calcPart_(getSettings_()), t: readTariff_().rows };
  var id = 'V' + md5_(JSON.stringify(content)).slice(0, 12);
  var sh = cacheSheet_(SHEET_VER, VER_HEADER);
  var exists = sh.getLastRow() >= 2 && sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (!exists) {
    var packed = packJson_(content), parts = [];
    for (var i = 0; i < packed.length; i += CELL_LIMIT) parts.push(packed.slice(i, i + CELL_LIMIT));
    if (parts.length > 3) throw new Error('타리프 버전 데이터가 너무 큽니다.');
    while (parts.length < 3) parts.push('');
    sh.appendRow([id, now_(), session ? session.name + ' (' + session.id + ')' : ''].concat(parts));
  }
  cache.put('VER_CUR', id, 21600);
  return id;
}

/** 버전 ID → { settings(지금 설정에 그때 계산 기준을 덮어씀), tariff, at } */
function loadVersion_(id) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VER);
  if (!id || !sh || sh.getLastRow() < 2) return null;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return null;
  var row = sh.getRange(hit.getRow(), 1, 1, VER_HEADER.length).getValues()[0];
  var c = unpackJson_(String(row[3]) + String(row[4]) + String(row[5]));
  var s = getSettings_();
  CALC_KEYS.forEach(function (k) { s[k] = c.s[k]; });
  return { settings: s, tariff: { tons: c.s.tons.map(function (t) { return t.name; }), rows: c.t }, at: fmt_(row[1]) };
}

function dropCalcCache_() { CacheService.getScriptCache().removeAll(['TARIFF', 'VER_CUR']); }

/** 시트에서 타리프 탭을 직접 고치면 바로 반영 (단순 트리거 · 따로 설치할 필요 없음) */
function onEdit(e) {
  try { if (e && e.range && e.range.getSheet().getName() === SHEET_TARIFF) dropCalcCache_(); } catch (x) { /* 무시 */ }
}

/** 관리자 화면 경고용: 0원·빈칸 개수 */
function tariffWarn_() {
  var t = readTariff_(), zeros = 0, first = null;
  t.rows.forEach(function (r, i) { r.forEach(function (v, j) { if (!(v > 0)) { zeros++; if (!first) first = (i + 1) + 'km ' + (t.tons[j] || ''); } }); });
  var s = getSettings_();
  var tonMismatch = s.tons.map(function (x) { return x.name; }).join('|') !== t.tons.join('|');
  return { zeros: zeros, first: first, rows: t.rows.length, tonMismatch: tonMismatch };
}

/* ───────────── 견적 금액 조정 · 구간 추가 ───────────── */

var ADJ_MAX = 5000;
function cleanAdj_(adj) {
  if (!adj) return null;
  var out = { rows: {}, cols: {}, cells: {} }, n = 0;
  var num = function (v) { v = Math.round(Number(v)); if (!isFinite(v) || Math.abs(v) > 100000000) throw new Error('조정 금액이 올바르지 않습니다.'); return v; };
  ['rows', 'cols', 'cells'].forEach(function (k) {
    Object.keys(adj[k] || {}).forEach(function (key) {
      var v = num(adj[k][key]);
      if (k !== 'cells' && !v) return;
      if (++n > ADJ_MAX) throw new Error('조정이 너무 많습니다. (최대 ' + ADJ_MAX + '개)');
      out[k][String(key).slice(0, 60)] = v;
    });
  });
  return n ? out : null;
}
function parseJson_(v, dflt) { try { return v ? JSON.parse(String(v)) : dflt; } catch (e) { return dflt; } }
function addAdjLog_(row, session, note) {
  var sh = quotesSheet_(), cell = sh.getRange(row, 18);
  var list = parseJson_(cell.getValue(), []);
  list.push({ at: now_(), by: session.name + ' (' + session.id + ')', note: String(note || '').slice(0, 300) });
  if (list.length > 60) list = list.slice(-60);
  cell.setValue(JSON.stringify(list));
}

/** 저장된 견적에 구간 추가: 견적 낼 때의 버전·밀크런 기준·경유가 그대로 계산해서 마지막에 붙임 */
function quotesAddRoutes_(session, req) {
  var found = quoteAccess_(session, req.id);
  var data = readPacked_(SHEET_QDATA, found.data.id);
  if (!data) throw new Error('견적 데이터가 없습니다.');
  var pairs = (req.pairs || []).map(function (p) { return { origin: joilNormalizeAddress(p.origin), dest: joilNormalizeAddress(p.dest) }; })
    .filter(function (p) { return p.origin && p.dest; });
  if (!pairs.length) throw new Error('추가할 구간을 입력하세요.');
  if (pairs.length > BATCH_CHUNK_MAX) throw new Error('한 번에 ' + BATCH_CHUNK_MAX + '건까지 추가할 수 있습니다.');
  var meta = data.meta;
  var ver = meta.ver ? loadVersion_(meta.ver) : null;
  var used = null;
  data.items.some(function (it) { if (it.result && it.result.specials) { used = it.result.specials; return true; } return false; });
  var out = quoteMany_(pairs, { baseTon: meta.baseTon, dieselMode: 'manual', dieselPrice: meta.diesel && meta.diesel.price, specialsResolved: used || [] }, ver);
  if (meta.diesel) out.items.forEach(function (it) { if (it.result) it.result.dieselSource = meta.diesel.source; });
  var maxNo = data.items.reduce(function (m, it) { return Math.max(m, Number(it.no) || 0); }, 0);
  var added = [], failed = [], stamp = { at: now_(), by: session.name };
  out.items.forEach(function (it, i) {
    if (it.error) failed.push({ origin: pairs[i].origin, dest: pairs[i].dest, error: it.error });
    else added.push({ no: ++maxNo, origin: pairs[i].origin, dest: pairs[i].dest, result: it.result, added: stamp });
  });
  if (added.length) {
    var total = data.items.length + added.length;
    var newMeta = JSON.parse(JSON.stringify(meta));
    newMeta.type = '대량'; newMeta.count = total;
    if (!newMeta.ver && !newMeta.verNote) newMeta.verNote = '버전 기록 이전 견적 · 추가 구간은 ' + stamp.at.slice(0, 10) + ' 기준';
    appendPacked_(SHEET_QDATA, found.data.id, session.id, newMeta, added);
    var sh = quotesSheet_();
    sh.getRange(found.row, 9, 1, 2).setValues([['대량', total]]);
    var origins = {};
    data.items.concat(added).forEach(function (x) { origins[x.origin] = true; });
    sh.getRange(found.row, 11, 1, 2).setValues([[Object.keys(origins).length === 1 ? data.items[0].origin : '여러 상차지', '하차지 ' + total + '곳']]);
    sh.getRange(found.row, 15).setValue(now_());
    addAdjLog_(found.row, session, '구간 ' + added.length + '건 추가' + (ver ? ' (견적 당시 기준 ' + meta.ver + ')' : ' (현재 기준)'));
  }
  var res = quotesGet_(session, req.id);
  res.added = added.map(function (x) { return x.no; });
  res.failed = failed;
  res.usedVersion = ver ? meta.ver : null;
  return res;
}

/* ───────────── 업체별 단가표 · 특수 추가운임 ─────────────
 * 업체단가: 업체마다 상차지·하차지·톤수·단가 (엑셀 양식으로 올림)
 * 업체설정: 업체마다 특수 추가운임을 회사 기준과 다르게 쓸 때 (항목별로 덮어씀)
 * 보기·올리기: 견적 권한자 · 업체 삭제: 관리자
 */
var SHEET_RATES = '업체단가';
var RATES_HEADER = ['업체', '상차지', '하차지', '톤수', '단가', '적용시작일', '비고', '올린사람', '올린일시'];
var SHEET_CUST = '업체설정';
var CUST_HEADER = ['업체', '특수운임', '메모', '수정일시'];

function custSpecials_(cust) {
  if (!cust) return null;
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CUST);
  if (!sh || sh.getLastRow() < 2) return null;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(cust)).matchEntireCell(true).findNext();
  return hit ? parseJson_(sh.getRange(hit.getRow(), 2).getValue(), null) : null;
}

/** 고른 특수운임 id → 계산용 목록 (업체 설정이 있으면 그 값으로 덮어씀) */
function resolveSpecials_(s, ids, cust) {
  ids = (ids || []).map(String);
  if (!ids.length) return [];
  var over = custSpecials_(cust) || {};
  return (s.specials || []).filter(function (sp) { return ids.indexOf(sp.id) !== -1; }).map(function (sp) {
    var o = over[sp.id];
    return o ? { id: sp.id, name: sp.name, mode: o.mode || sp.mode, values: o.values || {}, cust: cust } : { id: sp.id, name: sp.name, mode: sp.mode, values: sp.values || {} };
  });
}

function ratesSheet_() { return cacheSheet_(SHEET_RATES, RATES_HEADER); }

function ratesList_() {
  var sh = ratesSheet_(), by = {};
  if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, RATES_HEADER.length).getValues().forEach(function (r) {
    var c = String(r[0]); if (!c) return;
    var x = by[c] || (by[c] = { cust: c, count: 0, updated: '', by: '' });
    x.count++;
    var at = fmt_(r[8]); if (at > x.updated) { x.updated = at; x.by = String(r[7]); }
  });
  var cs = SpreadsheetApp.getActive().getSheetByName(SHEET_CUST);
  if (cs && cs.getLastRow() >= 2) cs.getRange(2, 1, cs.getLastRow() - 1, 3).getValues().forEach(function (r) {
    var c = String(r[0]); if (!c) return;
    var x = by[c] || (by[c] = { cust: c, count: 0, updated: '', by: '' });
    x.hasSpecial = !!String(r[1]); x.memo = String(r[2] || '');
  });
  return { custs: Object.keys(by).sort().map(function (k) { return by[k]; }) };
}

function ratesGet_(cust) {
  cust = String(cust || '');
  var sh = ratesSheet_(), rows = [];
  if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, RATES_HEADER.length).getValues().forEach(function (r) {
    if (String(r[0]) === cust) rows.push([String(r[1]), String(r[2]), String(r[3]), Number(r[4]) || 0, textDate_(r[5]), String(r[6] || '')]);
  });
  return { cust: cust, rows: rows, specials: custSpecials_(cust) || {} };
}

function checkCustName_(c) {
  c = String(c || '').trim();
  if (!c) throw new Error('업체 이름을 입력하세요.');
  if (c.length > 60) throw new Error('업체 이름이 너무 깁니다.');
  return c;
}

/** 단가표 올리기 (mode: replace = 그 업체 것을 모두 바꿈 / append = 뒤에 추가) */
function ratesUpload_(session, req) {
  var cust = checkCustName_(req.cust);
  var tons = getSettings_().tons.map(function (t) { return t.name; });
  var rows = (req.rows || []).map(function (r, i) {
    var from = String(r[0] || '').trim(), to = String(r[1] || '').trim(), ton = String(r[2] || '').trim(), price = Number(r[3]);
    if (!from || !to) throw new Error((i + 1) + '번째 줄: 상차지·하차지를 확인하세요.');
    if (tons.indexOf(ton) === -1) throw new Error((i + 1) + '번째 줄: 톤수 "' + ton + '"를 알 수 없습니다.');
    if (!(price > 0)) throw new Error((i + 1) + '번째 줄: 단가를 확인하세요.');
    var since = String(r[4] || '').trim();
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error((i + 1) + '번째 줄: 적용 시작일은 YYYY-MM-DD 입니다.');
    return [cust, from.slice(0, 200), to.slice(0, 200), ton, Math.round(price), "'" + since, String(r[5] || '').slice(0, 200), session.name + ' (' + session.id + ')', now_()];
  });
  if (!rows.length) throw new Error('올릴 단가가 없습니다.');
  if (rows.length > 5000) throw new Error('한 번에 5,000줄까지 올릴 수 있습니다.');
  var sh = ratesSheet_();
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (req.mode !== 'append') removeCustRows_(sh, cust);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, RATES_HEADER.length).setValues(rows);
  } finally { lock.releaseLock(); }
  if (req.specials) saveCustSpecials_(cust, req.specials);
  return { count: rows.length };
}

function removeCustRows_(sh, cust) {
  if (sh.getLastRow() < 2) return;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) !== cust) continue;
    var end = i; while (i > 0 && String(vals[i - 1][0]) === cust) i--;
    sh.deleteRows(i + 2, end - i + 1);
  }
}

function cleanSpecialsOverride_(sp) {
  var s = getSettings_(), ids = (s.specials || []).map(function (x) { return x.id; }), tons = s.tons.map(function (t) { return t.name; }), out = {};
  Object.keys(sp || {}).forEach(function (id) {
    if (ids.indexOf(id) === -1) return;
    var o = sp[id] || {}, vals = {};
    tons.forEach(function (t) { var v = Number((o.values || {})[t]); if (v) vals[t] = Math.round(v * 100) / 100; });
    out[id] = { mode: o.mode === 'percent' ? 'percent' : 'amount', values: vals };
  });
  return out;
}
function saveCustSpecials_(cust, specials) {
  cust = checkCustName_(cust);
  var clean = cleanSpecialsOverride_(specials);
  var sh = cacheSheet_(SHEET_CUST, CUST_HEADER);
  var hit = sh.getLastRow() >= 2 && sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(cust).matchEntireCell(true).findNext();
  var json = Object.keys(clean).length ? JSON.stringify(clean) : '';
  if (hit) sh.getRange(hit.getRow(), 2, 1, 3).setValues([[json, sh.getRange(hit.getRow(), 3).getValue(), now_()]]);
  else sh.appendRow([cust, json, '', now_()]);
  return { specials: clean };
}

function ratesDelete_(cust) {
  cust = checkCustName_(cust);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    removeCustRows_(ratesSheet_(), cust);
    var cs = SpreadsheetApp.getActive().getSheetByName(SHEET_CUST);
    if (cs && cs.getLastRow() >= 2) {
      var hit = cs.getRange(2, 1, cs.getLastRow() - 1, 1).createTextFinder(cust).matchEntireCell(true).findNext();
      if (hit) cs.deleteRow(hit.getRow());
    }
  } finally { lock.releaseLock(); }
  return {};
}

/* ───────────── 견적모음 ───────────── */

var QUOTE_HEADER = ['견적ID', '저장일', '아이디', '이름', '견적명', '거래처', '메모', '상태', '종류', '건수', '상차지', '하차지', '원본기록ID', '조회일', '수정일', '실적연결', '조정', '조정기록'];
var QUOTE_STATUS = ['작성', '제출', '수주', '미수주'];

function quotesSheet_() {
  var sh = cacheSheet_(SHEET_QUOTES, QUOTE_HEADER);
  if (String(sh.getRange(1, QUOTE_HEADER.length).getValue()) !== QUOTE_HEADER[QUOTE_HEADER.length - 1]) sh.getRange(1, 1, 1, QUOTE_HEADER.length).setValues([QUOTE_HEADER]).setFontWeight('bold');
  return sh;
}

function quoteRowToObj_(r) {
  return {
    id: String(r[0]), savedAt: fmt_(r[1]), userId: String(r[2]), userName: String(r[3]), name: String(r[4]), client: String(r[5]),
    memo: String(r[6]), status: String(r[7]), type: String(r[8]), count: r[9], from: String(r[10]), to: String(r[11]),
    recordId: String(r[12]), queriedAt: fmt_(r[13]), updatedAt: fmt_(r[14]), link: parseLink_(r[15]), hasAdj: !!r[16]
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
  var adj = cleanAdj_(req.adj);
  quotesSheet_().appendRow([id, now, session.id, session.name, f.name, f.client, f.memo, f.status, snap.meta.type, snap.items.length, from, to, log.recordId, log.at, now, '', adj ? JSON.stringify(adj) : '',
    JSON.stringify([{ at: now, by: session.name + ' (' + session.id + ')', note: '견적 저장' + (adj ? ' (조정 포함: ' + String(req.adjNote || '').slice(0, 200) + ')' : '') }])]);
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
  var row = quotesSheet_().getRange(found.row, 17, 1, 2).getValues()[0];
  var meta = data.meta;
  if (meta.ver) { var vs = SpreadsheetApp.getActive().getSheetByName(SHEET_VER); var vh = vs && vs.getLastRow() >= 2 && vs.getRange(2, 1, vs.getLastRow() - 1, 1).createTextFinder(meta.ver).matchEntireCell(true).findNext(); if (vh) meta.verAt = fmt_(vs.getRange(vh.getRow(), 2).getValue()); }
  return { quote: found.data, meta: meta, items: data.items, adj: parseJson_(row[0], null), adjLog: parseJson_(row[1], []) };
}

function parseLink_(v) { try { return v ? JSON.parse(String(v)) : null; } catch (e) { return null; } }

function quotesUpdate_(session, id, patch) {
  var found = quoteAccess_(session, id);
  if (patch && patch.hasOwnProperty('adj')) {
    var adj = cleanAdj_(patch.adj);
    var cell = quotesSheet_().getRange(found.row, 17);
    var s = adj ? JSON.stringify(adj) : '';
    if (s.length > CELL_LIMIT) throw new Error('조정이 너무 많아 저장할 수 없습니다.');
    cell.setValue(s);
    addAdjLog_(found.row, session, patch.adjNote || (adj ? '금액 조정' : '조정 모두 해제'));
  }
  if (patch && patch.hasOwnProperty('link')) {
    var l = patch.link;
    var clean = l ? { cust: String(l.cust || '').slice(0, 100), from: String(l.from || '').slice(0, 100), to: String(l.to || '').slice(0, 100), weight: String(l.weight || '').slice(0, 30),
      since: /^\d{4}-\d{2}$/.test(l.since) ? l.since : '', price: Number(l.price) || 0, ton: String(l.ton || '').slice(0, 20) } : null;
    if (clean && !clean.cust) throw new Error('연결할 매출처를 고르세요.');
    quotesSheet_().getRange(found.row, 16).setValue(clean ? JSON.stringify(clean) : '');
  }
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
function quoteMany_(pairs, req, ver) {
  var s = ver ? ver.settings : getSettings_();
  var tariff = ver ? ver.tariff : readTariff_();
  var baseTon = joilFindTon(s, req.baseTon) || joilFindTon(s, s.milkrun.baseTon) || s.tons[0];
  var tollClass = Number(baseTon.tollClass) || 1;
  var specials = req.specialsResolved || resolveSpecials_(s, req.specials, req.cust);

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
      origin: o, dest: d, distanceKm: r.km, toll: r.toll, dieselPrice: diesel.price, baseTon: baseTon.name, specials: specials
    }, s, tariff);
    result.origin = o;
    result.dest = d;
    result.dieselSource = diesel.source;
    return { result: result };
  });
  return { items: items, diesel: diesel, baseTon: baseTon.name, specials: specials.map(function (x) { return x.id; }), cust: req.cust ? String(req.cust) : '' };
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
  dropCalcCache_();
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
  return { index: list, mapping: mapping, businesses: AN_BUSINESSES, rules: analysisRules_() };
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

/* 제외·분류 규칙: 원본은 그대로 두고 보여줄 때만 적용 (스크립트 속성에 JSON) */
var AN_RULE_FIELDS = ['any', 'cust', 'from', 'to', 'weight', 'car', 'driver', 'etc', 'note'];
function analysisRules_() {
  var raw = PropertiesService.getScriptProperties().getProperty('AN_RULES');
  return raw ? JSON.parse(raw) : [];
}
function analysisSaveRules_(rules) {
  if (!Array.isArray(rules)) throw new Error('규칙 형식이 올바르지 않습니다.');
  if (rules.length > 200) throw new Error('규칙은 200개까지 만들 수 있습니다.');
  var clean = rules.map(function (r) {
    var word = String(r.word || '').trim();
    if (!word) throw new Error('단어가 비어 있는 규칙이 있습니다.');
    if (AN_RULE_FIELDS.indexOf(r.field) === -1) throw new Error('칸 선택이 올바르지 않습니다.');
    var action = r.action === 'class' ? 'class' : 'exclude';
    var cat = String(r.cat || '').trim().slice(0, 30);
    if (action === 'class' && !cat) throw new Error('분류 규칙은 분류 이름이 필요합니다: ' + word);
    return {
      on: r.on !== false, field: r.field, mode: ['eq', 'contains', 'starts'].indexOf(r.mode) !== -1 ? r.mode : 'contains',
      word: word.slice(0, 100), biz: AN_BUSINESSES.indexOf(r.biz) !== -1 ? r.biz : '', action: action, cat: action === 'class' ? cat : '',
      memo: String(r.memo || '').slice(0, 200)
    };
  });
  PropertiesService.getScriptProperties().setProperty('AN_RULES', JSON.stringify(clean));
  return { rules: clean };
}

function analysisAccessLog_(limit) {
  var sh = cacheSheet_(SHEET_AN_LOG, ['일시', '아이디', '이름', '데이터 묶음 수']);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(limit, last - 1);
  return sh.getRange(last - n + 1, 1, n, 4).getValues().reverse().map(function (r) { return { at: fmt_(r[0]), id: r[1], name: r[2], n: r[3] }; });
}

/* ───────────── 서류함 (구글 드라이브) ───────────── */
/*
 * 파일은 대리님 드라이브의 비공개 폴더 "조일그룹 서류함"에, 목록(이름·분류·유효기간 등)은 서류목록 시트에 둡니다.
 * 보기·다운로드·올리기·삭제: 견적 권한자 (누가 올리고 지웠는지 기록)
 * 처음 한 번: 시트 메뉴 조일그룹 시스템 → 서류함 준비 (드라이브 권한 승인)
 */

var SHEET_DOCS = '서류목록';
var DOCS_HEADER = ['파일ID', '사업자', '분류', '서류명', '파일명', '형식', '크기', '발급일', '만료일', '메모', '올린사람', '올린일시', '수정일시'];
var DOC_MAX_BYTES = 20 * 1024 * 1024;

function docsFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DOCS_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 지워졌으면 새로 */ } }
  var folder = DriveApp.createFolder('조일그룹 서류함');
  props.setProperty('DOCS_FOLDER', folder.getId());
  return folder;
}

/** 시트 메뉴에서 한 번: 폴더 만들고 드라이브 권한 승인 */
function setupDocs() {
  var f = docsFolder_();
  cacheSheet_(SHEET_DOCS, DOCS_HEADER);
  notify_('서류함을 준비했습니다. 드라이브 폴더: ' + f.getName());
}

function docRowToObj_(r) {
  return {
    id: String(r[0]), biz: String(r[1]), cat: String(r[2]), name: String(r[3]), fileName: String(r[4]), mime: String(r[5]), size: Number(r[6]) || 0,
    issued: textDate_(r[7]), expires: textDate_(r[8]), memo: String(r[9] || ''), by: String(r[10] || ''), at: fmt_(r[11]), updated: fmt_(r[12])
  };
}
function textDate_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '').replace(/^'/, ''); }

function docsList_() {
  var sh = cacheSheet_(SHEET_DOCS, DOCS_HEADER);
  if (sh.getLastRow() < 2) return { docs: [] };
  return { docs: sh.getRange(2, 1, sh.getLastRow() - 1, DOCS_HEADER.length).getValues().filter(function (r) { return r[0]; }).map(docRowToObj_) };
}

function findDoc_(id) {
  var sh = cacheSheet_(SHEET_DOCS, DOCS_HEADER);
  if (!id || sh.getLastRow() < 2) return null;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? { row: hit.getRow(), data: docRowToObj_(sh.getRange(hit.getRow(), 1, 1, DOCS_HEADER.length).getValues()[0]) } : null;
}

function checkDocMeta_(m) {
  var name = String(m.name || '').trim();
  if (!name) throw new Error('서류명을 입력하세요.');
  var d = function (v) { v = String(v || '').trim(); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('날짜 형식은 YYYY-MM-DD 입니다: ' + v); return v; };
  return { name: name.slice(0, 100), biz: String(m.biz || '').slice(0, 30), cat: String(m.cat || '기타').slice(0, 30), issued: d(m.issued), expires: d(m.expires), memo: String(m.memo || '').slice(0, 500) };
}

function docsUpload_(session, req) {
  var m = checkDocMeta_(req);
  var bytes = Utilities.base64Decode(String(req.data || ''));
  if (!bytes.length) throw new Error('파일이 비어 있습니다.');
  if (bytes.length > DOC_MAX_BYTES) throw new Error('파일은 20MB까지 올릴 수 있습니다.');
  var fileName = String(req.fileName || m.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  var mime = String(req.mime || 'application/octet-stream');
  var file = docsFolder_().createFile(Utilities.newBlob(bytes, mime, fileName));
  var now = now_();
  cacheSheet_(SHEET_DOCS, DOCS_HEADER).appendRow([file.getId(), m.biz, m.cat, m.name, fileName, mime, bytes.length, "'" + m.issued, "'" + m.expires, m.memo, session.name + ' (' + session.id + ')', now, now]);
  return { doc: findDoc_(file.getId()).data };
}

function docsUpdate_(session, id, patch) {
  var found = findDoc_(id);
  if (!found) throw new Error('서류를 찾을 수 없습니다.');
  var m = checkDocMeta_(Object.assign({}, found.data, patch || {}));
  var sh = cacheSheet_(SHEET_DOCS, DOCS_HEADER);
  sh.getRange(found.row, 2, 1, 3).setValues([[m.biz, m.cat, m.name]]);
  sh.getRange(found.row, 8, 1, 3).setValues([["'" + m.issued, "'" + m.expires, m.memo]]);
  sh.getRange(found.row, 13).setValue(now_() + ' · ' + session.name);
  return { doc: findDoc_(id).data };
}

function docsGet_(id) {
  var found = findDoc_(id);
  if (!found) throw new Error('서류를 찾을 수 없습니다.');
  var blob = DriveApp.getFileById(found.data.id).getBlob();
  return { doc: found.data, data: Utilities.base64Encode(blob.getBytes()) };
}

/** 여러 서류를 ZIP 하나로 (입찰 서류 묶음 등) */
function docsZip_(ids) {
  ids = (ids || []).slice(0, 50);
  if (!ids.length) throw new Error('서류를 고르세요.');
  var used = {};
  var blobs = ids.map(function (id) {
    var found = findDoc_(id);
    if (!found) return null;
    var b = DriveApp.getFileById(found.data.id).getBlob();
    var ext = (found.data.fileName.match(/\.[^.]+$/) || [''])[0];
    var base = ((found.data.biz ? found.data.biz + '_' : '') + found.data.name).replace(/[\\/:*?"<>|]/g, '_'), nm = base + ext, k = 2;
    while (used[nm]) nm = base + '(' + (k++) + ')' + ext;
    used[nm] = true;
    return b.setName(nm);
  }).filter(Boolean);
  var zip = Utilities.zip(blobs, '서류.zip');
  return { data: Utilities.base64Encode(zip.getBytes()) };
}

function docsDelete_(session, id) {
  var found = findDoc_(id);
  if (!found) throw new Error('서류를 찾을 수 없습니다.');
  try { DriveApp.getFileById(found.data.id).setTrashed(true); } catch (e) { /* 이미 없음 */ }
  cacheSheet_(SHEET_DOCS, DOCS_HEADER).deleteRow(found.row);
  Logger.log('서류 삭제: ' + found.data.name + ' by ' + session.id);
  return {};
}

/* ───────────── 회사 정보 (견적서 양식) ───────────── */

var COMPANY_FIELDS = ['name', 'ceo', 'bizNo', 'addr', 'tel', 'fax', 'email', 'manager', 'bank'];
function companies_() {
  var raw = PropertiesService.getScriptProperties().getProperty('COMPANIES');
  var list = raw ? JSON.parse(raw) : {};
  // 직인 이미지는 크기가 커서 시트에
  var sh = SpreadsheetApp.getActive().getSheetByName('회사직인');
  if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (list[r[0]]) list[r[0]].stamp = String(r[1] || ''); });
  return list;
}
function saveCompanies_(companies) {
  if (!companies || typeof companies !== 'object') throw new Error('회사 정보 형식이 올바르지 않습니다.');
  var meta = {}, stamps = [];
  AN_BUSINESSES.forEach(function (biz) {
    var c = companies[biz] || {};
    meta[biz] = {};
    COMPANY_FIELDS.forEach(function (k) { meta[biz][k] = String(c[k] || '').slice(0, 200); });
    var stamp = String(c.stamp || '');
    if (stamp && (!/^data:image\/(png|jpeg|webp);base64,/.test(stamp) || stamp.length > CELL_LIMIT)) throw new Error(biz + ' 직인 이미지가 너무 크거나 형식이 맞지 않습니다.');
    stamps.push([biz, stamp]);
  });
  PropertiesService.getScriptProperties().setProperty('COMPANIES', JSON.stringify(meta));
  var sh = cacheSheet_('회사직인', ['사업자', '직인(이미지)']);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
  sh.getRange(2, 1, stamps.length, 2).setValues(stamps);
  return { companies: companies_() };
}

/* ───────────── 주소 자동완성 ───────────── */

/** 지금까지 조회된 주소(입력한 그대로) — 최근 것부터 최대 3000개 */
function addrList_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_GEO_CACHE);
  if (!sh || sh.getLastRow() < 2) return { list: [] };
  var n = sh.getLastRow() - 1, start = Math.max(2, sh.getLastRow() - 2999);
  var vals = sh.getRange(start, 1, sh.getLastRow() - start + 1, 5).getValues().reverse();
  var seen = {}, out = [];
  vals.forEach(function (r) { var q = String(r[0]); if (q && !seen[q]) { seen[q] = true; out.push([q, String(r[4] || '')]); } });
  return { list: out, total: n };
}

/* ───────────── 물류 정보 (유가 · 뉴스 · 날씨) ─────────────
 * 로그인한 사람 누구나 볼 수 있음 (회사 기밀 아님)
 * 뉴스: 구글 뉴스 RSS를 키워드별로 모아 제외 단어로 거름 · 30분 캐시
 * 날씨: Open-Meteo (키 없음) · 도별 대표 지점 · 1시간 캐시
 */

var NEWS_DEFAULT = {
  include: ['화물연대', '화물 파업', '안전운임', '화물차 운송', '물류 업계', '운송업계', '경유 가격', '고속도로 통행료', '항만 파업', '컨테이너 운임', '국토부 화물', '택배 노조'],
  exclude: ['교통사고', '추돌', '음주운전', '사망사고', '부고', '인사'],
  watch: ['쿠팡', 'CJ대한통운', '한진', '롯데글로벌로지스']
};
var WEATHER_REGIONS = [
  { name: '경기도', city: '수원', lat: 37.26, lon: 127.03 },
  { name: '충청도', city: '대전', lat: 36.35, lon: 127.38 },
  { name: '전라도', city: '광주', lat: 35.16, lon: 126.85 },
  { name: '강원도', city: '강릉', lat: 37.75, lon: 128.88 },
  { name: '경상도', city: '대구', lat: 35.87, lon: 128.60 }
];

function newsRules_() {
  var raw = PropertiesService.getScriptProperties().getProperty('NEWS_RULES');
  var r = raw ? JSON.parse(raw) : {};
  return { include: r.include || NEWS_DEFAULT.include, exclude: r.exclude || NEWS_DEFAULT.exclude, watch: r.watch || NEWS_DEFAULT.watch };
}
function saveNewsRules_(rules) {
  var clean = function (list) {
    var seen = {};
    return (list || []).map(function (w) { return String(w || '').trim().slice(0, 40); }).filter(function (w) { if (!w || seen[w]) return false; seen[w] = true; return true; }).slice(0, 40);
  };
  var r = { include: clean(rules && rules.include), exclude: clean(rules && rules.exclude), watch: clean(rules && rules.watch) };
  if (!r.include.length && !r.watch.length) throw new Error('모을 키워드를 하나 이상 넣으세요.');
  PropertiesService.getScriptProperties().setProperty('NEWS_RULES', JSON.stringify(r));
  CacheService.getScriptCache().remove('NEWS');
  return { rules: r };
}

function xmlText_(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}
function parseRss_(xml, keyword, kind) {
  var out = [], m, re = /<item>([\s\S]*?)<\/item>/g;
  while ((m = re.exec(xml))) {
    var it = m[1], g = function (tag) { var x = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(it); return x ? xmlText_(x[1]) : ''; };
    var title = g('title'), source = g('source');
    if (source && title.slice(-(source.length + 3)) === ' - ' + source) title = title.slice(0, -(source.length + 3));
    var t = Date.parse(g('pubDate'));
    out.push({ title: title, link: g('link'), source: source, at: isNaN(t) ? 0 : t, kw: keyword, kind: kind });
  }
  return out;
}

function news_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) { var hit = cache.get('NEWS'); if (hit) return JSON.parse(hit); }
  var rules = newsRules_();
  var qs = rules.include.map(function (k) { return [k, 'topic']; }).concat(rules.watch.map(function (k) { return [k, 'watch']; }));
  var reqs = qs.map(function (q) {
    return { url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('"' + q[0] + '" when:7d') + '&hl=ko&gl=KR&ceid=KR:ko', muteHttpExceptions: true };
  });
  var res = [];
  for (var i = 0; i < reqs.length; i += 20) res = res.concat(UrlFetchApp.fetchAll(reqs.slice(i, i + 20)));
  var byTitle = {}, failed = 0;
  res.forEach(function (r, i) {
    if (r.getResponseCode() !== 200) { failed++; return; }
    parseRss_(r.getContentText(), qs[i][0], qs[i][1]).forEach(function (n) {
      var key = n.title.replace(/[\s"'“”‘’\[\]…·,.]/g, '').slice(0, 40);
      if (!key) return;
      var prev = byTitle[key];
      if (prev) { if (prev.kws.indexOf(n.kw) === -1) prev.kws.push(n.kw); if (n.kind === 'watch') prev.watch = true; return; }
      byTitle[key] = { title: n.title, link: n.link, source: n.source, at: n.at, kws: [n.kw], watch: n.kind === 'watch' };
    });
  });
  var ex = rules.exclude;
  var since = Date.now() - 7 * 86400000;
  var list = Object.keys(byTitle).map(function (k) { return byTitle[k]; }).filter(function (n) {
    if (n.at && n.at < since) return false;
    return !ex.some(function (w) { return n.title.indexOf(w) !== -1; });
  }).sort(function (a, b) { return b.at - a.at; }).slice(0, 120);
  var out = { items: list, at: now_(), failed: failed, keywords: rules };
  var s = JSON.stringify(out);
  while (s.length > 95000 && out.items.length > 10) { out.items = out.items.slice(0, Math.floor(out.items.length * 0.8)); s = JSON.stringify(out); }
  try { cache.put('NEWS', s, 1800); } catch (e) { /* 캐시 생략 */ }
  return out;
}

function weather_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('WEATHER'); if (hit) return JSON.parse(hit);
  var R = WEATHER_REGIONS;
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + R.map(function (r) { return r.lat; }).join(',') + '&longitude=' + R.map(function (r) { return r.lon; }).join(',') +
    '&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,snowfall_sum,wind_speed_10m_max&timezone=Asia%2FSeoul&forecast_days=3';
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('날씨 정보를 받지 못했습니다. 잠시 후 다시 시도하세요.');
  var data = JSON.parse(r.getContentText());
  if (!Array.isArray(data)) data = [data];
  var out = { at: now_(), regions: R.map(function (reg, i) {
    var d = data[i] || {}, dl = d.daily || {}, cur = d.current || {};
    return {
      name: reg.name, city: reg.city,
      now: { temp: cur.temperature_2m, code: cur.weather_code, wind: cur.wind_speed_10m },
      days: (dl.time || []).map(function (t, k) {
        return { date: t, code: dl.weather_code[k], max: dl.temperature_2m_max[k], min: dl.temperature_2m_min[k], pop: dl.precipitation_probability_max[k], rain: dl.precipitation_sum[k], snow: dl.snowfall_sum[k], wind: dl.wind_speed_10m_max[k] };
      })
    };
  }) };
  try { cache.put('WEATHER', JSON.stringify(out), 3600); } catch (e) { /* 캐시 생략 */ }
  return out;
}

/** 유가 상세: 기록 전체 + 견적에 쓰는 오늘 경유가 */
function dieselAll_() {
  var h = dieselHistoryMap_(), dates = Object.keys(h).sort();
  return { now: dieselPrice_(), rows: dates.map(function (d) { return [d, h[d].price]; }) };
}

/* ───────────── 경유가 (오피넷) ───────────── */
/*
 * 하루 한 번(아침 7시) 오피넷 "최근 7일 전국 평균 경유가"를 받아 유가기록 시트에 쌓습니다.
 * 빠진 날이 있어도 7일치를 받으니 자동으로 메워지고, 견적 계산은 이 기록을 씁니다 (계산할 때마다 오피넷을 부르지 않음).
 *  유가기록: 날짜(텍스트) | 경유(원/L) | 출처 | 기록시각
 * 처음 한 번: Apps Script 편집기에서 installDieselTrigger 실행 (또는 시트 메뉴 조일그룹 시스템 → 유가 자동 기록 켜기)
 */

var SHEET_DIESEL = '유가기록';
var DIESEL_HEADER = ['날짜', '경유(원/L)', '출처', '기록시각'];

function dieselSheet_() { return cacheSheet_(SHEET_DIESEL, DIESEL_HEADER); }

/** { 'YYYY-MM-DD': {price, source} } */
function dieselHistoryMap_() {
  var sh = dieselSheet_(), out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    var d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]).replace(/^'/, '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number(r[1]) > 0) out[d] = { price: Number(r[1]), source: String(r[2] || '') };
  });
  return out;
}

/** 여러 날짜를 한 번에 넣거나 고침 (같은 날짜는 덮어씀) */
function upsertDiesel_(entries) {
  if (!entries.length) return 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = dieselSheet_();
    var rowOf = {};
    if (sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r, i) {
        var d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]).replace(/^'/, '');
        rowOf[d] = i + 2;
      });
    }
    var now = now_(), add = [];
    entries.forEach(function (e) {
      var row = ["'" + e.date, Math.round(e.price * 100) / 100, e.source, now];
      if (rowOf[e.date]) sh.getRange(rowOf[e.date], 1, 1, 4).setValues([row]);
      else add.push(row);
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add);
    // 날짜순 정렬 (텍스트 날짜라 그대로 정렬됨)
    if (sh.getLastRow() > 2) sh.getRange(2, 1, sh.getLastRow() - 1, 4).sort(1);
    CacheService.getScriptCache().remove('DIESEL_TODAY');
    return entries.length;
  } finally {
    lock.releaseLock();
  }
}

/** 오피넷 최근 7일 전국 평균 경유가 → 기록 (트리거가 매일 호출) */
function recordDieselDaily() {
  var key = PropertiesService.getScriptProperties().getProperty('OPINET_KEY');
  if (!key) throw new Error('오피넷 키가 없습니다. 관리자 > API 키에서 입력하세요.');
  var res = UrlFetchApp.fetch('https://www.opinet.co.kr/api/avgRecentPrice.do?out=json&prodcd=D047&code=' + encodeURIComponent(key), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('오피넷 응답 오류 (' + res.getResponseCode() + ')');
  var oils = (JSON.parse(res.getContentText()).RESULT || {}).OIL || [];
  var entries = oils.filter(function (o) { return !o.PRODCD || o.PRODCD === 'D047'; }).map(function (o) {
    var d = String(o.DATE || o.TRADE_DT || '');
    return { date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), price: Number(o.PRICE), source: '오피넷 전국평균' };
  }).filter(function (e) { return /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.price > 0; });
  if (!entries.length) throw new Error('오피넷에서 받은 경유가가 없습니다.');
  upsertDiesel_(entries);
  PropertiesService.getScriptProperties().setProperty('DIESEL_LAST_FETCH', Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
  return entries.length;
}

/** 매일 아침 7시 자동 기록 켜기 (처음 한 번 편집기에서 실행) */
function installDieselTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'recordDieselDaily') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('recordDieselDaily').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
  var n = 0;
  try { n = recordDieselDaily(); } catch (e) { notify_('자동 기록은 켰지만 지금 조회는 실패했습니다: ' + e.message); return; }
  notify_('유가 자동 기록을 켰습니다. 매일 아침 7시에 기록돼요. (방금 최근 ' + n + '일치를 받았습니다)');
}

function dieselTriggerOn_() {
  try {
    return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'recordDieselDaily'; });
  } catch (e) { return null; } // 권한 승인 전
}

function dieselStatus_() {
  var h = dieselHistoryMap_(), dates = Object.keys(h).sort();
  return {
    count: dates.length, first: dates[0] || '', last: dates[dates.length - 1] || '',
    lastPrice: dates.length ? h[dates[dates.length - 1]].price : null,
    triggerOn: dieselTriggerOn_(), hasKey: !!PropertiesService.getScriptProperties().getProperty('OPINET_KEY')
  };
}

function dieselHistory_() {
  var h = dieselHistoryMap_();
  return { rows: Object.keys(h).sort().map(function (d) { return [d, h[d].price, h[d].source]; }), status: dieselStatus_() };
}

/** 홈 화면용: 오늘 견적에 쓰는 경유가 + 최근 n일 기록 */
function dieselRecent_(n) {
  var h = dieselHistoryMap_(), dates = Object.keys(h).sort().slice(-n);
  return { now: dieselPrice_(), rows: dates.map(function (d) { return [d, h[d].price]; }) };
}

/** 오피넷 사이트에서 내려받은 과거 유가 엑셀을 화면에서 읽어 보낸 것 */
function dieselImport_(rows) {
  var entries = (rows || []).map(function (r) { return { date: String(r[0]), price: Number(r[1]), source: '엑셀 가져오기' }; })
    .filter(function (e) { return /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.price > 0 && e.price < 10000; });
  if (!entries.length) throw new Error('가져올 날짜·경유가가 없습니다.');
  return { count: upsertDiesel_(entries), status: dieselStatus_() };
}

/**
 * 견적 계산에 쓸 경유가
 * - 자동: 기록 중 가장 최근 날짜 값. 오늘 기록이 없으면 하루 한 번만 오피넷에서 받아 옴.
 * - 직접: 관리자 기본값
 */
function dieselPrice_() {
  var s = getSettings_();
  var manual = { price: Number(s.fuel.manualPrice) || 0, source: '관리자 기본값' };
  if (s.fuel.mode !== 'auto') return manual;
  var cache = CacheService.getScriptCache();
  var hit = cache.get('DIESEL_TODAY');
  if (hit) return JSON.parse(hit);

  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (props.getProperty('OPINET_KEY') && props.getProperty('DIESEL_LAST_FETCH') !== today) {
    try { recordDieselDaily(); } catch (e) { props.setProperty('DIESEL_LAST_FETCH', today); /* 오늘은 다시 시도하지 않음 */ }
  }
  var h = dieselHistoryMap_(), dates = Object.keys(h).sort();
  if (!dates.length) { manual.source = '관리자 기본값 (유가 기록 없음)'; return manual; }
  var d = dates[dates.length - 1];
  var out = { price: Math.round(h[d].price), source: (h[d].source || '오피넷') + ' (' + d + ')' };
  cache.put('DIESEL_TODAY', JSON.stringify(out), 60 * 60);
  return out;
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
