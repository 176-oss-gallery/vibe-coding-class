/**
 * 바이브 코딩 수업: 학생 HTML 게임 제출 웹 앱 (프로토타입, Apps Script V8)
 * 배포: 실행 계정 = 나(교사), 액세스 = 모든 사용자. 스프레드시트에 바인딩된 스크립트.
 * 처음 한 번: 스크립트 속성 GOOGLE_CLIENT_ID 설정 후 setup() 실행.
 *
 * ── deps 인터페이스 (handleRequest(body, deps) 에 주입; 테스트에서는 가짜로 대체) ──
 *   now()                      → Date (서버 현재 시각)
 *   readConfig()               → parseConfig() 결과 객체
 *   verifyToken(idToken, cfg)  → { ok:true, email, domain, displayName }
 *                               | { ok:false, code, message? }   (code: TOKEN_INVALID | DOMAIN_NOT_ALLOWED | SERVER_ERROR)
 *   readRoster()               → { '<학번>': '<이름>', ... }   (일반 객체)
 *   readBindings()             → [{ id, name, email, displayName, mismatch }]   (mismatch: boolean)
 *   appendBinding(row)         → void; row = { id, name, email, displayName, mismatch:boolean, at:Date }
 *   readSubmissions()          → [{ at:Date|string, id, email, version:number, size:number, sha256, requestId }]
 *   saveFile(fileName, text)   → 드라이브 파일 ID (string)
 *   discardFile(fileId)        → void (기록 실패 시 방금 만든 파일을 휴지통으로)
 *   appendSubmission(row)      → void; row = { at:Date, id, email, version, fileId, size, sha256, requestId }
 *   rateLimit(email, max)      → boolean (true = 제출 허용, false = 너무 잦음 → BUSY)
 *   sha256Hex(text)            → UTF-8 기준 SHA-256 전체 16진 문자열(소문자 64자)
 *   tryLock()                  → boolean (20초 대기)
 *   releaseLock()              → void
 *   log(msg)                   → void (토큰·HTML·요청 본문은 절대 넘기지 않음)
 */

// ───────── 상수 ─────────
var VERSION = 'lab-1';
var FOLDER_NAME = 'vibe-test-submissions';
var PROP_FOLDER_ID = 'SUBMIT_FOLDER_ID';
var PROP_CLIENT_ID = 'GOOGLE_CLIENT_ID';
var BODY_EXTRA = 64 * 1024;
var BODY_HARD_MAX = 8 * 1024 * 1024; // 설정을 읽기 전 절대 상한
var REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
var RATE_MAX = 5;      // 이메일당 RATE_WINDOW 초 안에 최대 제출 수
var RATE_WINDOW = 60;
var NAME_MAX = 20;
var TOKEN_MAX = 4096;
var ID_RE = /^([1-3])(0[1-9]|1[0-6])(0[1-9]|[1-3]\d|40)$/; // tools/common.py 와 동일
var ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

var SHEETS = {
  Roster: ['학번', '이름'],
  Bindings: ['학번', '이름', '이메일', '계정표시이름', '이름불일치', '연결시각', '계정종류'],
  Submissions: ['시각', '학번', '이메일', '버전', '드라이브파일ID', '크기', 'sha256', '요청ID'],
  Config: ['키', '값']
};
// 텍스트 서식 열 (1부터): 학번·파일ID·해시·요청ID (숫자/지수로 바뀌지 않게)
var TEXT_COLS = { Roster: [1], Bindings: [1], Submissions: [2, 5, 7, 8] };

var CONFIG_DEFAULTS = [
  ['roster_required', 'TRUE'],
  ['allowed_domains', ''],
  ['allow_personal', 'FALSE'], // TRUE면 allowed_domains가 있어도 개인 구글 계정(gmail 등) 허용. 대신 이름이 명단과 같아야 연결됨
  ['max_html_bytes', 2097152],
  ['session_open', 'TRUE'],
  ['submit_per_minute', 5]   // 계정당 1분 제출 상한. 부하 시험(T11) 때만 50 정도로 올린다
];

