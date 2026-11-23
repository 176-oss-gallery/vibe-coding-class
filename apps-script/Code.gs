/**
 * 바이브 코딩 수업: 학생 HTML 게임 제출 웹 앱 (프로토타입, Apps Script V8)
 * 배포: 실행 계정 = 나(교사), 액세스 = 모든 사용자. 스프레드시트에 바인딩된 스크립트.
 * 처음 한 번: setup() 실행 (Accounts 탭·PASSWORD_PEPPER 생성). auth_mode=google 이면 GOOGLE_CLIENT_ID 도 설정.
 * 인증 방식(Config auth_mode): password(기본, 학번+학생이 정한 비밀번호) | google(구글 로그인 토큰)
 *
 * ── deps 인터페이스 (handleRequest(body, deps) 에 주입; 테스트에서는 가짜로 대체) ──
 *   now()                      → Date (서버 현재 시각)
 *   readConfig()               → parseConfig() 결과 객체
 *   verifyToken(idToken, cfg)  → { ok:true, email, domain, displayName }
 *                               | { ok:false, code, message? }   (code: TOKEN_INVALID | DOMAIN_NOT_ALLOWED | SERVER_ERROR)
 *   readRoster()               → { '<학번>': '<이름>', ... }   (일반 객체)
 *   upsertRoster(id, name)     → void (roster_required=FALSE 일 때 처음 등록하면 명단에 학번·이름 채움, 3열 '자동')
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
 *   log(msg)                   → void (토큰·비밀번호·HTML·요청 본문은 절대 넘기지 않음)
 *   ── 비밀번호 방식 ──
 *   readAccounts()             → [{ id, name, hash, salt, reset:boolean, resetAt:Date|string|'', row }]
 *   appendAccount(row)         → void; row = { id, name, hash, salt, at:Date }
 *   updateAccountPassword(id, { hash, salt, at }) → boolean (행 없으면 false). 초기화·초기화시각 칸을 비움
 *   getPepper()                → string | null (스크립트 속성 PASSWORD_PEPPER)
 *   newSalt()                  → 무작위 문자열
 *   reserveAttempt(id)         → { ok:true } | { ok:false, busy? } (시도 횟수를 먼저 1 올림. 이미 LOCK_AFTER 이상이면 ok:false → LOCKED, busy → BUSY)
 *   clearFails(id)             → void (성공 시 시도 횟수 초기화)
 *   globalFails() → number, addGlobalFail() → void (1분 단위 전체 오답 수)
 *   newSession(id)             → 세션 토큰 문자열 (6시간)
 *   resolveSession(token)      → { id, issuedAt:ms } | null (만료·버전 불일치면 null)
 *   bumpSessionVersion(id)     → void (그 학번의 기존 세션 모두 무효)
 *   비밀번호 방식에서 rateLimit 의 첫 인자는 'id:' + 학번
 */

// ───────── 상수 ─────────
var VERSION = 'lab-1';
var FOLDER_NAME = 'vibe-test-submissions';
var PROP_FOLDER_ID = 'SUBMIT_FOLDER_ID';
var PROP_CLIENT_ID = 'GOOGLE_CLIENT_ID';
var PROP_PEPPER = 'PASSWORD_PEPPER';
var ITERATIONS = 300;   // 비밀번호 해시 반복 횟수
var LOCK_AFTER = 5;     // 이 횟수만큼 틀리면 잠금
var LOCK_SEC = 300;     // 잠금 유지 시간(초)
var GLOBAL_FAIL_MAX = 40;   // 1분 동안 전체 오답이 이보다 많으면 BUSY
var SESSION_TTL = 21600;    // 세션 유지(초)
var PW_INPUT_MAX = 100; // 이보다 긴 입력은 형식 오류
var GOOGLE_ACTIONS = ['whoami', 'bind'];
var PASSWORD_ACTIONS = ['register', 'login', 'change_password'];
var SHARED_ACTIONS = ['submit', 'list_mine'];
// 비밀번호 방식에서 세션으로만 쓰는 동작: 글 제출, 투표, 내 현황
var SESSION_ACTIONS = ['note', 'like', 'status'];
var LIKE_PER_MINUTE = 60; // 좋아요는 여러 번 누르므로 제출보다 넉넉하게
var NOTE_SECTIONS = ['t1', 't2', 't3'];
var NOTE_MAX = 30000; // 글 한 칸(구글 시트 한 셀은 5만 자까지)
var BODY_EXTRA = 64 * 1024;
var BODY_HARD_MAX = 8 * 1024 * 1024; // 설정을 읽기 전 절대 상한
var REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
var RATE_MAX = 5;      // 이메일당 RATE_WINDOW 초 안에 최대 제출 수
var RATE_WINDOW = 60;
var NAME_MAX = 20;
var TOKEN_MAX = 4096;
var ID_RE = /^([1-3])(0[1-9]|1[0-6])(0[1-9]|[1-9]\d)$/; // tools/common.py 와 동일
var ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

var SHEETS = {
  Roster: ['학번', '이름', '추가'],
  Bindings: ['학번', '이름', '이메일', '계정표시이름', '이름불일치', '연결시각', '계정종류'],
  Submissions: ['시각', '학번', '이메일', '버전', '드라이브파일ID', '크기', 'sha256', '요청ID'],
  Config: ['키', '값'],
  Accounts: ['학번', '이름', '비밀번호해시', '솔트', '등록시각', '초기화', '변경시각', '초기화시각'],
  Notes: ['시각', '학번', '구간', '글'],
  Likes: ['시각', '학번', '반', '번호', '좋아요'], // 좋아요 누름(Y)·취소(N) 기록. (학번, 번호)마다 가장 나중 것이 지금 상태
  Gallery: ['학번', '반', '번호'] // 갤러리 작품 번호 명단(관리자가 올림). 자기 작품 투표를 막는 데 씀
};
// 텍스트 서식 열 (1부터): 학번·파일ID·해시·요청ID (숫자/지수로 바뀌지 않게)
var TEXT_COLS = { Roster: [1], Bindings: [1], Submissions: [2, 5, 7, 8], Accounts: [1, 3, 4], Notes: [2, 3, 4], Likes: [2], Gallery: [1] };

var CONFIG_DEFAULTS = [
  ['auth_mode', 'password'],   // password | google
  ['roster_required', 'FALSE'], // FALSE = 명단 없이 시작, 처음 등록할 때 명단에 자동 추가 / TRUE = 명단에 있는 학번만
  ['allowed_domains', ''],
  ['allow_personal', 'FALSE'], // TRUE면 allowed_domains가 있어도 개인 구글 계정(gmail 등) 허용. 대신 이름이 명단과 같아야 연결됨
  ['max_html_bytes', 2097152],
  ['session_open', 'TRUE'],
  ['submit_per_minute', 5],  // 계정당 1분 제출 상한. 부하 시험(T11) 때만 50 정도로 올린다
  ['vote_open', 'TRUE']      // FALSE면 좋아요를 받지 않음 (4차시가 끝나면 닫음)
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
  SERVER_ERROR: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
  NOT_REGISTERED: '아직 등록하지 않은 학번이에요. 먼저 등록해 주세요.',
  ALREADY_REGISTERED: '이미 등록된 학번이에요. 본인이 등록한 게 아니면 선생님께 알려 주세요.',
  WRONG_PASSWORD: '비밀번호가 맞지 않아요.',
  LOCKED: '비밀번호를 여러 번 틀렸어요. 5분 뒤에 다시 하거나 선생님께 초기화를 부탁하세요.',
  WEAK_PASSWORD: '비밀번호를 입력해 주세요.',
  MUST_CHANGE_PASSWORD: '새 비밀번호를 먼저 정해 주세요.',
  VOTE_CLOSED: '좋아요가 닫혔어요. 선생님께 물어보세요.',
  VOTE_NOT_READY: '아직 좋아요를 누를 수 없어요. 선생님이 작품을 올리면 누를 수 있어요.',
  NOT_IN_GALLERY: '우리 반 갤러리에 없는 번호예요. 번호를 다시 확인해 주세요.',
  SELF_VOTE: '내 작품에는 좋아요를 누를 수 없어요.',
  SESSION_EXPIRED: '로그인이 끝났어요. 다시 로그인해 주세요.'
};
var MSG_SAME_PASSWORD = '지금 비밀번호(학번)와 다른 새 비밀번호를 정해 주세요.';
var MSG_NAME_NOT_ROSTER = '이름이 명단과 달라요. 이름을 정확히 입력해 주세요.';
var MSG_ROSTER_NO_NAME = '명단에 이름이 비어 있어 등록할 수 없어요. 선생님께 알려 주세요.';
var MSG_NO_PEPPER = '서버 설정이 끝나지 않았어요. 선생님: setup() 을 실행해 주세요.';
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
  var cfg = { roster_required: true, allowed_domains: [], max_html_bytes: 2097152, session_open: true, submit_per_minute: RATE_MAX, allow_personal: false, auth_mode: 'password', vote_open: true };
  if (!rows || !rows.length) return cfg;
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i] || [];
    var key = String(r[0] === null || r[0] === undefined ? '' : r[0]).trim().toLowerCase();
    var val = r[1];
    if (key === 'roster_required') cfg.roster_required = parseBool_(val, true);
    else if (key === 'session_open') cfg.session_open = parseBool_(val, true);
    else if (key === 'vote_open') cfg.vote_open = parseBool_(val, true);
    else if (key === 'allow_personal') cfg.allow_personal = parseBool_(val, false);
    else if (key === 'auth_mode') cfg.auth_mode = String(val === null || val === undefined ? '' : val).trim().toLowerCase() === 'google' ? 'google' : 'password';
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

// 비밀번호 해시: h = 비밀번호, h = sha256(h + 솔트 + 페퍼) 를 iterations 번 반복
function hashPassword(password, salt, pepper, sha256HexFn, iterations) {
  var n = iterations > 0 ? Math.floor(iterations) : ITERATIONS;
  var h = String(password);
  for (var i = 0; i < n; i++) h = String(sha256HexFn(h + String(salt) + String(pepper)));
  return h;
}

