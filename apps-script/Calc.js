/**
 * JOIL — 견적 계산 핵심 로직 (공용)
 *
 * 이 파일은 두 곳에서 똑같이 쓰입니다.
 *  1) 구글 Apps Script 프로젝트에 "Calc" 파일로 붙여넣어 실제 계산에 사용
 *  2) 웹 화면의 데모 모드에서 그대로 불러와 사용
 * 브라우저 전용 / Apps Script 전용 기능을 쓰지 않는 순수 함수만 둡니다.
 *
 * 계산 구조
 *  - 톤수별 견적 = 타리프 + 지역 할증(상·하차지 합산) + 하행 할증
 *  - 밀크런     = 기준 톤수 1개의 유류비 + 통행료 (편도 / 왕복)
 */

var JOIL_TONS = ['1톤', '1.4톤', '2.5톤', '3.5톤', '5톤', '8톤', '11톤', '14톤', '25톤'];

function joilDefaultSettings() {
  return {
    version: 2,
    maxKm: 600,
    kmRounding: 'ceil', // ceil 올림 | round 반올림 | floor 내림
    priceRounding: { unit: 1000, mode: 'round' },
    regionRules: [
      { name: '서울', amount: 10000, target: 'sido', keywords: ['서울'] },
      { name: '강원', amount: 20000, target: 'sido', keywords: ['강원'] },
      { name: '전라권', amount: 20000, target: 'sido', keywords: ['전북', '전남', '전라', '광주'] },
      { name: '경상권', amount: 10000, target: 'sido', keywords: ['경북', '경남', '경상', '부산', '대구', '울산'] },
      { name: '오지', amount: 30000, target: 'address', keywords: [] }
    ],
    downhill: { enabled: true, minKm: 200, percent: 0 },
    fuel: { mode: 'manual', manualPrice: 1500 },
    milkrun: { baseTon: '5톤', roundTrip: false },
    batch: { maxRows: 1000 },
    snapshot: { retentionDays: 90 },
    tons: [
      { name: '1톤', tollClass: 1, kmPerL: 9 },
      { name: '1.4톤', tollClass: 1, kmPerL: 8 },
      { name: '2.5톤', tollClass: 2, kmPerL: 6.5 },
      { name: '3.5톤', tollClass: 2, kmPerL: 6 },
      { name: '5톤', tollClass: 3, kmPerL: 4.5 },
      { name: '8톤', tollClass: 3, kmPerL: 4 },
      { name: '11톤', tollClass: 4, kmPerL: 3.5 },
      { name: '14톤', tollClass: 4, kmPerL: 3.2 },
      { name: '25톤', tollClass: 5, kmPerL: 2.8 }
    ],
    quoteFooter: '※ 부가세 별도 / 대기·수작업 발생 시 별도 협의'
  };
}

/** 저장된 설정에 빠진 항목이 있으면 기본값으로 채우고, 없어진 항목은 버립니다. */
function joilMergeSettings(saved) {
  var d = joilDefaultSettings();
  if (!saved) return d;
  var out = {};
  for (var k in d) out[k] = saved.hasOwnProperty(k) ? saved[k] : d[k];
  ['priceRounding', 'downhill', 'fuel', 'milkrun', 'batch', 'snapshot'].forEach(function (k) {
    var merged = {};
    for (var x in d[k]) merged[x] = (out[k] && out[k].hasOwnProperty(x)) ? out[k][x] : d[k][x];
    out[k] = merged;
  });
  if (!joilFindTon(out, out.milkrun.baseTon)) out.milkrun.baseTon = out.tons[0].name;
  out.version = d.version;
  return out;
}

function joilFindTon(settings, name) {
  for (var i = 0; i < settings.tons.length; i++) if (settings.tons[i].name === name) return settings.tons[i];
  return null;
}

/** 개발·시연용 임의 타리프 (실제 단가 아님). rows[km-1][톤수 index] */
function joilDummyTariff() {
  var base = [45000, 50000, 65000, 75000, 95000, 120000, 150000, 175000, 230000];
  var perKm = [900, 1000, 1250, 1400, 1700, 2100, 2500, 2800, 3500];
  var rows = [];
  for (var km = 1; km <= 600; km++) {
    var row = [];
    for (var i = 0; i < base.length; i++) {
      row.push(Math.round((base[i] + perKm[i] * km) / 1000) * 1000);
    }
    rows.push(row);
  }
  return { tons: JOIL_TONS.slice(), rows: rows };
}

function joilRound(value, unit, mode) {
  unit = Number(unit) || 1;
  var fn = mode === 'ceil' ? Math.ceil : mode === 'floor' ? Math.floor : Math.round;
  return fn(value / unit) * unit;
}