var MESSAGES = {
  BAD_REQUEST: '요청 형식이 올바르지 않아요.',
  TOKEN_INVALID: '로그인이 만료되었거나 올바르지 않아요. 다시 로그인해 주세요.',
  DOMAIN_NOT_ALLOWED: '학교 계정으로 로그인해 주세요.',
  NOT_IN_ROSTER: '명단에 없는 학번이에요. 선생님께 확인해 주세요.',
  ID_BOUND_TO_OTHER: '이 학번은 이미 다른 계정과 연결되어 있어요. 선생님께 알려 주세요.',
  EMAIL_BOUND_TO_OTHER_ID: '이 계정은 이미 다른 학번과 연결되어 있어요. 선생님께 알려 주세요.',
  NOT_BOUND: '먼저 학번을 연결해 주세요.',
  NAME_MISMATCH: '개인 계정은 명단의 이름과 똑같이 입력해야 연결돼요. 이름을 확인하거나 학교 계정으로 로그인해 주세요.',
  TOO_LARGE: '파일이 너무 커요.',
  NOT_HTML: 'HTML 코드가 아닌 것 같아요. 전체 코드를 붙여 넣어 주세요.',
  SESSION_CLOSED: '지금은 제출 시간이 아니에요.',
  BUSY: '제출이 몰려 있어요. 잠시 후 다시 시도해 주세요.',
  SERVER_ERROR: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'
};
var MSG_RATE_LIMITED = '너무 자주 제출했어요. 1분 뒤에 다시 시도해 주세요.'; // 코드는 BUSY
var MSG_NO_CLIENT_ID ='서버 설정이 끝나지 않았어요. 선생님: 스크립트 속성 GOOGLE_CLIENT_ID 를 설정해 주세요.';

// ───────── 순수 함수 (Google API 호출 없음) ─────────

function validateStudentId(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return false;
  return ID_RE.test(String(s).trim());
}

// 이름 정리: 줄바꿈·제어문자·양방향 제어문자·'|'·'<'·'>'·'--' 제거, 공백 정리 (common.py MARK_RE 호환)
function sanitizeName(s) {
  if (s === null || s === undefined) return '';
  var t = String(s);
  t = t.replace(/[\r\n]/g, ' ');
  t = t.replace(/[|<>]/g, '');
  t = t.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '');
  t = t.replace(/-{2,}/g, ''); // HTML 주석 안에는 '--' 가 올 수 없음
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

function buildMarker(studentId, name) {
  return '<!-- vibe-submit:' + String(studentId).trim() + '|' + sanitizeName(name) + ' -->\n';
}

// 맨 앞의 vibe-submit 표식 줄은 제거, vibe-info 줄은 유지
function stripSubmitMarkers(html) {
  if (typeof html !== 'string') return '';
  var s = html.replace(/^﻿/, '');
  var submitRe = /^\s*<!--\s*vibe-submit:[\s\S]*?-->[ \t]*(?:\r?\n)?/;
  var infoRe = /^\s*<!--\s*vibe-info:[^>]*?-->[ \t]*(?:\r?\n)?/;
  var kept = [];
  for (var guard = 0; guard < 100; guard++) {
    var m = s.match(submitRe);
    if (m) { s = s.slice(m[0].length); continue; }
    m = s.match(infoRe);
    if (m) {
      var line = m[0].replace(/^\s+/, '');
      if (!/\n$/.test(line)) line += '\n';
      kept.push(line);
      s = s.slice(m[0].length);
      continue;
    }
    break;
  }
  return kept.join('') + s;
}