// 길이와 무관하게 끝까지 비교 (시간 차이로 내용이 드러나지 않게)
function safeEqual(a, b) {
  var x = String(a === null || a === undefined ? '' : a), y = String(b === null || b === undefined ? '' : b);
  var diff = x.length ^ y.length;
  var len = Math.max(x.length, y.length);
  for (var i = 0; i < len; i++) diff |= (x.charCodeAt(i % (x.length || 1)) || 0) ^ (y.charCodeAt(i % (y.length || 1)) || 0);
  return diff === 0;
}

// 비밀번호 규칙: 빈칸만 아니면 됨(학생들이 기억하기 쉽게 규칙을 두지 않음). 너무 긴 입력은 형식 오류로 따로 막음
function validatePassword(pw) {
  if (typeof pw !== 'string' || !pw.length || pw.length > PW_INPUT_MAX) return 'WEAK_PASSWORD';
  return null;
}

function toMs_(v) {
  if (isDate_(v)) return v.getTime();
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return NaN;
  return Date.parse(String(v));
}

function isLocked(n) {
  return Number(n) >= LOCK_AFTER;
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
  var known = GOOGLE_ACTIONS.concat(PASSWORD_ACTIONS, SHARED_ACTIONS, SESSION_ACTIONS);
  if (typeof action !== 'string' || known.indexOf(action) < 0) return fail_('BAD_REQUEST');

  var cfg = deps.readConfig();
  if (utf8Length(body) > cfg.max_html_bytes + BODY_EXTRA) return fail_('BAD_REQUEST');
  var pwMode = cfg.auth_mode !== 'google';
  // 현재 인증 방식에 맞지 않는 동작은 거부
  if (pwMode && GOOGLE_ACTIONS.indexOf(action) >= 0) return fail_('BAD_REQUEST');
  if (!pwMode && (PASSWORD_ACTIONS.indexOf(action) >= 0 || SESSION_ACTIONS.indexOf(action) >= 0)) return fail_('BAD_REQUEST');

  // 무거운 작업 전에 제출 시간 확인
  if (action === 'submit' && !cfg.session_open) return fail_('SESSION_CLOSED');

  if (pwMode) return routePassword_(deps, cfg, req, action);

  var auth = deps.verifyToken(req.idToken, cfg);
  if (!auth || !auth.ok) {
    var code = auth && auth.code && MESSAGES[auth.code] ? auth.code : 'TOKEN_INVALID';
    return fail_(code, auth && auth.message);
  }
  var email = String(auth.email).trim().toLowerCase();

  if (action === 'whoami') return doWhoami_(deps, auth, email);
  if (action === 'list_mine') return doListMine_(deps, email);
  if (action === 'bind') return doBind_(deps, cfg, req, auth, email);
  return doSubmit_(deps, cfg, req, { email: email });
}

// ───────── 비밀번호 방식 ─────────

function readStudentId_(req) {
  var raw = req.studentId;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  var sid = String(raw).trim();
  return validateStudentId(sid) ? sid : null;
}

function isPwInput_(v) {
  return typeof v === 'string' && v.length <= PW_INPUT_MAX;
}

function findAccount_(accounts, sid) {
  for (var i = 0; i < accounts.length; i++) if (String(accounts[i].id).trim() === sid) return accounts[i];
  return null;
}

// 학번+비밀번호 확인 → { acc, mustChange } 또는 { fail: 응답 }
// 선생님 초기화(초기화=Y) 상태면 비밀번호는 학번이고, 로그인하면 새 비밀번호를 먼저 정해야 함(mustChange). 학번은 비밀이 아니므로 학번별 잠금은 걸지 않음
// (초기화가 잠금 해제 역할도 함). 전체 오답 상한은 그대로 적용.
function authPassword_(deps, sid, password, pepper) {
  var acc = findAccount_(deps.readAccounts() || [], sid);
  if (!acc) return { fail: fail_('NOT_REGISTERED') };
  if (Number(deps.globalFails()) > GLOBAL_FAIL_MAX) return { fail: fail_('BUSY') };
  var good;
  if (acc.reset) {
    good = safeEqual(String(password), sid);
  } else {
    var rsv = deps.reserveAttempt(sid); // 해시 전에 시도 횟수를 먼저 올림 (동시 요청 경쟁 방지)
    if (!rsv || !rsv.ok) return { fail: fail_(rsv && rsv.busy ? 'BUSY' : 'LOCKED') };
    good = safeEqual(hashPassword(password, acc.salt, pepper, deps.sha256Hex, ITERATIONS), acc.hash);
  }
  if (!good) {
    deps.addGlobalFail();
    return { fail: fail_('WRONG_PASSWORD') };
  }
  deps.clearFails(sid);
  return { acc: acc, mustChange: !!acc.reset };
}

// 세션 토큰 → { acc } 또는 { fail }
function authSession_(deps, token) {
  if (typeof token !== 'string' || token.length > 200) return { fail: fail_('BAD_REQUEST') };
  var sess = /^[A-Za-z0-9]{16,200}$/.test(token) ? deps.resolveSession(token) : null;
  if (!sess || !sess.id) return { fail: fail_('SESSION_EXPIRED') };
  var acc = findAccount_(deps.readAccounts() || [], String(sess.id));
  if (!acc) return { fail: fail_('SESSION_EXPIRED') };
  // 세션 발급 뒤 선생님이 초기화했으면 무효
  var rAt = toMs_(acc.resetAt);
  if (acc.reset && isFinite(rAt) && rAt >= Number(sess.issuedAt || 0)) return { fail: fail_('SESSION_EXPIRED') };
  return { acc: acc };
}

function routePassword_(deps, cfg, req, action) {
  var acc;
  // 글·투표·현황은 세션으로만
  if (SESSION_ACTIONS.indexOf(action) >= 0) {
    var ss = authSession_(deps, req.session);
    if (ss.fail) return ss.fail;
    var sidN = String(ss.acc.id).trim();
    if (action === 'note') return doNote_(deps, cfg, req, sidN);
    if (action === 'like') return doLike_(deps, cfg, req, sidN);
    return doStatus_(deps, cfg, sidN);
  }
  // submit·list_mine 은 세션 우선
  if (SHARED_ACTIONS.indexOf(action) >= 0 && req.session !== undefined && req.session !== null) {
    var sa = authSession_(deps, req.session);
    if (sa.fail) return sa.fail;
    acc = sa.acc;
    var sidS = String(acc.id).trim();
    if (action === 'list_mine') return listFor_(deps, sidS);
    return doSubmit_(deps, cfg, req, { sid: sidS, name: String(acc.name) });
  }

  var sid = readStudentId_(req);
  if (!sid) return fail_('BAD_REQUEST');
  if (!isPwInput_(req.password)) return fail_('BAD_REQUEST');
  var pepper = deps.getPepper();
  if (!pepper) return fail_('SERVER_ERROR', MSG_NO_PEPPER);

  if (action === 'register') return doRegister_(deps, cfg, req, sid, pepper);
  if (action === 'change_password' && !isPwInput_(req.newPassword)) return fail_('BAD_REQUEST');

  var a = authPassword_(deps, sid, req.password, pepper);
  if (a.fail) return a.fail;
  var name = String(a.acc.name);

  if (action === 'login') {
    // 변경이 필요한 동안에는 세션을 주지 않음 (change_password 후 발급)
    return ok_({ studentId: sid, name: name, mustChange: a.mustChange, session: a.mustChange ? null : deps.newSession(sid) });
  }
  if (action === 'change_password') return doChangePassword_(deps, req, sid, name, pepper);
  if (a.mustChange) return fail_('MUST_CHANGE_PASSWORD');
  if (action === 'list_mine') return listFor_(deps, sid);
  return doSubmit_(deps, cfg, req, { sid: sid, name: name });
}

// 1·2·4차시 글 제출 (구글 폼 대신). 같은 구간을 다시 내면 가장 나중 것이 쓰임. 서약 문구는 글 맨 위에 학생 앱이 넣음
function doNote_(deps, cfg, req, sid) {
  if (NOTE_SECTIONS.indexOf(req.section) < 0) return fail_('BAD_REQUEST');
  if (typeof req.text !== 'string') return fail_('BAD_REQUEST');
  var text = req.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim();
  if (!text || text.length > NOTE_MAX) return fail_('BAD_REQUEST');
  if (!cfg.session_open) return fail_('SESSION_CLOSED');
  if (!deps.rateLimit('note:' + sid, cfg.submit_per_minute)) return fail_('BUSY', MSG_RATE_LIMITED);
  var at = deps.now();
  if (!deps.tryLock()) return fail_('BUSY');
  try {
    deps.appendNote({ at: at, id: sid, section: req.section, text: text });
  } finally {
    deps.releaseLock();
  }
  return ok_({ section: req.section, savedAt: at.toISOString(), length: text.length });
}

// 4차시 투표: 가장 마음에 드는 작품 번호 하나(1~99). 반은 로그인한 학번에서 정함. 다시 내면 가장 나중 것이 쓰임
// 작품 번호 명단(Gallery)에 있는 우리 반 번호만 받고, 내 작품 번호는 막는다. 명단이 없으면 투표를 받지 않음
function parsePick_(v) {
  if (typeof v === 'string' && /^\d{1,2}$/.test(v.trim())) v = Number(v.trim());
  if (typeof v !== 'number' || v !== Math.floor(v) || v < 1 || v > 99) return null;
  return v;
}

// 학번의 반 번호(갤러리는 반 번호로 나뉨)
function classNo_(sid) {
  return Number(String(sid).slice(1, 3));
}

// 순수: 이 학생 반의 작품 번호들과 이 학생 작품 번호
function galleryFor_(gallery, sid) {
  var c = classNo_(sid), mine = null, nums = [];
  (gallery || []).forEach(function (g) {
    if (Number(g.cls) !== c) return;
    var n = Number(g.n);
    nums.push(n);
    if (String(g.id).trim() === sid) mine = n;
  });
  return { nums: nums, mine: mine };
}

