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
    case 'me': return { user: session };
    case 'logout': CacheService.getScriptCache().remove('S_' + req.token); return {};
    case 'changePassword': return changePassword_(session, req.current, req.next);
    case 'publicSettings': return { settings: publicSettings_() };
    case 'dieselPrice': return dieselPrice_();
    case 'quote': return quote_(session, req);
  }

  if (session.role !== 'admin') throw new Error('관리자만 사용할 수 있습니다.');
  switch (action) {
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
  return { token: token, user: session };
}

/** 매 요청마다 계정 시트를 다시 확인 → 사용중지하면 즉시 차단 */
function requireSession_(token) {
  if (!token) throw new Error('로그인이 필요합니다.');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('S_' + token);
  if (!raw) throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  var id = JSON.parse(raw).id;
  var u = findUser_(id);
  if (!u || u.data['사용여부'] !== '사용') {
    cache.remove('S_' + token);
    throw new Error('사용이 중지된 계정입니다.');
  }
  cache.put('S_' + token, raw, SESSION_SECONDS);
  return { id: id, name: u.data['이름'], role: u.data['권한'], mustChange: u.data['비밀번호변경필요'] === 'Y' };
}

function changePassword_(session, current, next) {
  var u = findUser_(session.id);
  if (hash_(current || '', u.data['솔트']) !== u.data['비밀번호해시']) throw new Error('현재 비밀번호가 올바르지 않습니다.');
  checkPasswordRule_(next);
  setPassword_(u.row, next, false);
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
  return {};
}

function resetPassword_(id) {
  var u = findUser_(id);
  if (!u) throw new Error('계정을 찾을 수 없습니다.');
  var temp = randomPassword_();
  setPassword_(u.row, temp, true);
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
    fuelIncluded: s.fuel.include,
    tollIncluded: s.toll.include,
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

function quote_(session, req) {
  var originQ = String(req.origin || '').trim();
  var destQ = String(req.dest || '').trim();
  if (!originQ || !destQ) throw new Error('상차지와 하차지를 모두 입력하세요.');

  var settings = getSettings_();
  var tariff = readTariff_();
  var origin = kakaoGeocode_(originQ);
  var dest = kakaoGeocode_(destQ);
  var route = kakaoRoute_(origin, dest, settings);

  var diesel;
  if (req.dieselMode === 'manual' && Number(req.dieselPrice) > 0) {
    diesel = { price: Number(req.dieselPrice), source: '직접 입력' };
  } else {
    diesel = dieselPrice_();
  }

  var result = joilComputeQuote({
    origin: origin, dest: dest, distanceKm: route.distanceKm,
    tollByClass: route.tollByClass, toll1: route.tollByClass[1], dieselPrice: diesel.price
  }, settings, tariff);
  result.origin = origin;
  result.dest = dest;
  result.dieselSource = diesel.source;

  log_(session, origin.address, dest.address, result.distanceKm, '');
  return { result: result };
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

/* ───────────── 카카오 API ───────────── */

function kakaoKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('KAKAO_REST_KEY');
  if (!key) throw new Error('카카오 REST 키가 설정되지 않았습니다. 관리자 > API 키에서 입력하세요.');
  return key;
}

function kakaoGet_(url) {
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'KakaoAK ' + kakaoKey_() }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('카카오 키 인증에 실패했습니다. 키와 사용 설정(지도/로컬, 카카오모빌리티)을 확인하세요.');
  if (code === 429) throw new Error('카카오 API 일일 호출 한도를 초과했습니다.');
  if (code !== 200) throw new Error('카카오 API 오류 (' + code + ')');
  return JSON.parse(res.getContentText());
}

function kakaoGeocode_(query) {
  var cache = CacheService.getScriptCache();
  var ck = 'G_' + md5_(query);
  var hit = cache.get(ck);
  if (hit) return JSON.parse(hit);

  var q = encodeURIComponent(query);
  var data = kakaoGet_('https://dapi.kakao.com/v2/local/search/address.json?size=1&query=' + q);
  var doc = data.documents && data.documents[0];
  var point;
  if (doc) {
    var region = doc.address || doc.road_address || {};
    point = { lat: Number(doc.y), lng: Number(doc.x), sido: region.region_1depth_name || firstToken_(doc.address_name), address: doc.address_name };
  } else {
    data = kakaoGet_('https://dapi.kakao.com/v2/local/search/keyword.json?size=1&query=' + q);
    doc = data.documents && data.documents[0];
    if (!doc) throw new Error('주소를 찾지 못했습니다: "' + query + '"');
    point = { lat: Number(doc.y), lng: Number(doc.x), sido: firstToken_(doc.address_name), address: doc.address_name + (doc.place_name ? ' (' + doc.place_name + ')' : '') };
  }
  point.query = query;
  cache.put(ck, JSON.stringify(point), 21600);
  return point;
}

/**
 * 경로 조회. 비율 방식이면 1종만 조회, API 방식이면 사용하는 차종을 모두 동시에 조회.
 */
function kakaoRoute_(origin, dest, settings) {
  var classes = [1];
  if (settings.toll.mode === 'api') {
    settings.tons.forEach(function (t) { if (classes.indexOf(Number(t.tollClass)) === -1) classes.push(Number(t.tollClass)); });
  }
  var cache = CacheService.getScriptCache();
  var base = origin.lng + ',' + origin.lat + '_' + dest.lng + ',' + dest.lat;
  var out = { distanceKm: null, tollByClass: {} };
  var need = [];
  classes.forEach(function (c) {
    var hit = cache.get('R_' + md5_(base + '_' + c));
    if (hit) { hit = JSON.parse(hit); out.distanceKm = out.distanceKm || hit.km; out.tollByClass[c] = hit.toll; }
    else need.push(c);
  });
  if (need.length) {
    var key = kakaoKey_();
    var reqs = need.map(function (c) {
      return {
        url: 'https://apis-navi.kakaomobility.com/v1/directions?summary=true&priority=RECOMMEND&car_fuel=DIESEL&car_type=' + c +
          '&origin=' + origin.lng + ',' + origin.lat + '&destination=' + dest.lng + ',' + dest.lat,
        headers: { Authorization: 'KakaoAK ' + key }, muteHttpExceptions: true
      };
    });
    UrlFetchApp.fetchAll(reqs).forEach(function (res, i) {
      var code = res.getResponseCode();
      if (code !== 200) throw new Error('카카오 길찾기 오류 (' + code + ')');
      var route = JSON.parse(res.getContentText()).routes[0];
      if (route.result_code !== 0) throw new Error('경로를 찾지 못했습니다: ' + route.result_msg);
      var km = route.summary.distance / 1000;
      var toll = (route.summary.fare && route.summary.fare.toll) || 0;
      out.distanceKm = out.distanceKm || km;
      out.tollByClass[need[i]] = toll;
      cache.put('R_' + md5_(base + '_' + need[i]), JSON.stringify({ km: km, toll: toll }), 21600);
    });
  }
  return out;
}

function testKakao_() {
  var p = kakaoGeocode_('서울특별시 중구 세종대로 110');
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