function utf8Length(s) {
  s = String(s);
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

function checkHtml(html, maxBytes) {
  if (typeof html !== 'string') return 'BAD_REQUEST';
  if (utf8Length(html) > maxBytes) return 'TOO_LARGE';
  var t = html.replace(/^﻿/, '').trim();
  if (t.charAt(0) !== '<') return 'NOT_HTML';
  return null;
}

function claimsDomain_(claims) {
  var hd = claims && claims.hd ? String(claims.hd) : '';
  if (hd) return hd.toLowerCase();
  var email = claims && claims.email ? String(claims.email) : '';
  var at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

function checkClaims(claims, clientId, allowedDomains, nowSec, allowPersonal) {
  if (!claims || typeof claims !== 'object') return 'TOKEN_INVALID';
  if (!clientId || String(claims.aud) !== String(clientId)) return 'TOKEN_INVALID';
  if (ISSUERS.indexOf(String(claims.iss)) < 0) return 'TOKEN_INVALID';
  var exp = Number(claims.exp);
  if (!isFinite(exp) || exp <= nowSec) return 'TOKEN_INVALID';
  if (!(claims.email_verified === true || claims.email_verified === 'true')) return 'TOKEN_INVALID';
  if (!claims.email || String(claims.email).indexOf('@') < 1) return 'TOKEN_INVALID';
  var list = (allowedDomains || []).map(function (d) { return String(d).trim().toLowerCase().replace(/^@/, ''); })
    .filter(function (d) { return d; });
  // 허용 목록이 있으면 Workspace 계정의 hd 만 인정 (이메일 도메인으로 대체하지 않음)
  var hd = claims.hd ? String(claims.hd).trim().toLowerCase() : '';
  if (!list.length) return null;
  if (hd && list.indexOf(hd) >= 0) return null;
  // 개인 계정(hd 없음)은 allow_personal 일 때만. 다른 학교·회사 Workspace 계정(hd 다름)은 항상 거부
  if (!hd && allowPersonal === true) return null;
  return 'DOMAIN_NOT_ALLOWED';
}

// tokeninfo 호출 전 값싼 사전 검사. b64decodeFn(base64url 조각) → 디코드된 문자열 (예외 가능)
function precheckToken(token, clientId, nowSec, b64decodeFn) {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return 'TOKEN_INVALID';
  var parts = token.split('.');
  if (parts.length !== 3) return 'TOKEN_INVALID';
  for (var i = 0; i < 3; i++) if (!/^[A-Za-z0-9_-]+$/.test(parts[i])) return 'TOKEN_INVALID';
  var payload;
  try { payload = JSON.parse(b64decodeFn(parts[1])); } catch (e) { return 'TOKEN_INVALID'; }
  if (!payload || typeof payload !== 'object') return 'TOKEN_INVALID';
  if (!clientId || String(payload.aud) !== String(clientId)) return 'TOKEN_INVALID';
  if (ISSUERS.indexOf(String(payload.iss)) < 0) return 'TOKEN_INVALID';
  var exp = Number(payload.exp);
  if (!isFinite(exp) || exp <= nowSec) return 'TOKEN_INVALID';
  return null;
}

// 파일 이름용 시각 yyyyMMddHHmmss (한국 시간, UTC+9 고정)
function formatStamp_(d) {
  var k = new Date(d.getTime() + 9 * 3600 * 1000);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return '' + k.getUTCFullYear() + p(k.getUTCMonth() + 1) + p(k.getUTCDate()) +
    p(k.getUTCHours()) + p(k.getUTCMinutes()) + p(k.getUTCSeconds());
}

function cacheTtl(expSec, nowSec) {
  var t = Math.floor(Math.min(300, Number(expSec) - Number(nowSec) - 10));
  return isFinite(t) && t >= 1 ? t : 0;
}

function parseBool_(v, def) {
  if (v === true || v === false) return v;
  if (typeof v === 'number') return v !== 0;
  var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (!s) return def;
  if (['true', 'y', 'yes', '1', 'o', 'ㅇ', 'on', '예'].indexOf(s) >= 0) return true;
  if (['false', 'n', 'no', '0', 'x', 'off', '아니오'].indexOf(s) >= 0) return false;
  return def;
}

function parseConfig(rows) {
  var cfg = { roster_required: true, allowed_domains: [], max_html_bytes: 2097152, session_open: true, submit_per_minute: RATE_MAX, allow_personal: false };
  if (!rows || !rows.length) return cfg;
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i] || [];
    var key = String(r[0] === null || r[0] === undefined ? '' : r[0]).trim().toLowerCase();
    var val = r[1];
    if (key === 'roster_required') cfg.roster_required = parseBool_(val, true);
    else if (key === 'session_open') cfg.session_open = parseBool_(val, true);
    else if (key === 'allow_personal') cfg.allow_personal = parseBool_(val, false);
    else if (key === 'allowed_domains') {
      cfg.allowed_domains = String(val === null || val === undefined ? '' : val)
        .split(/[\s,;]+/).map(function (d) { return d.trim().toLowerCase().replace(/^@/, ''); })
        .filter(function (d) { return d; });
    } else if (key === 'max_html_bytes') {
      var n = Math.floor(Number(val));
      if (isFinite(n) && n > 0) cfg.max_html_bytes = n;
    } else if (key === 'submit_per_minute') {
      var m = Math.floor(Number(val));
      if (isFinite(m) && m > 0) cfg.submit_per_minute = Math.min(m, 200);
    }
  }
  return cfg;
}