// 4차시 좋아요: 우리 반 작품마다 누르거나(on: true) 취소(on: false). 여러 작품에 누를 수 있고 내 작품은 안 됨
function doLike_(deps, cfg, req, sid) {
  var n = parsePick_(req.n);
  if (n === null || typeof req.on !== 'boolean') return fail_('BAD_REQUEST');
  if (!cfg.vote_open) return fail_('VOTE_CLOSED');
  var g = galleryFor_(deps.readGallery(), sid);
  if (!g.nums.length) return fail_('VOTE_NOT_READY');
  if (g.mine === n) return fail_('SELF_VOTE');
  if (g.nums.indexOf(n) < 0) return fail_('NOT_IN_GALLERY');
  if (!deps.rateLimit('like:' + sid, LIKE_PER_MINUTE)) return fail_('BUSY', MSG_RATE_LIMITED);
  var at = deps.now();
  if (!deps.tryLock()) return fail_('BUSY');
  try {
    deps.appendLike({ at: at, id: sid, cls: classNo_(sid), n: n, on: req.on });
  } finally {
    deps.releaseLock();
  }
  return ok_({ savedAt: at.toISOString(), n: n, on: req.on });
}

// 순수: 좋아요 기록에서 지금 눌려 있는 것만. (학번, 번호)마다 가장 나중 기록이 Y 인 것 → [{ id, cls, n, at }]
function currentLikes_(likes) {
  var last = {};
  (likes || []).forEach(function (l) {
    var id = String(l.id).trim(), n = Number(l.n);
    if (!validateStudentId(id) || !isFinite(n) || n < 1) return;
    var k = id + '|' + n, t = toMs_(l.at);
    if (!last[k] || (isFinite(t) && t >= toMs_(last[k].at))) last[k] = { id: id, cls: classNo_(id), n: n, at: l.at, on: !!l.on };
  });
  return Object.keys(last).map(function (k) { return last[k]; }).filter(function (x) { return x.on; });
}

function likedBy_(cur, sid) {
  return cur.filter(function (x) { return x.id === sid; }).map(function (x) { return x.n; }).sort(function (a, b) { return a - b; });
}

// 내 제출 현황: 글 구간별 마지막 저장 시각, 마지막 투표, 투표 열림 여부 (글 내용은 돌려주지 않음)
function doStatus_(deps, cfg, sid) {
  var notes = {};
  (deps.readNotesMeta() || []).forEach(function (r) {
    if (String(r.id).trim() !== sid || NOTE_SECTIONS.indexOf(r.section) < 0) return;
    var t = toMs_(r.at);
    if (isFinite(t) && (!notes[r.section] || t > toMs_(notes[r.section]))) notes[r.section] = new Date(t).toISOString();
  });
  var likes = likedBy_(currentLikes_(deps.readLikes()), sid);
  var g = galleryFor_(deps.readGallery(), sid);
  return ok_({ notes: notes, likes: likes, voteOpen: !!cfg.vote_open, sessionOpen: !!cfg.session_open,
    galleryReady: g.nums.length > 0, myNumber: g.mine });
}

function doRegister_(deps, cfg, req, sid, pepper) {
  if (typeof req.name !== 'string') return fail_('BAD_REQUEST');
  var name = sanitizeName(req.name);
  if (!name || name.length > NAME_MAX) return fail_('BAD_REQUEST');
  if (validatePassword(req.password)) return fail_('WEAK_PASSWORD');
  // 해시는 전역 잠금 밖에서 계산
  var salt = String(deps.newSalt());
  var hash = hashPassword(req.password, salt, pepper, deps.sha256Hex, ITERATIONS);

  if (!deps.tryLock()) return fail_('BUSY');
  try {
    var roster = deps.readRoster() || {};
    var inRoster = Object.prototype.hasOwnProperty.call(roster, sid);
    if (cfg.roster_required && !inRoster) return fail_('NOT_IN_ROSTER');
    var rosterName = inRoster ? String(roster[sid] || '') : '';
    // 명단에 이름이 비어 있으면 아무 이름으로나 등록될 수 있으므로 거부 (선생님이 이름을 채워야 함)
    if (cfg.roster_required && !normName_(rosterName)) return fail_('NOT_IN_ROSTER', MSG_ROSTER_NO_NAME);
    // 비밀번호 방식은 신원 보증이 없으므로 명단 이름과 다르면 항상 거부
    if (normName_(rosterName) && normName_(rosterName) !== normName_(name)) return fail_('NAME_MISMATCH', MSG_NAME_NOT_ROSTER);
    if (findAccount_(deps.readAccounts() || [], sid)) return fail_('ALREADY_REGISTERED');
    deps.appendAccount({ id: sid, name: name, hash: hash, salt: salt, at: deps.now() });
    // 명단 없이 시작하는 경우(roster_required=FALSE): 처음 등록할 때 명단에 학번·이름을 채움
    if (!cfg.roster_required && !normName_(rosterName)) deps.upsertRoster(sid, name);
  } finally {
    deps.releaseLock();
  }
  return ok_({ studentId: sid, name: name, session: deps.newSession(sid) });
}

function doChangePassword_(deps, req, sid, name, pepper) {
  var np = req.newPassword;
  if (validatePassword(np)) return fail_('WEAK_PASSWORD');
  if (np === req.password) return fail_('WEAK_PASSWORD', MSG_SAME_PASSWORD);
  // 해시는 전역 잠금 밖에서 계산
  var salt = String(deps.newSalt());
  var hash = hashPassword(np, salt, pepper, deps.sha256Hex, ITERATIONS);
  if (!deps.tryLock()) return fail_('BUSY');
  try {
    if (!deps.updateAccountPassword(sid, { hash: hash, salt: salt, at: deps.now() })) return fail_('NOT_REGISTERED');
  } finally {
    deps.releaseLock();
  }
  deps.bumpSessionVersion(sid); // 예전 세션 모두 무효
  return ok_({ studentId: sid, name: name, session: deps.newSession(sid) });
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
  return listFor_(deps, String(b.id).trim());
}