/** 주소 캐시 키: 공백을 정리해서 같은 주소는 같은 키가 되도록 */
function joilNormalizeAddress(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 한 지점(상차지 또는 하차지)에 해당하는 지역 할증 목록 */
function joilMatchRegions(point, rules) {
  var hits = [];
  (rules || []).forEach(function (rule) {
    var text = rule.target === 'address' ? (point.address || '') : (point.sido || point.address || '');
    var matched = (rule.keywords || []).some(function (kw) {
      kw = String(kw || '').trim();
      return kw && text.indexOf(kw) !== -1;
    });
    if (matched) hits.push({ name: rule.name, amount: Number(rule.amount) || 0 });
  });
  return hits;
}

/**
 * 견적 계산
 * @param {Object} input
 *   origin / dest : { lat, lng, sido, address }
 *   distanceKm    : 실제 경로 거리 (km, 소수 가능, 편도)
 *   toll          : 기준 톤수 차종의 편도 통행료 (원)
 *   dieselPrice   : 경유가 (원/L)
 *   baseTon       : 밀크런 기준 톤수 이름 (없으면 관리자 기본값)
 * @param {Object} settings  joilMergeSettings 결과
 * @param {Object} tariff    { tons: [...], rows: [[...], ...] }
 */
function joilComputeQuote(input, settings, tariff) {
  var s = settings;
  var rawKm = Number(input.distanceKm) || 0;
  var kmFn = s.kmRounding === 'round' ? Math.round : s.kmRounding === 'floor' ? Math.floor : Math.ceil;
  var km = Math.max(1, kmFn(rawKm));
  var maxKm = Number(s.maxKm) || 600;
  var overMax = km > maxKm || km > tariff.rows.length;

  var isDownhill = Number(input.dest.lat) < Number(input.origin.lat);
  var downhillApplies = !!(s.downhill.enabled && isDownhill && km >= Number(s.downhill.minKm) && Number(s.downhill.percent) > 0);

  var regionHits = [];
  joilMatchRegions(input.origin, s.regionRules).forEach(function (h) { regionHits.push({ point: '상차지', name: h.name, amount: h.amount }); });
  joilMatchRegions(input.dest, s.regionRules).forEach(function (h) { regionHits.push({ point: '하차지', name: h.name, amount: h.amount }); });
  var regionTotal = regionHits.reduce(function (sum, h) { return sum + h.amount; }, 0);

  var rows = s.tons.map(function (t) {
    var col = tariff.tons.indexOf(t.name);
    var base = (!overMax && col !== -1) ? Number(tariff.rows[km - 1][col]) || 0 : null;
    var downhill = (base != null && downhillApplies) ? Math.round(base * Number(s.downhill.percent) / 100) : 0;
    var total = base == null ? null : joilRound(base + regionTotal + downhill, s.priceRounding.unit, s.priceRounding.mode);
    return { ton: t.name, tariff: base, region: regionTotal, downhill: downhill, total: total };
  });

  // 밀크런: 기준 톤수 하나로 유류비 + 통행료
  var baseTon = joilFindTon(s, input.baseTon) || joilFindTon(s, s.milkrun.baseTon) || s.tons[0];
  var trips = s.milkrun.roundTrip ? 2 : 1;
  var diesel = Number(input.dieselPrice) || 0;
  var mrKm = rawKm * trips;
  var liters = Number(baseTon.kmPerL) > 0 ? mrKm / Number(baseTon.kmPerL) : 0;
  var fuel = Math.round(liters * diesel / 10) * 10;
  var toll = Math.round((Number(input.toll) || 0) * trips / 10) * 10;

  return {
    distanceKm: Math.round(rawKm * 10) / 10,
    km: km,
    overMax: overMax,
    maxKm: maxKm,
    direction: isDownhill ? '하행' : '상행',
    downhillApplied: downhillApplies,
    downhillPercent: downhillApplies ? Number(s.downhill.percent) : 0,
    regionHits: regionHits,
    regionTotal: regionTotal,
    rows: rows,
    milkrun: {
      ton: baseTon.name,
      tollClass: Number(baseTon.tollClass) || 1,
      kmPerL: Number(baseTon.kmPerL) || 0,
      roundTrip: trips === 2,
      distanceKm: Math.round(mrKm * 10) / 10,
      liters: Math.round(liters * 10) / 10,
      dieselPrice: diesel,
      fuel: fuel,
      toll: toll,
      total: fuel + toll
    }
  };
}

/** 관리자 페이지에서 저장하기 전 타리프 검증 */
function joilValidateTariff(tariff, tonCount, maxKm) {
  if (!tariff || !Array.isArray(tariff.rows)) return '타리프 형식이 올바르지 않습니다.';
  if (tariff.rows.length < maxKm) return '타리프는 1km~' + maxKm + 'km까지 ' + maxKm + '줄이 필요합니다. (현재 ' + tariff.rows.length + '줄)';
  for (var i = 0; i < tariff.rows.length; i++) {
    var r = tariff.rows[i];
    if (!Array.isArray(r) || r.length !== tonCount) return (i + 1) + 'km 줄의 칸 수가 ' + tonCount + '개가 아닙니다.';
    for (var j = 0; j < r.length; j++) {
      var v = Number(r[j]);
      if (!isFinite(v) || v < 0) return (i + 1) + 'km, ' + (j + 1) + '번째 톤수 값이 숫자가 아닙니다.';
    }
  }
  return null;
}