function hasId_(ids, id) {
  if (!ids) return false;
  if (typeof ids.has === 'function') return ids.has(id);
  if (Array.isArray(ids)) return ids.map(function (x) { return String(x).trim(); }).indexOf(id) >= 0;
  return Object.prototype.hasOwnProperty.call(ids, id);
}

// 순서: 명단 → 같은 (학번,이메일) 재연결 → 학번 중복 → 이메일 중복
function decideBind(bindingRows, rosterIds, rosterRequired, studentId, email) {
  var sid = String(studentId).trim();
  var em = String(email || '').trim().toLowerCase();
  if (rosterRequired && !hasId_(rosterIds, sid)) return 'NOT_IN_ROSTER';
  var rows = bindingRows || [];
  var i, r;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    if (String(r.id).trim() === sid && String(r.email).trim().toLowerCase() === em) return 'ALREADY_BOUND';
  }
  for (i = 0; i < rows.length; i++) {
    if (String(rows[i].id).trim() === sid) return 'ID_BOUND_TO_OTHER';
  }
  for (i = 0; i < rows.length; i++) {
    if (String(rows[i].email).trim().toLowerCase() === em) return 'EMAIL_BOUND_TO_OTHER_ID';
  }
  return null;
}

function normName_(s) {
  var t = String(s === null || s === undefined ? '' : s);
  try { t = t.normalize('NFC'); } catch (e) { /* 무시 */ }
  return t.replace(/[\s　]+/g, '').toLowerCase();
}

// 공백 제거 후 정확히 같으면 일치. 둘 중 하나라도 비면 불일치.
function namesMatch(a, b) {
  var x = normName_(a), y = normName_(b);
  return !!x && x === y;
}

function nextVersion(submissionRows, studentId) {
  var sid = String(studentId).trim();
  var max = 0;
  (submissionRows || []).forEach(function (r) {
    if (String(r.id).trim() !== sid) return;
    var v = Number(r.version);
    if (isFinite(v) && v > max) max = v;
  });
  return Math.floor(max) + 1;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function toIso_(v) {
  if (isDate_(v)) return isNaN(v.getTime()) ? '' : v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}

function ok_(obj) {
  var out = { ok: true };
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function fail_(code, message) {
  return { ok: false, code: code, message: message || MESSAGES[code] || MESSAGES.SERVER_ERROR };
}

function findBindingByEmail_(rows, email) {
  var em = String(email || '').trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email).trim().toLowerCase() === em) return rows[i];
  }
  return null;
}

// ───────── 요청 처리 (deps 주입) ─────────

function handleRequest(body, deps) {
  try {
    return route_(body, deps);
  } catch (err) {
    try { deps.log('handleRequest error: ' + String(err && err.message).slice(0, 200)); } catch (e2) { /* 무시 */ }
    return fail_('SERVER_ERROR');
  }
}