function listFor_(deps, sid) {
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

// who = { email } (구글 방식: 연결된 학번을 잠금 안에서 찾음) | { sid, name } (비밀번호 방식)
function doSubmit_(deps, cfg, req, who) {
  var pwMode = !!who.sid;
  var email = pwMode ? '' : who.email;
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
  if (!deps.rateLimit(pwMode ? 'id:' + who.sid : email, cfg.submit_per_minute)) return fail_('BUSY', MSG_RATE_LIMITED);

  // 학번 확인 (연결 기록은 추가만 되므로 잠금 밖에서 읽어도 됨)
  var sid, markName;
  if (pwMode) {
    sid = who.sid;
    markName = who.name;
  } else {
    var b = findBindingByEmail_(deps.readBindings(), email);
    if (!b) return fail_('NOT_BOUND');
    sid = String(b.id).trim();
    markName = b.name;
  }
  var sameReq = function (s) {
    if (!requestId || String(s.requestId || '') !== requestId) return false;
    return pwMode ? String(s.id).trim() === sid : String(s.email).trim().toLowerCase() === email;
  };
  var dupOut = function (s) {
    return ok_({ studentId: String(s.id).trim(), version: Number(s.version), size: Number(s.size),
      sha256: String(s.sha256 || '').slice(0, 12), submittedAt: toIso_(s.at), duplicate: true });
  };
  // 주의: Submissions 는 잠금을 잡기 전에 읽지 않는다. 앱스크립트는 한 실행 안에서 같은 범위를 다시 읽으면
  // 처음 읽은 값을 돌려줄 수 있어서, 잠금 밖에서 먼저 읽으면 잠금 안의 버전 계산이 옛 값으로 된다(버전 중복).
  // 재전송 확인은 잠금 안에서만 한다(재전송은 드물고, 그때 만든 파일은 버린다).

  // 무거운 일(내용 만들기, 해시, 드라이브 저장)은 잠금 밖에서. 잠금 안에서는 버전 번호와 기록만.
  var content = buildMarker(sid, markName) + bodyHtml;
  // size, sha256 은 서버 표식이 포함된 최종 파일 내용 기준 (sha256 은 앞 12자리)
  var size = utf8Length(content);
  var hash = String(deps.sha256Hex(content)).slice(0, 12);
  var at = deps.now();
  var stamp = formatStamp_(at);
  var fileId = deps.saveFile(sid + '_' + stamp + '_' + String(hash).slice(0, 6) + '.html', content);

  var version = null, dup = null;
  if (!deps.tryLock()) {
    try { deps.discardFile(fileId); } catch (e0) { /* 무시 */ }
    return fail_('BUSY');
  }
  try {
    var subs = deps.readSubmissions();
    // 같은 (이메일 | 비밀번호 방식은 학번) + requestId 가 잠금을 기다리는 사이 저장됐으면 그 결과를 돌려줌
    for (var i = 0; i < subs.length && !dup; i++) if (sameReq(subs[i])) dup = subs[i];
    if (!dup) {
      version = nextVersion(subs, sid);
      deps.appendSubmission({ at: at, id: sid, email: email, version: version, fileId: fileId, size: size,
        sha256: hash, requestId: requestId || '' });
    }
  } catch (err) {
    try { deps.discardFile(fileId); } catch (e2) { /* 무시 */ }
    throw err;
  } finally {
    deps.releaseLock();
  }
  if (dup) {
    try { deps.discardFile(fileId); } catch (e3) { /* 무시 */ }
    return dupOut(dup);
  }
  // 버전이 정해진 뒤 파일 이름 정리 (실패해도 기록은 이미 남음)
  var finalName = sid + '_v' + version + '_' + stamp + '.html';
  try {
    deps.renameFile(fileId, finalName);
  } catch (e4) {
    deps.log('rename failed');
  }
  return ok_({ studentId: sid, version: version, size: size, sha256: hash, submittedAt: at.toISOString() });
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
  // ?admin=<주소 열쇠> → 선생님 관리자 화면. 열쇠는 스크립트 속성 ADMIN_KEY (없으면 1). 틀리면 평소와 같은 응답만 준다.
  if (e && e.parameter && e.parameter.admin) {
    var key = String(PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || '1');
    if (safeEqual(String(e.parameter.admin), key)) return adminPage_();
  }
  return jsonOut_(ok_({ serverTime: new Date().toISOString(), version: VERSION }));
}

// ───────── 선생님 관리자 화면 ─────────
// 열 수 있는 사람: 스크립트 주인(배포한 선생님) + 스크립트 속성 ADMIN_EMAILS(쉼표로 구분)에 적은 같은 학교 계정.
// 학생·다른 계정·로그인 안 한 사람은 이메일이 같지 않거나 빈칸이므로 거부된다.
var ADMIN_LIST_MAX = 300;
var ADMIN_ZIP_MAX_B64 = 30 * 1024 * 1024; // 한 번에 내려받는 zip 상한(문자 수). 반 하나는 훨씬 작음

function classLabel_(key) {
  return Number(key.charAt(0)) + '학년 ' + Number(key.slice(1)) + '반';
}

// 순수: 좋아요 순위. 반(반 번호)마다 좋아요를 누른 학생 수와 작품 번호별 받은 좋아요 수(많은 순)
function adminTally(likes) {
  var byClass = {};
  currentLikes_(likes).forEach(function (x) {
    var c = byClass[x.cls] || (byClass[x.cls] = { voters: {}, m: {} });
    c.voters[x.id] = true;
    c.m[x.n] = (c.m[x.n] || 0) + 1;
  });
  return Object.keys(byClass).map(Number).sort(function (a, b) { return a - b; }).map(function (c) {
    var x = byClass[c];
    var top = Object.keys(x.m).map(function (n) { return { n: Number(n), count: x.m[n] }; })
      .sort(function (a, b) { return b.count - a.count || a.n - b.n; });
    return { key: String(c), label: c + '반', voters: Object.keys(x.voters).length, top: top };
  });
}

function csvCell_(v) {
  var t = String(v === null || v === undefined ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // 엑셀이 수식으로 읽지 않게
  return '"' + t.replace(/"/g, '""') + '"';
}

// 순수: 글 내려받기 CSV. 학생 한 명이 한 줄이고 1차시·2~3차시·4차시 글(각각 가장 나중 것)이 옆으로 나란히.
// classKey(학년+반 3자리)가 비면 전체. 등록한 학생은 글이 없어도 줄이 있음(빈칸 = 안 냄). 열 이름에 '학번'이 있어 ingest.py --form1 에도 쓸 수 있음
function adminNotesCsv(accounts, notes, classKey) {
  var nameOf = {}, ids = {};
  (accounts || []).forEach(function (a) {
    var id = String(a.id).trim();
    if (!validateStudentId(id) || (classKey && id.slice(0, 3) !== classKey)) return;
    nameOf[id] = String(a.name); ids[id] = true;
  });
  var latest = {};
  (notes || []).forEach(function (n) {
    var id = String(n.id).trim();
    if (!validateStudentId(id) || NOTE_SECTIONS.indexOf(n.section) < 0) return;
    if (classKey && id.slice(0, 3) !== classKey) return;
    ids[id] = true;
    var k = id + '|' + n.section;
    var t = toMs_(n.at);
    if (!latest[k] || (isFinite(t) && t >= toMs_(latest[k].at))) latest[k] = n;
  });
  var list = Object.keys(ids).sort();
  var head = ['학번', '이름'];
  NOTE_SECTIONS.forEach(function (sec) { head.push(NOTE_LABELS[sec], NOTE_LABELS[sec] + ' 제출시각'); });
  var lines = [head.map(csvCell_).join(',')];
  list.forEach(function (id) {
    var row = [id, nameOf[id] || ''];
    NOTE_SECTIONS.forEach(function (sec) {
      var n = latest[id + '|' + sec];
      row.push(n ? n.text : '', n ? toIsoOrEmpty_(n.at) : '');
    });
    lines.push(row.map(csvCell_).join(','));
  });
  return { csv: '\uFEFF' + lines.join('\r\n') + '\r\n', count: list.length };
}

var NOTE_LABELS = { t1: '1차시 기획서', t2: '2~3차시 제작 기록', t3: '4차시 소감' };

// 순수: 관리자 "글 보기". 한 학생의 구간별 가장 나중 글과 제출 횟수. 없는 구간도 빈 칸으로 돌려줌
function adminStudentNotes(notes, sid) {
  var by = {};
  (notes || []).forEach(function (n) {
    if (String(n.id).trim() !== sid || NOTE_SECTIONS.indexOf(n.section) < 0) return;
    var cur = by[n.section] || (by[n.section] = { last: null, times: 0 });
    cur.times++;
    var t = toMs_(n.at);
    if (!cur.last || (isFinite(t) && t >= toMs_(cur.last.at))) cur.last = n;
  });
  return NOTE_SECTIONS.map(function (sec) {
    var c = by[sec];
    return { section: sec, label: NOTE_LABELS[sec], times: c ? c.times : 0,
      at: c ? toIsoOrEmpty_(c.last.at) : '', text: c ? String(c.last.text) : '' };
  });
}

// 순수: 좋아요 내려받기 CSV. 지금 눌려 있는 좋아요 하나가 한 줄 (학번, 반, 번호)
function adminVotesCsv(likes) {
  var cur = currentLikes_(likes).sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : a.n - b.n; });
  var lines = [['학번', '반', '번호'].map(csvCell_).join(',')];
  cur.forEach(function (x) { lines.push([x.id, x.cls, x.n].map(csvCell_).join(',')); });
  return { csv: '﻿' + lines.join('\r\n') + '\r\n', count: cur.length };
}

// 순수: 관리자가 붙여넣은 작품 번호 명단 읽기. private/mapping.csv 그대로(머리글로 학번·반·번호·공개 열을 찾음)
// 또는 머리글 없이 "학번,반,번호". 공개 열이 있으면 Y 인 줄만. → { rows:[{id,cls,n}], skipped }
var GALLERY_TEXT_MAX = 200000;
function parseGalleryText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > GALLERY_TEXT_MAX) return null;
  var lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  var split = function (l) {
    return l.split(l.indexOf('\t') >= 0 ? '\t' : ',').map(function (c) { return c.trim().replace(/^"|"$/g, '').replace(/""/g, '"').trim(); });
  };
  var head = split(lines[0]);
  var col = { id: 0, cls: 1, n: 2, pub: -1 };
  if (head.indexOf('학번') >= 0) {
    col = { id: head.indexOf('학번'), cls: head.indexOf('반'), n: head.indexOf('번호'), pub: head.indexOf('공개') };
    if (col.cls < 0 || col.n < 0) return null;
    lines = lines.slice(1);
  }
  var rows = [], seen = {}, taken = {}, skipped = 0;
  lines.forEach(function (l) {
    var c = split(l);
    var id = String(c[col.id] || '').trim(), cls = Number(c[col.cls]), n = Number(c[col.n]);
    var pubOk = col.pub < 0 || String(c[col.pub] || '').trim().toUpperCase() === 'Y';
    if (!validateStudentId(id) || !pubOk || cls !== Math.floor(cls) || cls < 1 || cls > 16 || n !== Math.floor(n) || n < 1 || n > 99 ||
        classNo_(id) !== cls || seen[id] || taken[cls + '|' + n]) { skipped++; return; }
    seen[id] = true; taken[cls + '|' + n] = true;
    rows.push({ id: id, cls: cls, n: n });
  });
  return { rows: rows, skipped: skipped };
}

function galleryInfo_(gallery) {
  var by = {};
  (gallery || []).forEach(function (g) { by[g.cls] = (by[g.cls] || 0) + 1; });
  return { count: (gallery || []).length, classes: Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (c) { return c + '반 ' + by[c] + '개'; }) };
}

// 순수: 학번마다 가장 높은 버전 하나만. classKey 가 비면 전체, 아니면 학번 앞 3자리(학년+반)가 같은 것만
function adminLatest(submissions, classKey) {
  var best = {};
  (submissions || []).forEach(function (r) {
    var id = String(r.id).trim();
    if (!validateStudentId(id) || !String(r.fileId || '').trim()) return;
    if (classKey && id.slice(0, 3) !== classKey) return;
    var v = Number(r.version);
    if (!isFinite(v)) return;
    if (!best[id] || v > best[id].version) best[id] = { id: id, version: v, fileId: String(r.fileId).trim() };
  });
  return Object.keys(best).sort().map(function (id) {
    var b = best[id];
    return { id: id, version: b.version, fileId: b.fileId, name: id + '_v' + b.version + '.html' };
  });
}

// 순수(deps 주입): 관리자 비밀번호 확인 (같은 학교 계정이 아닌 선생님용). → 'OK' | 'WRONG' | 'NONE'
// 여러 선생님이 함께 쓰므로 틀려도 잠그지 않는다(주소 열쇠 ADMIN_KEY 를 알아야 비밀번호 칸이 나옴).
// deps: getAdminPassword()
function adminPasswordCheck(deps, pw) {
  var real = String(deps.getAdminPassword() || '');
  if (!real) return 'NONE';
  if (typeof pw === 'string' && pw.length <= 200 && safeEqual(pw, real)) return 'OK';
  return 'WRONG';
}

// 순수: 관리자 목록 행 만들기. query 는 학번 일부 또는 이름 일부(공백 무시)
// 행마다 제출 여부: t1·t2·t3(글 마지막 시각), count·lastAt(게임), likeCount·likeAt(누른 좋아요 수·마지막 시각)
function adminRows(accounts, submissions, query, lockedIds, notesMeta, likes) {
  var q = String(query === null || query === undefined ? '' : query).replace(/\s+/g, '').toLowerCase();
  var locked = {};
  (lockedIds || []).forEach(function (id) { locked[String(id)] = true; });
  var stat = {};
  (submissions || []).forEach(function (s) {
    var id = String(s.id).trim();
    var t = toMs_(s.at);
    var cur = stat[id] || (stat[id] = { count: 0, last: NaN });
    cur.count++;
    if (isFinite(t) && (!isFinite(cur.last) || t > cur.last)) cur.last = t;
  });
  var note = {};
  (notesMeta || []).forEach(function (n) {
    var id = String(n.id).trim();
    if (NOTE_SECTIONS.indexOf(n.section) < 0) return;
    var t = toMs_(n.at);
    var cur = note[id] || (note[id] = {});
    if (isFinite(t) && (!cur[n.section] || t > cur[n.section])) cur[n.section] = t;
  });
  var lk = {};
  currentLikes_(likes).forEach(function (x) {
    var c = lk[x.id] || (lk[x.id] = { count: 0, last: NaN });
    c.count++;
    var t = toMs_(x.at);
    if (isFinite(t) && (!isFinite(c.last) || t > c.last)) c.last = t;
  });
  var iso = function (t) { return t && isFinite(t) ? new Date(t).toISOString() : ''; };
  var rows = (accounts || []).filter(function (a) {
    if (!q) return true;
    return String(a.id).indexOf(q) >= 0 || normName_(a.name).toLowerCase().indexOf(q) >= 0;
  }).map(function (a) {
    var id = String(a.id);
    var s = stat[id] || { count: 0, last: NaN };
    var nt = note[id] || {};
    var l = lk[id] || { count: 0, last: NaN };
    return { id: id, name: String(a.name), registeredAt: toIsoOrEmpty_(a.at), reset: !!a.reset,
      locked: !!locked[id], count: s.count, lastAt: iso(s.last),
      t1: iso(nt.t1), t2: iso(nt.t2), t3: iso(nt.t3),
      likeCount: l.count, likeAt: iso(l.last) };
  });
  rows.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
  return { total: (accounts || []).length, shown: Math.min(rows.length, ADMIN_LIST_MAX), rows: rows.slice(0, ADMIN_LIST_MAX) };
}