function route_(body, deps) {
  if (typeof body !== 'string' || !body) return fail_('BAD_REQUEST');
  if (body.length > BODY_HARD_MAX) return fail_('BAD_REQUEST');
  var req;
  try { req = JSON.parse(body); } catch (e) { return fail_('BAD_REQUEST'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return fail_('BAD_REQUEST');
  var action = req.action;

  // ping 은 시트를 읽지 않음
  if (action === 'ping') return ok_({ serverTime: deps.now().toISOString(), version: VERSION });
  if (['whoami', 'bind', 'submit', 'list_mine'].indexOf(action) < 0) return fail_('BAD_REQUEST');

  var cfg = deps.readConfig();
  if (utf8Length(body) > cfg.max_html_bytes + BODY_EXTRA) return fail_('BAD_REQUEST');

  // 무거운 작업 전에 제출 시간 확인
  if (action === 'submit' && !cfg.session_open) return fail_('SESSION_CLOSED');

  var auth = deps.verifyToken(req.idToken, cfg);
  if (!auth || !auth.ok) {
    var code = auth && auth.code && MESSAGES[auth.code] ? auth.code : 'TOKEN_INVALID';
    return fail_(code, auth && auth.message);
  }
  var email = String(auth.email).trim().toLowerCase();

  if (action === 'whoami') return doWhoami_(deps, auth, email);
  if (action === 'list_mine') return doListMine_(deps, email);
  if (action === 'bind') return doBind_(deps, cfg, req, auth, email);
  return doSubmit_(deps, cfg, req, email);
}

function doWhoami_(deps, auth, email) {
  var b = findBindingByEmail_(deps.readBindings(), email);
  return ok_({
    email: email,
    domain: auth.domain || '',
    displayName: auth.displayName || '',
    studentId: b ? String(b.id).trim() : null,
    name: b ? String(b.name) : null
  });
}

function doListMine_(deps, email) {
  var b = findBindingByEmail_(deps.readBindings(), email);
  if (!b) return fail_('NOT_BOUND');
  var sid = String(b.id).trim();
  var items = deps.readSubmissions()
    .filter(function (r) { return String(r.id).trim() === sid; })
    .map(function (r) {
      return { version: Number(r.version), submittedAt: toIso_(r.at), size: Number(r.size), sha256: String(r.sha256 || '').slice(0, 12) };
    })
    .sort(function (a, b2) { return a.version - b2.version; });
  return ok_({ studentId: sid, items: items });
}

function doBind_(deps, cfg, req, auth, email) {
  var rawId = req.studentId;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return fail_('BAD_REQUEST');
  var sid = String(rawId).trim();
  if (!validateStudentId(sid)) return fail_('BAD_REQUEST');
  if (typeof req.name !== 'string') return fail_('BAD_REQUEST');
  var name = sanitizeName(req.name);
  if (!name || name.length > NAME_MAX) return fail_('BAD_REQUEST');
  var displayName = sanitizeName(auth.displayName || '').slice(0, 60);

  if (!deps.tryLock()) return fail_('BUSY');
  try {
    var roster = deps.readRoster() || {};
    var bindings = deps.readBindings();
    var decision = decideBind(bindings, Object.keys(roster), cfg.roster_required, sid, email);
    if (decision === 'ALREADY_BOUND') {
      var prev = findBindingByEmail_(bindings, email);
      return ok_({ studentId: sid, name: String(prev.name), nameMismatch: !!prev.mismatch, alreadyBound: true });
    }
    if (decision) return fail_(decision);

    var mismatch = false;
    // 계정 표시 이름이 없으면 비교하지 않음
    if (displayName && !namesMatch(name, displayName)) mismatch = true;
    // 명단 이름과는 공백만 무시하고 정확히 비교
    var rosterName = Object.prototype.hasOwnProperty.call(roster, sid) ? String(roster[sid] || '') : '';
    var rosterDiffers = !!normName_(rosterName) && normName_(rosterName) !== normName_(name);
    // 개인 계정은 학교가 신원을 보증하지 않으므로 명단 이름과 다르면 거부 (학교 계정은 표시만)
    if (auth.personal && rosterDiffers) return fail_('NAME_MISMATCH');
    if (rosterDiffers) mismatch = true;

    deps.appendBinding({ id: sid, name: name, email: email, displayName: displayName, mismatch: mismatch,
      at: deps.now(), personal: !!auth.personal });
    return ok_({ studentId: sid, name: name, nameMismatch: mismatch, alreadyBound: false });
  } finally {
    deps.releaseLock();
  }
}

function doSubmit_(deps, cfg, req, email) {
  var html = req.html;
  var requestId = null;
  if (req.requestId !== undefined && req.requestId !== null) {
    if (typeof req.requestId !== 'string' || !REQUEST_ID_RE.test(req.requestId)) return fail_('BAD_REQUEST');
    requestId = req.requestId;
  }
  var bad = checkHtml(html, cfg.max_html_bytes);
  if (bad) return fail_(bad);
  var bodyHtml = stripSubmitMarkers(html);
  // 표식을 지운 뒤 남은 내용도 HTML 이어야 함
  bad = checkHtml(bodyHtml.replace(/^\s*(<!--\s*vibe-info:[^>]*?-->\s*)+/, ''), cfg.max_html_bytes);
  if (bad) return fail_(bad);
  if (!deps.rateLimit(email, cfg.submit_per_minute)) return fail_('BUSY', MSG_RATE_LIMITED);

  if (!deps.tryLock()) return fail_('BUSY');
  try {
    var b = findBindingByEmail_(deps.readBindings(), email);
    if (!b) return fail_('NOT_BOUND');
    var sid = String(b.id).trim();
    var subs = deps.readSubmissions();
    // 같은 이메일 + requestId 재전송이면 기존 결과를 그대로 돌려줌 (파일 새로 만들지 않음)
    if (requestId) {
      for (var i = 0; i < subs.length; i++) {
        var s = subs[i];
        if (String(s.requestId || '') === requestId && String(s.email).trim().toLowerCase() === email) {
          return ok_({ studentId: String(s.id).trim(), version: Number(s.version), size: Number(s.size),
            sha256: String(s.sha256 || '').slice(0, 12), submittedAt: toIso_(s.at), duplicate: true });
        }
      }
    }
    var content = buildMarker(sid, b.name) + bodyHtml;
    // size, sha256 은 서버 표식이 포함된 최종 파일 내용 기준 (sha256 은 앞 12자리)
    var size = utf8Length(content);
    var hash = String(deps.sha256Hex(content)).slice(0, 12);
    var version = nextVersion(subs, sid);
    var at = deps.now();
    var fileId = deps.saveFile(sid + '_v' + version + '_' + formatStamp_(at) + '.html', content);
    try {
      deps.appendSubmission({ at: at, id: sid, email: email, version: version, fileId: fileId, size: size,
        sha256: hash, requestId: requestId || '' });
    } catch (err) {
      try { deps.discardFile(fileId); } catch (e2) { /* 무시 */ }
      throw err;
    }
    return ok_({ studentId: sid, version: version, size: size, sha256: hash, submittedAt: at.toISOString() });
  } finally {
    deps.releaseLock();
  }
}

// ───────── 웹 앱 진입점 ─────────

function doPost(e) {
  var res;
  try {
    var body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    res = handleRequest(body, makeRealDeps());
  } catch (err) {
    console.error('doPost error: ' + String(err && err.message).slice(0, 200));
    res = fail_('SERVER_ERROR');
  }
  return jsonOut_(res);
}

function doGet(e) {
  return jsonOut_(ok_({ serverTime: new Date().toISOString(), version: VERSION }));
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────── 실제 deps (Google 서비스) ─────────

function makeRealDeps() {
  var lock = null;
  return {
    now: function () { return new Date(); },
    readConfig: function () {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
      return parseConfig(sh ? sh.getDataRange().getValues() : []);
    },
    verifyToken: realVerifyToken_,
    readRoster: function () {
      var out = {};
      dataRows_('Roster').forEach(function (r) {
        var id = String(r[0]).trim();
        if (validateStudentId(id)) out[id] = String(r[1] === null || r[1] === undefined ? '' : r[1]).trim();
      });
      return out;
    },
    readBindings: function () {
      return dataRows_('Bindings').filter(function (r) { return String(r[0]).trim(); }).map(function (r) {
        return { id: String(r[0]).trim(), name: String(r[1]), email: String(r[2]).trim().toLowerCase(),
          displayName: String(r[3]), mismatch: String(r[4]).trim().toUpperCase() === 'Y' };
      });
    },
    appendBinding: function (row) {
      appendRow_('Bindings', [row.id, textCell_(row.name), textCell_(row.email), textCell_(row.displayName),
        row.mismatch ? 'Y' : '', row.at, row.personal ? '개인' : '학교']);
    },
    readSubmissions: function () {
      return dataRows_('Submissions').filter(function (r) { return String(r[1]).trim(); }).map(function (r) {
        return { at: r[0], id: String(r[1]).trim(), email: String(r[2]).trim().toLowerCase(), version: Number(r[3]),
          size: Number(r[5]), sha256: String(r[6]), requestId: String(r[7] === null || r[7] === undefined ? '' : r[7]).trim() };
      });
    },
    saveFile: function (fileName, text) {
      return getSubmitFolder_().createFile(fileName, text, 'text/html').getId();
    },
    discardFile: function (fileId) {
      DriveApp.getFileById(fileId).setTrashed(true);
    },
    appendSubmission: function (row) {
      appendRow_('Submissions', [row.at, row.id, textCell_(row.email), row.version, row.fileId, row.size,
        row.sha256, row.requestId || '']);
    },
    rateLimit: realRateLimit_,
    sha256Hex: sha256HexReal_,
    tryLock: function () {
      lock = LockService.getScriptLock();
      return lock.tryLock(20000);
    },
    releaseLock: function () {
      if (!lock) return;
      try { SpreadsheetApp.flush(); } catch (e) { /* 무시 */ }
      try { lock.releaseLock(); } catch (e) { /* 무시 */ }
    },
    log: function (msg) { console.error(String(msg)); }
  };
}

function sha256HexReal_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

// base64url 조각 → UTF-8 문자열
function b64urlDecodeReal_(seg) {
  var s = String(seg);
  while (s.length % 4) s += '=';
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8');
}

// 이메일당 RATE_WINDOW 초에 RATE_MAX 회 (캐시 기반, 대략적인 제한)
function realRateLimit_(email, max) {
  max = max > 0 ? max : RATE_MAX;
  var cache = CacheService.getScriptCache();
  var bucket = Math.floor(Date.now() / (RATE_WINDOW * 1000));
  var key = 'rl:' + sha256HexReal_(String(email).toLowerCase()).slice(0, 32) + ':' + bucket;
  var n = Number(cache.get(key)) || 0;
  if (n >= max) return false;
  cache.put(key, String(n + 1), RATE_WINDOW * 2);
  return true;
}

function realVerifyToken_(token, cfg) {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return { ok: false, code: 'TOKEN_INVALID' };
  var clientId = PropertiesService.getScriptProperties().getProperty(PROP_CLIENT_ID);
  if (!clientId) return { ok: false, code: 'SERVER_ERROR', message: MSG_NO_CLIENT_ID };
  var nowSec = Math.floor(Date.now() / 1000);
  var cache = CacheService.getScriptCache();
  var hash = sha256HexReal_(token); // 원본 토큰은 저장·기록하지 않음
  var key = 'tok:' + hash;
  var badKey = 'bad:' + hash;
  var invalid = { ok: false, code: 'TOKEN_INVALID' };
  var claims = null;
  var hit = cache.get(key);
  if (hit) { try { claims = JSON.parse(hit); } catch (e) { claims = null; } }
  if (!claims) {
    if (cache.get(badKey)) return invalid;
    if (precheckToken(token, clientId, nowSec, b64urlDecodeReal_)) {
      cache.put(badKey, '1', 60);
      return invalid;
    }
    var res;
    try {
      res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo',
        { method: 'post', payload: { id_token: token }, muteHttpExceptions: true });
    } catch (e) {
      console.error('verify fetch failed'); // 예외 메시지에 비밀이 섞일 수 있어 고정 문구만 기록
      return { ok: false, code: 'SERVER_ERROR' };
    }
    var raw = null;
    if (res.getResponseCode() === 200) {
      try { raw = JSON.parse(res.getContentText()); } catch (e) { raw = null; }
    }
    if (!raw) { cache.put(badKey, '1', 60); return invalid; }
    claims = { aud: raw.aud, iss: raw.iss, exp: raw.exp, email: raw.email, email_verified: raw.email_verified,
      hd: raw.hd || '', name: raw.name || '' };
    var base = checkClaims(claims, clientId, [], nowSec);
    if (base) { cache.put(badKey, '1', 60); return { ok: false, code: base }; }
    var ttl = cacheTtl(Number(claims.exp), nowSec);
    if (ttl > 0) cache.put(key, JSON.stringify(claims), ttl);
  }
  // 도메인은 설정 변경을 반영하도록 매번 검사
  var code = checkClaims(claims, clientId, cfg.allowed_domains, nowSec, cfg.allow_personal);
  if (code) return { ok: false, code: code };
  return { ok: true, email: String(claims.email).toLowerCase(), domain: claimsDomain_(claims),
    displayName: String(claims.name || ''), personal: !claims.hd };
}

// 수식으로 해석되지 않도록 문자열 앞에 ' 추가
function textCell_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// 열이 모자라면 늘림
function ensureCols_(sh, n) {
  var have = sh.getMaxColumns();
  if (have < n) sh.insertColumnsAfter(have, n - have);
}

// 시트가 없으면 만들고, 빠진 머리글 칸을 채우고, 텍스트 열 서식을 지정
function ensureSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var head = SHEETS[name];
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    ensureCols_(sh, head.length);
    sh.getRange(1, 1, 1, head.length).setValues([head]);
    sh.setFrozenRows(1);
  } else {
    ensureCols_(sh, head.length);
    var cur = sh.getRange(1, 1, 1, head.length).getValues()[0];
    for (var i = 0; i < head.length; i++) {
      if (String(cur[i] === null || cur[i] === undefined ? '' : cur[i]).trim() === '') sh.getRange(1, i + 1).setValue(head[i]);
    }
  }
  (TEXT_COLS[name] || []).forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
  return sh;
}