function toIsoOrEmpty_(v) {
  var t = toMs_(v);
  return isFinite(t) ? new Date(t).toISOString() : '';
}

// 순수(deps 주입): 관리자 동작. 권한 확인은 호출하는 쪽(adminList/adminReset)에서 먼저 함
function adminHandle(deps, action, arg) {
  if (action === 'list') {
    var accounts = deps.readAccounts() || [];
    var locked = deps.lockedIds(accounts.map(function (a) { return a.id; })) || [];
    return ok_(adminRows(accounts, deps.readSubmissions(), arg, locked, deps.readNotesMeta(), deps.readLikes()));
  }
  if (action === 'classes') {
    var latestAll = adminLatest(deps.readSubmissions(), '');
    var by = {};
    latestAll.forEach(function (x) { var k = x.id.slice(0, 3); by[k] = (by[k] || 0) + 1; });
    return ok_({ classes: Object.keys(by).sort().map(function (k) { return { key: k, label: Number(k[0]) + '학년 ' + Number(k.slice(1)) + '반', count: by[k] }; }) });
  }
  if (action === 'tally') {
    return ok_({ voteOpen: !!deps.voteOpen(), classes: adminTally(deps.readLikes()) });
  }
  if (action === 'notes') {
    var nk = String(arg === null || arg === undefined ? '' : arg);
    if (nk && !/^[1-3](0[1-9]|1[0-6])$/.test(nk)) return fail_('BAD_REQUEST');
    var nc = adminNotesCsv(deps.readAccounts() || [], deps.readNotes() || [], nk);
    if (!nc.count) return fail_('NOT_FOUND');
    return ok_({ name: 'notes_' + (nk || 'all') + '.csv', count: nc.count, csv: nc.csv });
  }
  if (action === 'note_view') {
    var vid = String(arg === null || arg === undefined ? '' : arg).trim();
    if (!validateStudentId(vid)) return fail_('BAD_REQUEST');
    var vacc = findAccount_(deps.readAccounts() || [], vid);
    var gs = (deps.readSubmissions() || []).filter(function (x) { return String(x.id).trim() === vid; });
    var glast = NaN, gver = 0;
    gs.forEach(function (x) { var t = toMs_(x.at); if (isFinite(t) && (!isFinite(glast) || t > glast)) glast = t; if (Number(x.version) > gver) gver = Number(x.version); });
    var curL = currentLikes_(deps.readLikes());
    var myNo = galleryFor_(deps.readGallery(), vid).mine;
    return ok_({ studentId: vid, name: vacc ? String(vacc.name) : '', sections: adminStudentNotes(deps.readNotes() || [], vid),
      game: { count: gs.length, lastAt: isFinite(glast) ? new Date(glast).toISOString() : '', version: gver || null },
      liked: likedBy_(curL, vid),
      received: myNo ? curL.filter(function (x) { return x.cls === classNo_(vid) && x.n === myNo; }).length : null,
      myNumber: myNo });
  }
  if (action === 'gallery_info') {
    var gi = galleryInfo_(deps.readGallery());
    return ok_({ count: gi.count, classes: gi.classes });
  }
  if (action === 'gallery_set') {
    var parsed = parseGalleryText(arg);
    if (!parsed) return fail_('BAD_REQUEST', '명단을 읽지 못했어요. mapping.csv 내용을 그대로 붙여넣었는지 확인해 주세요.');
    if (!parsed.rows.length) return fail_('BAD_REQUEST', '올릴 줄이 없어요. 공개(Y)한 작품이 있는지, 학번·반·번호 열이 있는지 확인해 주세요.');
    if (!deps.tryLock()) return fail_('BUSY');
    try {
      deps.writeGallery(parsed.rows);
    } finally {
      deps.releaseLock();
    }
    var g2 = galleryInfo_(parsed.rows);
    return ok_({ count: g2.count, classes: g2.classes, skipped: parsed.skipped });
  }
  if (action === 'votes') {
    var vc = adminVotesCsv(deps.readLikes() || []);
    if (!vc.count) return fail_('NOT_FOUND');
    return ok_({ name: 'likes.csv', count: vc.count, csv: vc.csv });
  }
  if (action === 'zip') {
    var key = String(arg === null || arg === undefined ? '' : arg);
    if (!/^[1-3](0[1-9]|1[0-6])$/.test(key)) return fail_('BAD_REQUEST');
    var items = adminLatest(deps.readSubmissions(), key);
    if (!items.length) return fail_('NOT_FOUND');
    var z = deps.zipFiles(items.map(function (x) { return { name: x.name, fileId: x.fileId }; }));
    if (!z || typeof z.b64 !== 'string') return fail_('SERVER_ERROR');
    if (z.b64.length > ADMIN_ZIP_MAX_B64) return fail_('TOO_BIG');
    return ok_({ name: 'submissions_' + key + '.zip', count: items.length, b64: z.b64 });
  }
  if (action === 'reset') {
    var sid = String(arg === null || arg === undefined ? '' : arg).trim();
    if (!validateStudentId(sid)) return fail_('BAD_REQUEST');
    if (!deps.tryLock()) return fail_('BUSY');
    var done;
    try {
      done = deps.markReset(sid, deps.now());
    } finally {
      deps.releaseLock();
    }
    if (!done) return fail_('NOT_REGISTERED');
    deps.clearFails(sid); // 잠금 해제
    return ok_({ studentId: sid });
  }
  return fail_('BAD_REQUEST');
}

function isAdmin_() {
  var me = '';
  try { me = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { me = ''; }
  if (!me) return false;
  var owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e2) { owner = ''; }
  if (owner && me === owner) return true;
  var extra = String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '')
    .split(/[\s,;]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s; });
  return extra.indexOf(me) >= 0;
}

function adminPwSet_() {
  return !!String(PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || '');
}

// 관리자 확인: 같은 학교 선생님 계정이면 바로 통과, 아니면 관리자 비밀번호(스크립트 속성 ADMIN_PASSWORD)
function adminCheck_(pw) {
  if (isAdmin_()) return;
  var r = adminPasswordCheck({
    getAdminPassword: function () { return PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD'); }
  }, pw);
  if (r === 'OK') return;
  if (r === 'WRONG') throw new Error('관리자 비밀번호가 맞지 않아요.');
  throw new Error('관리자만 쓸 수 있어요.');
}

// google.script.run 으로 부르는 함수 (이름 끝에 _ 가 없어야 호출 가능). 매번 권한 확인
function adminInfo() {
  return { open: isAdmin_() }; // true 면 비밀번호 없이 열림(같은 학교 선생님 계정)
}

function adminList(query, pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'list', typeof query === 'string' ? query.slice(0, 40) : '');
}

function adminReset(studentId, pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'reset', studentId);
}

function adminClasses(pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'classes', '');
}

function adminTallyView(pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'tally', '');
}

function adminNotes(classKey, pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'notes', classKey);
}

function adminNoteView(studentId, pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'note_view', studentId);
}

function adminGalleryInfo(pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'gallery_info', '');
}

function adminSetGallery(text, pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'gallery_set', typeof text === 'string' ? text : '');
}

function adminVotes(pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'votes', '');
}

function adminZip(classKey, pw) {
  adminCheck_(pw);
  return adminHandle(makeRealDeps(), 'zip', classKey);
}

// 열 수 있는 사람: 같은 학교 선생님 계정, 또는 ADMIN_PASSWORD 를 설정해 둔 경우 그 비밀번호를 아는 사람.
// 둘 다 아니면 화면이 있다는 것도 알 수 없게 평소 응답만 준다.
function adminPage_() {
  if (!isAdmin_() && !adminPwSet_()) return jsonOut_(ok_({ serverTime: new Date().toISOString(), version: VERSION }));
  return HtmlService.createHtmlOutput(ADMIN_HTML).setTitle('제출 시험 관리자')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

var ADMIN_HTML = [
'<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><base target="_top">',
'<style>',
':root{--bg:#f6f7fb;--card:#fff;--tx:#1f2430;--mut:#6b7280;--pri:#4f46e5;--pri2:#eef2ff;--bd:#d9dce6;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}',
'@media (prefers-color-scheme:dark){:root{--bg:#14161c;--card:#1e222b;--tx:#e8eaf0;--mut:#9aa3b2;--pri:#818cf8;--pri2:#262a45;--bd:#343a48}}',
'*{box-sizing:border-box}body{margin:0;font-family:"Noto Sans KR","Malgun Gothic",system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.5;word-break:keep-all}',
'main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);font-size:14px;margin:0 0 16px}',
'h2.sec{font-size:17px;margin:28px 0 10px}',
'.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;margin-bottom:12px}',
'.bar label{color:var(--mut);font-size:14px}',
'.bar input{flex:1;min-width:180px;padding:9px 10px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);color:var(--tx);font:inherit;font-size:15px}',
'.bar textarea{flex:1 1 100%;min-height:70px;padding:9px 10px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);color:var(--tx);font:12px Consolas,monospace}',
'button{border:1px solid var(--bd);background:var(--card);color:var(--tx);padding:8px 14px;border-radius:7px;cursor:pointer;font:inherit;font-size:14px;min-height:36px}',
'button.p{background:var(--pri);color:#fff;border-color:var(--pri)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--pri);outline-offset:2px}',
'select{padding:8px 10px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);color:var(--tx);font:inherit;font-size:15px;min-height:36px}',
'#msg{min-height:22px;font-size:14px;margin:4px 2px 10px}#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}',
'.wrap{background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow-x:auto}',
'table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:9px 10px;border-bottom:1px solid var(--bd);text-align:left;white-space:nowrap}th{color:var(--mut);font-weight:600;background:var(--pri2)}',
'td.n{text-align:right}.ck{color:var(--ok);font-weight:700}.no{color:var(--mut)}td small{color:var(--mut);font-size:12px;margin-left:5px}',
'.tag{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--bd)}.tag.r{color:var(--warn);border-color:var(--warn)}.tag.l{color:var(--bad);border-color:var(--bad)}',
'.empty{padding:24px;text-align:center;color:var(--mut)}[hidden]{display:none!important}',
'td .acts{display:flex;gap:6px;justify-content:flex-end}',
'.ov{position:fixed;inset:0;background:rgba(15,20,30,.55);display:none;align-items:center;justify-content:center;padding:16px;z-index:10}.ov.on{display:flex}',
'.pm{background:var(--card);color:var(--tx);width:min(820px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:20px 22px;box-shadow:0 10px 30px rgba(0,0,0,.25)}',
'.pm h2{margin:0 0 2px;font-size:19px}.pm .hd{display:flex;align-items:flex-start;gap:12px;margin-bottom:10px}.pm .hd div{flex:1}',
'.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:14px;margin:8px 0 4px;padding:12px;border:1px solid var(--bd);border-radius:10px}.kv dt{color:var(--mut)}.kv dd{margin:0}',
'.nt{border:1px solid var(--bd);border-radius:10px;margin:12px 0;overflow:hidden}.nt h3{margin:0;padding:9px 12px;background:var(--pri2);font-size:15px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
'.nt h3 span{font-size:13px;font-weight:400;color:var(--mut)}.nt pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:14px;line-height:1.6;max-height:46vh;overflow:auto}.nt .none{padding:12px;color:var(--mut);font-size:14px}',
'</style></head><body><main>',
'<h1>수업 관리자</h1>',
'<p class="sub">학생마다 제출했는지 먼저 보이고, [자세히]를 누르면 내용이 나옵니다. 비밀번호를 잊었거나 잠긴 학생은 [초기화]하면 잠금이 풀리고, 학생이 <b>학번</b>으로 로그인한 뒤 새 비밀번호를 정합니다.</p>',
'<div class="bar" id="pwbar" hidden><label for="pw">관리자 비밀번호</label><input id="pw" type="password" autocomplete="off"><button class="p" id="pwgo">들어가기</button></div>',
'<div id="pwmsg" role="status" aria-live="polite" class="sub"></div>',
'<div id="app" hidden>',
'<div class="bar"><label for="q">찾기</label><input id="q" type="search" placeholder="학번이나 이름 일부 (비우면 전체)" autocomplete="off"><button class="p" id="go">조회</button></div>',
'<div id="msg" role="status" aria-live="polite"></div>',
'<div class="wrap"><table><thead><tr><th>학번</th><th>이름</th><th>1차시 기획서</th><th>게임</th><th>2~3차시 기록</th><th>좋아요</th><th>4차시 소감</th><th>상태</th><th></th></tr></thead><tbody id="tb"><tr><td colspan="9" class="empty">불러오는 중…</td></tr></tbody></table></div>',
'<p class="sub" style="margin-top:6px">✓ 옆은 마지막으로 낸 시각입니다. 게임은 낸 횟수, 좋아요는 누른 개수가 함께 보입니다.</p>',
'',
'<h2 class="sec">내려받기와 좋아요</h2>',
'<div class="bar"><label for="cls">갤러리용 작품</label><select id="cls" aria-label="반 선택"></select><button class="p" id="dl">이 반 내려받기</button><button id="dlall">모든 반 차례로 내려받기</button></div>',
'<p class="sub" style="margin-top:-4px">학생마다 가장 최근에 낸 작품만 담긴 zip입니다. 풀지 말고 <code>python tools/ingest.py 내려받은.zip</code>에 넣습니다.</p>',
'<div class="bar"><label for="ncls">글·좋아요</label><select id="ncls" aria-label="글 내려받기 범위"></select><button class="p" id="nbtn">글 내려받기 (CSV)</button><button id="tbtn">좋아요 순위 보기</button><button id="vbtn">좋아요 내려받기 (CSV)</button></div>',
'<p class="sub" style="margin-top:-4px">글 CSV는 학생 한 명이 한 줄이고, 1차시·2~3차시·4차시 글이 옆으로 나란히 들어갑니다(각각 가장 나중 것).</p>',
'<div id="tally"></div>',
'<div class="bar"><label for="gtxt">작품 번호 명단</label><span id="ginfo" class="sub" style="margin:0"></span><textarea id="gtxt" spellcheck="false" placeholder="갤러리를 공개한 뒤 private/mapping.csv 내용을 그대로 붙여넣으세요 (학번, 반, 번호 열이 있으면 됩니다)"></textarea><button class="p" id="gbtn">명단 올리기</button></div>',
'<p class="sub" style="margin-top:-4px">이 명단이 있어야 학생이 좋아요를 누를 수 있습니다. 서버는 학번·반·번호만 저장하고, <b>자기 작품</b>과 <b>다른 반 작품</b>의 좋아요는 막습니다. 공개(Y)가 아닌 줄은 빠집니다.</p>',
'</div>',
'</main>',
'<div class="ov" id="nov" role="dialog" aria-modal="true" aria-labelledby="nvt"><div class="pm"><div class="hd"><div><h2 id="nvt">학생 제출 내용</h2><p class="sub" id="nvs" style="margin:0"></p></div><button id="nvx">닫기</button></div><div id="nvb"></div></div></div>',
'<script>',
'var $=function(id){return document.getElementById(id)};var PW="";var CLS=[];',
'function fmt(iso){if(!iso)return "";var d=new Date(iso);if(isNaN(d))return "";var p=function(n){return (n<10?"0":"")+n};return (d.getMonth()+1)+"/"+d.getDate()+" "+p(d.getHours())+":"+p(d.getMinutes())}',
'function msg(t,cls){var m=$("msg");m.textContent=t;m.className=cls||""}',
'function td(text,cls){var c=document.createElement("td");c.textContent=text;if(cls)c.className=cls;return c}',
'function mark(iso,extra){var c=document.createElement("td");if(iso){var s=document.createElement("span");s.className="ck";s.textContent="✓";c.appendChild(s);var m=document.createElement("small");m.textContent=(extra?extra+" · ":"")+fmt(iso);c.appendChild(m)}else{var n=document.createElement("span");n.className="no";n.textContent="—";c.appendChild(n)}return c}',
'function render(res){var tb=$("tb");tb.textContent="";if(!res||!res.ok){msg("목록을 불러오지 못했어요.","bad");return}',
' if(!res.rows.length){var tr=document.createElement("tr");var c=td("등록한 학생이 없거나 찾는 학생이 없어요.","empty");c.colSpan=9;tr.appendChild(c);tb.appendChild(tr)}',
' var k={t1:0,game:0,t2:0,vote:0,t3:0};',
' res.rows.forEach(function(r){if(r.t1)k.t1++;if(r.count)k.game++;if(r.t2)k.t2++;if(r.likeCount)k.vote++;if(r.t3)k.t3++;',
'  var tr=document.createElement("tr");tr.appendChild(td(r.id));tr.appendChild(td(r.name));tr.appendChild(mark(r.t1));tr.appendChild(mark(r.count?r.lastAt:"",r.count?r.count+"번":""));tr.appendChild(mark(r.t2));tr.appendChild(mark(r.likeAt,r.likeCount?r.likeCount+"개":""));tr.appendChild(mark(r.t3));',
'  var st=document.createElement("td");var tags=[];if(r.reset)tags.push(["초기화됨(비밀번호=학번)","r"]);if(r.locked)tags.push(["잠김","l"]);if(!tags.length)tags.push(["정상",""]);tags.forEach(function(t){var s=document.createElement("span");s.className="tag "+t[1];s.textContent=t[0];st.appendChild(s);st.appendChild(document.createTextNode(" "))});tr.appendChild(st);',
'  var bc=document.createElement("td");var ac=document.createElement("div");ac.className="acts";var v=document.createElement("button");v.textContent="자세히";v.setAttribute("aria-label",r.id+" "+r.name+" 자세히");v.onclick=function(){viewDetail(r,v)};ac.appendChild(v);var b=document.createElement("button");b.textContent="초기화";b.setAttribute("aria-label",r.id+" "+r.name+" 초기화");b.onclick=function(){reset(r,b)};ac.appendChild(b);bc.appendChild(ac);tr.appendChild(bc);tb.appendChild(tr)});',
' var info=res.shown<res.total&&!$("q").value.trim()?" (앞에서 "+res.shown+"명만 표시)":"";',
' msg("등록 "+res.total+"명 중 "+res.rows.length+"명"+info+" · 1차시 "+k.t1+" · 게임 "+k.game+" · 2~3차시 "+k.t2+" · 좋아요 "+k.vote+" · 4차시 "+k.t3,"")}',
'function load(){msg("불러오는 중…","");$("go").disabled=true;google.script.run.withSuccessHandler(function(r){$("go").disabled=false;render(r)}).withFailureHandler(function(e){$("go").disabled=false;msg("불러오지 못했어요: "+(e&&e.message||"오류"),"bad")}).adminList($("q").value,PW)}',
'function reset(r,b){if(!confirm(r.id+" "+r.name+" 학생의 비밀번호를 학번("+r.id+")으로 초기화할까요?\\n잠금도 풀리고, 학생은 학번으로 로그인한 뒤 새 비밀번호를 정합니다."))return;b.disabled=true;msg(r.id+" 초기화하는 중…","");',
' google.script.run.withSuccessHandler(function(res){if(res&&res.ok){msg(r.id+" "+r.name+": 초기화했어요. 학생은 학번으로 로그인한 뒤 새 비밀번호를 정하면 됩니다.","ok");setTimeout(load,600)}else{b.disabled=false;msg("초기화하지 못했어요: "+(res&&res.message||"오류"),"bad")}})',
' .withFailureHandler(function(e){b.disabled=false;msg("초기화하지 못했어요: "+(e&&e.message||"오류"),"bad")}).adminReset(r.id,PW)}',
'var lastFocus=null;function closeDetail(){$("nov").classList.remove("on");if(lastFocus)lastFocus.focus()}',
'function kv(dl,k,v){var t=document.createElement("dt");t.textContent=k;var d=document.createElement("dd");d.textContent=v;dl.appendChild(t);dl.appendChild(d)}',
'function showDetail(res){var box=$("nvb");box.textContent="";$("nvt").textContent=res.studentId+" "+(res.name||"");$("nvs").textContent="글은 구간마다 가장 나중에 낸 것이에요.";',
' var dl=document.createElement("dl");dl.className="kv";var g=res.game||{};',
' kv(dl,"게임",g.count?("제출 "+g.count+"번 · 마지막 "+fmt(g.lastAt)+(g.version?" (v"+g.version+")":"")):"아직 내지 않음");',
' kv(dl,"누른 좋아요",res.liked&&res.liked.length?(res.liked.join(", ")+"번 ("+res.liked.length+"개)"):"아직 누르지 않음");',
' kv(dl,"내 작품",res.myNumber?(res.myNumber+"번 · 받은 좋아요 "+res.received+"개"):"명단에 없음");box.appendChild(dl);',
' res.sections.forEach(function(s){var d=document.createElement("section");d.className="nt";var h=document.createElement("h3");h.textContent=s.label;var m=document.createElement("span");m.textContent=s.times?("제출 "+s.times+"번 · 마지막 "+fmt(s.at)):"아직 내지 않음";h.appendChild(m);d.appendChild(h);',
'  if(s.text){var pre=document.createElement("pre");pre.textContent=s.text;d.appendChild(pre)}else{var n=document.createElement("div");n.className="none";n.textContent="제출한 글이 없어요.";d.appendChild(n)}box.appendChild(d)});',
' $("nov").classList.add("on");$("nvx").focus()}',
'function viewDetail(r,b){b.disabled=true;msg(r.id+" "+r.name+" 내용을 불러오는 중…","");lastFocus=b;google.script.run.withSuccessHandler(function(res){b.disabled=false;if(res&&res.ok){msg("","");showDetail(res)}else msg("불러오지 못했어요: "+(res&&res.message||"오류"),"bad")}).withFailureHandler(function(e){b.disabled=false;msg("불러오지 못했어요: "+(e&&e.message||"오류"),"bad")}).adminNoteView(r.id,PW)}',
'$("nvx").onclick=closeDetail;$("nov").addEventListener("click",function(e){if(e.target===$("nov"))closeDetail()});document.addEventListener("keydown",function(e){if(e.key==="Escape"&&$("nov").classList.contains("on"))closeDetail()});',
'function saveZip(name,b64){var bin=atob(b64),n=bin.length,u=new Uint8Array(n);for(var i=0;i<n;i++)u[i]=bin.charCodeAt(i);var url=URL.createObjectURL(new Blob([u],{type:"application/zip"}));var a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(url)},60000)}',
'function loadClasses(){google.script.run.withSuccessHandler(function(r){var sel=$("cls");sel.textContent="";CLS=(r&&r.ok&&r.classes)||[];CLS.forEach(function(c){var o=document.createElement("option");o.value=c.key;o.textContent=c.label+" ("+c.count+"명)";sel.appendChild(o)});if(!CLS.length){var o=document.createElement("option");o.textContent="제출한 반이 없어요";sel.appendChild(o)}$("dl").disabled=$("dlall").disabled=!CLS.length;var ns=$("ncls");ns.textContent="";var a0=document.createElement("option");a0.value="";a0.textContent="모든 반";ns.appendChild(a0);CLS.forEach(function(c){var o=document.createElement("option");o.value=c.key;o.textContent=c.label;ns.appendChild(o)})}).withFailureHandler(function(){}).adminClasses(PW)}',
'function dlOne(c,next){msg(c.label+" 만드는 중…","");google.script.run.withSuccessHandler(function(r){if(r&&r.ok){saveZip(r.name,r.b64);msg(c.label+": "+r.count+"명 작품을 내려받았어요 ("+r.name+")","ok");if(next)setTimeout(next,1200);else $("dl").disabled=$("dlall").disabled=false}else{msg(c.label+" 실패: "+(r&&r.message||"오류"),"bad");$("dl").disabled=$("dlall").disabled=false}}).withFailureHandler(function(e){msg(c.label+" 실패: "+(e&&e.message||"오류"),"bad");$("dl").disabled=$("dlall").disabled=false}).adminZip(c.key,PW)}',
'$("dl").onclick=function(){var k=$("cls").value;var c=CLS.filter(function(x){return x.key===k})[0];if(!c)return;$("dl").disabled=$("dlall").disabled=true;dlOne(c,null)};',
'$("dlall").onclick=function(){if(!CLS.length||!confirm(CLS.length+"개 반을 차례로 내려받습니다. 크롬이 여러 파일 내려받기를 물으면 허용해 주세요."))return;$("dl").disabled=$("dlall").disabled=true;var i=0;(function step(){var c=CLS[i++];if(!c){$("dl").disabled=$("dlall").disabled=false;msg("모든 반을 내려받았어요.","ok");return}dlOne(c,step)})()};',
'function saveText(name,text){var url=URL.createObjectURL(new Blob([text],{type:"text/csv;charset=utf-8"}));var a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(url)},60000)}',
'function busyN(on){$("nbtn").disabled=$("tbtn").disabled=$("vbtn").disabled=on}',
'function dlCsv(fn,arg,label){busyN(true);msg(label+" 만드는 중…","");var h=google.script.run.withSuccessHandler(function(r){busyN(false);if(r&&r.ok){saveText(r.name,r.csv);msg(label+": "+r.count+"줄을 내려받았어요 ("+r.name+")","ok")}else msg(label+" 실패: "+(r&&r.message||"오류"),"bad")}).withFailureHandler(function(e){busyN(false);msg(label+" 실패: "+(e&&e.message||"오류"),"bad")});if(fn==="adminVotes")h.adminVotes(PW);else h.adminNotes(arg,PW)}',
'$("nbtn").onclick=function(){dlCsv("adminNotes",$("ncls").value,"글")};',
'$("vbtn").onclick=function(){dlCsv("adminVotes","","좋아요")};',
'function renderTally(r){var box=$("tally");box.textContent="";if(!r||!r.ok){msg("좋아요 순위를 불러오지 못했어요.","bad");return}',
' var p=document.createElement("p");p.className="sub";p.textContent="좋아요 "+(r.voteOpen?"받는 중":"닫힘")+" · 반마다 좋아요를 누른 학생 수와 좋아요를 많이 받은 작품 순위. 자기 작품에는 누를 수 없어요.";box.appendChild(p);',
' if(!r.classes.length){var e=document.createElement("p");e.className="empty";e.textContent="아직 좋아요가 없어요.";box.appendChild(e);return}',
' var w=document.createElement("div");w.className="wrap";w.style.marginBottom="12px";var t=document.createElement("table");var hr=document.createElement("tr");["반","누른 학생","1위","2위","3위","4위","5위"].forEach(function(h){var th=document.createElement("th");th.textContent=h;hr.appendChild(th)});t.appendChild(hr);',
' r.classes.forEach(function(c){var tr=document.createElement("tr");tr.appendChild(td(c.label));tr.appendChild(td(String(c.voters),"n"));for(var i=0;i<5;i++){var x=c.top[i];tr.appendChild(td(x?(x.n+"번 ("+x.count+"개)"):"-"))}t.appendChild(tr)});',
' w.appendChild(t);box.appendChild(w)}',
'$("tbtn").onclick=function(){busyN(true);msg("좋아요 세는 중…","");google.script.run.withSuccessHandler(function(r){busyN(false);renderTally(r);msg("","")}).withFailureHandler(function(e){busyN(false);msg("좋아요 순위 실패: "+(e&&e.message||"오류"),"bad")}).adminTallyView(PW)};',
'function showGalleryInfo(r){$("ginfo").textContent=r&&r.ok&&r.count?("지금 명단: "+r.count+"명 · "+r.classes.join(", ")):"아직 명단이 없어요. 명단이 없으면 학생이 좋아요를 누를 수 없어요."}',
'function loadGalleryInfo(){google.script.run.withSuccessHandler(showGalleryInfo).withFailureHandler(function(){}).adminGalleryInfo(PW)}',
'$("gbtn").onclick=function(){var t=$("gtxt").value;if(!t.trim()){msg("명단 칸이 비어 있어요.","bad");return}if(!confirm("작품 번호 명단을 새로 올립니다. 지금 있는 명단은 바뀝니다. 계속할까요?"))return;$("gbtn").disabled=true;msg("명단 올리는 중…","");',
' google.script.run.withSuccessHandler(function(r){$("gbtn").disabled=false;if(r&&r.ok){msg("명단 "+r.count+"명을 올렸어요"+(r.skipped?(" (빠진 줄 "+r.skipped+"개)"):"")+".","ok");$("gtxt").value="";showGalleryInfo(r)}else msg("명단을 올리지 못했어요: "+(r&&r.message||"오류"),"bad")})',
' .withFailureHandler(function(e){$("gbtn").disabled=false;msg("명단을 올리지 못했어요: "+(e&&e.message||"오류"),"bad")}).adminSetGallery(t,PW)};',
'$("go").onclick=load;$("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});',
'function enter(){$("pwbar").hidden=true;$("pwmsg").textContent="";$("app").hidden=false;load();loadClasses();loadGalleryInfo()}',
'function tryPw(){PW=$("pw").value;$("pwmsg").textContent="확인하는 중…";google.script.run.withSuccessHandler(function(r){if(r&&r.ok)enter();else $("pwmsg").textContent="들어가지 못했어요."}).withFailureHandler(function(e){PW="";$("pwmsg").textContent=e&&e.message||"들어가지 못했어요."}).adminClasses(PW)}',
'$("pwgo").onclick=tryPw;$("pw").addEventListener("keydown",function(e){if(e.key==="Enter")tryPw()});',
'google.script.run.withSuccessHandler(function(i){if(i&&i.open)enter();else{$("pwbar").hidden=false;$("pw").focus()}}).withFailureHandler(function(){$("pwbar").hidden=false}).adminInfo();',
'</script></body></html>'
].join('\n');

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
    // 명단에 학번이 있으면(이름 빈칸) 이름을 채우고, 없으면 새 행 추가. 3열에 '자동' 표시
    upsertRoster: function (id, name) {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Roster');
      if (sh && sh.getLastRow() >= 2) {
        var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0]).trim() !== String(id)) continue;
          sh.getRange(i + 2, 2, 1, 2).setValues([[textCell_(name), '자동']]);
          return;
        }
      }
      appendRow_('Roster', [id, textCell_(name), '자동']);
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
          fileId: String(r[4] || '').trim(), size: Number(r[5]), sha256: String(r[6]), requestId: String(r[7] === null || r[7] === undefined ? '' : r[7]).trim() };
      });
    },
    saveFile: function (fileName, text) {
      return getSubmitFolder_().createFile(fileName, text, 'text/html').getId();
    },
    discardFile: function (fileId) {
      DriveApp.getFileById(fileId).setTrashed(true);
    },
    renameFile: function (fileId, name) {
      DriveApp.getFileById(fileId).setName(name);
    },
    appendNote: function (n) {
      appendRow_('Notes', [n.at, n.id, n.section, textCell_(n.text)]);
    },
    appendLike: function (l) {
      appendRow_('Likes', [l.at, l.id, l.cls, l.n, l.on ? 'Y' : 'N']);
    },
    // 글 내용(4열)은 읽지 않는 가벼운 읽기: 내 현황 확인용
    readNotesMeta: function () {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Notes');
      if (!sh || sh.getLastRow() < 2) return [];
      return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().map(function (r) {
        return { at: r[0], id: String(r[1]).trim(), section: String(r[2]).trim() };
      });
    },
    readNotes: function () {
      return dataRows_('Notes').map(function (r) {
        return { at: r[0], id: String(r[1]).trim(), section: String(r[2]).trim(), text: String(r[3]) };
      });
    },
    readLikes: function () {
      return dataRows_('Likes').map(function (r) {
        return { at: r[0], id: String(r[1]).trim(), cls: Number(r[2]), n: Number(r[3]), on: String(r[4]).trim().toUpperCase() === 'Y' };
      }).filter(function (l) { return l.id; });
    },
    readGallery: function () {
      return dataRows_('Gallery').map(function (r) {
        return { id: String(r[0]).trim(), cls: Number(r[1]), n: Number(r[2]) };
      }).filter(function (g) { return g.id; });
    },
    // 관리자: 작품 번호 명단을 통째로 바꿈 (머리글은 둠)
    writeGallery: function (rows) {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Gallery') || ensureSheet_('Gallery');
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
      if (!rows.length) return;
      if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
      sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, rows.length, 3).setValues(rows.map(function (g) { return [g.id, g.cls, g.n]; }));
    },
    voteOpen: function () {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
      return parseConfig(sh ? sh.getDataRange().getValues() : []).vote_open;
    },
    // 관리자: 드라이브 파일들을 zip 하나로 묶어 base64 로 돌려줌. items = [{ name, fileId }]
    zipFiles: function (items) {
      var blobs = items.map(function (it) { return DriveApp.getFileById(it.fileId).getBlob().setName(it.name); });
      return { b64: Utilities.base64Encode(Utilities.zip(blobs, 'submissions.zip').getBytes()) };
    },
    // 관리자: 초기화 표시(Y)와 시각을 시트에 씀. 학번이 없으면 false
    markReset: function (id, at) {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Accounts');
      if (!sh || sh.getLastRow() < 2) return false;
      var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]).trim() !== String(id)) continue;
        sh.getRange(i + 2, 6).setValue('Y');
        sh.getRange(i + 2, 8).setValue(at);
        return true;
      }
      return false;
    },
    // 관리자: 지금 잠겨 있는 학번 목록
    lockedIds: function (ids) {
      if (!ids || !ids.length) return [];
      var got = CacheService.getScriptCache().getAll(ids.map(function (id) { return 'pf:' + id; }));
      return ids.filter(function (id) { return isLocked(Number(got['pf:' + id]) || 0); });
    },
    appendSubmission: function (row) {
      appendRow_('Submissions', [row.at, row.id, textCell_(row.email), row.version, row.fileId, row.size,
        row.sha256, row.requestId || '']);
    },
    rateLimit: realRateLimit_,
    sha256Hex: sha256HexReal_,
    tryLock: function () {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) return false;
      // 잠금을 잡은 뒤 시트를 새로 읽도록 함 (다른 실행이 방금 쓴 행이 보이게)
      try { SpreadsheetApp.flush(); } catch (e) { /* 무시 */ }
      return true;
    },
    releaseLock: function () {
      if (!lock) return;
      try { SpreadsheetApp.flush(); } catch (e) { /* 무시 */ }
      try { lock.releaseLock(); } catch (e) { /* 무시 */ }
    },
    log: function (msg) { console.error(String(msg)); },
    readAccounts: function () {
      return dataRows_('Accounts').map(function (r, i) {
        return { id: String(r[0]).trim(), name: String(r[1]), hash: String(r[2]).trim(), salt: String(r[3]).trim(),
          at: r[4], reset: String(r[5]).trim().toUpperCase() === 'Y', resetAt: r[7], row: i + 2 };
      }).filter(function (a) { return a.id; });
    },
    appendAccount: function (a) {
      appendRow_('Accounts', [a.id, textCell_(a.name), a.hash, a.salt, a.at, '', '', '']);
    },
    updateAccountPassword: function (id, p) {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Accounts');
      if (!sh || sh.getLastRow() < 2) return false;
      var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]).trim() !== String(id)) continue;
        var r = i + 2;
        sh.getRange(r, 3, 1, 2).setNumberFormat('@').setValues([[p.hash, p.salt]]);
        sh.getRange(r, 6, 1, 3).setValues([['', p.at, '']]); // 초기화 비움, 변경시각, 초기화시각 비움
        return true;
      }
      return false;
    },
    getPepper: function () {
      return PropertiesService.getScriptProperties().getProperty(PROP_PEPPER);
    },
    newSalt: function () { return Utilities.getUuid().replace(/-/g, ''); },
    reserveAttempt: realReserveAttempt_,
    clearFails: function (id) { CacheService.getScriptCache().remove('pf:' + id); },
    globalFails: function () { return Number(CacheService.getScriptCache().get(globalFailKey_())) || 0; },
    addGlobalFail: function () {
      var c = CacheService.getScriptCache(), k = globalFailKey_();
      c.put(k, String((Number(c.get(k)) || 0) + 1), 120);
    },
    newSession: function (id) {
      var c = CacheService.getScriptCache();
      var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
      var v = Number(c.get('sv:' + id)) || 0;
      c.put('sess:' + sha256HexReal_(token), JSON.stringify({ id: id, v: v, iat: Date.now() }), SESSION_TTL);
      return token;
    },
    resolveSession: function (token) {
      var c = CacheService.getScriptCache();
      var raw = c.get('sess:' + sha256HexReal_(token));
      if (!raw) return null;
      var s;
      try { s = JSON.parse(raw); } catch (e) { return null; }
      if (!s || !s.id || (Number(c.get('sv:' + s.id)) || 0) !== Number(s.v)) return null;
      return { id: String(s.id), issuedAt: Number(s.iat) || 0 };
    },
    bumpSessionVersion: function (id) {
      var c = CacheService.getScriptCache();
      c.put('sv:' + id, String((Number(c.get('sv:' + id)) || 0) + 1), SESSION_TTL);
    }
  };
}