function dataRows_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var want = SHEETS[name].length;
  var cols = Math.min(want, sh.getMaxColumns());
  return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues().map(function (r) {
    while (r.length < want) r.push('');
    return r;
  });
}

function appendRow_(name, values) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name) || ensureSheet_(name);
  ensureCols_(sh, values.length);
  var r = sh.getLastRow() + 1;
  var max = sh.getMaxRows();
  if (r > max) {
    // 행이 모자라면 추가하고 새 행의 텍스트 열 서식도 지정
    sh.insertRowsAfter(max, 100);
    (TEXT_COLS[name] || []).forEach(function (c) { sh.getRange(max + 1, c, 100, 1).setNumberFormat('@'); });
  }
  (TEXT_COLS[name] || []).forEach(function (c) { sh.getRange(r, c).setNumberFormat('@'); });
  sh.getRange(r, 1, 1, values.length).setValues([values]);
}

function getSubmitFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_FOLDER_ID);
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 다시 찾기 */ }
  }
  var it = DriveApp.getRootFolder().getFoldersByName(FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(FOLDER_NAME);
  props.setProperty(PROP_FOLDER_ID, folder.getId());
  return folder;
}

// 교사가 편집기에서 한 번 실행. 여러 번 실행해도 안전 (Submissions 에 요청ID 머리글이 없으면 추가).
function setup() {
  Object.keys(SHEETS).forEach(function (name) { ensureSheet_(name); });
  var cfgSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  var have = {};
  if (cfgSheet.getLastRow() >= 2) {
    cfgSheet.getRange(2, 1, cfgSheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      have[String(r[0]).trim().toLowerCase()] = true;
    });
  }
  CONFIG_DEFAULTS.forEach(function (kv) {
    if (!have[kv[0]]) cfgSheet.appendRow(kv);
  });
  getSubmitFolder_();
  if (!PropertiesService.getScriptProperties().getProperty(PROP_CLIENT_ID)) {
    console.warn('스크립트 속성 GOOGLE_CLIENT_ID 를 설정해야 로그인이 동작합니다.');
  }
}