function globalFailKey_() {
  return 'pfall:' + Math.floor(Date.now() / 60000);
}

// 시도 횟수를 짧은 잠금 안에서 읽고 올림 (동시 요청이 잠금 한도를 넘지 못하게)
function realReserveAttempt_(id) {
  var lk = LockService.getScriptLock();
  if (!lk.tryLock(3000)) return { ok: false, busy: true };
  try {
    var c = CacheService.getScriptCache();
    var n = Number(c.get('pf:' + id)) || 0;
    if (isLocked(n)) return { ok: false };
    c.put('pf:' + id, String(n + 1), LOCK_SEC);
    return { ok: true };
  } finally {
    lk.releaseLock();
  }
}

// 단순 트리거: 선생님이 Accounts 의 초기화 칸에 Y 를 쓰면 초기화시각 기록 + 그 학번의 잠금 해제.
// 초기화시각보다 먼저 발급된 로그인 세션은 무효가 됨. 지우면 시각도 지움.
function onEdit(e) {
  try {
    var rng = e && e.range;
    if (!rng) return;
    var sh = rng.getSheet();
    if (sh.getName() !== 'Accounts') return;
    var resetCol = 6, atCol = 8;
    if (rng.getColumn() > resetCol || rng.getLastColumn() < resetCol) return;
    var first = Math.max(2, rng.getRow()), last = rng.getLastRow();
    for (var r = first; r <= last; r++) {
      var v = String(sh.getRange(r, resetCol).getValue()).trim().toUpperCase();
      sh.getRange(r, atCol).setValue(v === 'Y' ? new Date() : '');
      if (v === 'Y') {
        var id = String(sh.getRange(r, 1).getValue()).trim();
        try { if (id) CacheService.getScriptCache().remove('pf:' + id); } catch (e2) { /* 무시 */ }
      }
    }
  } catch (err) { /* 트리거 오류는 무시 */ }
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
  var props = PropertiesService.getScriptProperties();
  // 비밀번호 해시용 페퍼: 없을 때만 만듦 (값은 기록·출력하지 않음)
  if (!props.getProperty(PROP_PEPPER)) {
    var acc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Accounts');
    if (acc && acc.getLastRow() >= 2) {
      throw new Error('PASSWORD_PEPPER 가 없는데 Accounts 에 이미 계정이 있어요. 새로 만들면 기존 비밀번호가 모두 맞지 않게 됩니다. ' +
        '원래 값을 스크립트 속성에 되돌리거나, Accounts 의 계정 행을 모두 지운 뒤 다시 실행하세요.');
    }
    props.setProperty(PROP_PEPPER, (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  if (!props.getProperty(PROP_CLIENT_ID)) {
    console.warn('auth_mode=google 로 쓸 때는 스크립트 속성 GOOGLE_CLIENT_ID 를 설정해야 합니다.');
  }
}
