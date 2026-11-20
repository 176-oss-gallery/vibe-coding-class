/*
 * Apps Script 제출 서버(apps-script/Code.gs) 테스트.
 * 실행: node tests/test_apps_script.js   (Node 내장 모듈만 사용, python 이 있으면 common.py 교차 검사도 함)
 * 실패가 하나라도 있으면 종료 코드 1.
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CODE_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const LAB_PATH = path.join(ROOT, 'site', 'lab', 'index.html');
const SRC = fs.readFileSync(CODE_PATH, 'utf8');

// ── Code.gs 를 vm 컨텍스트에 불러오기 (불러올 때 Google 전역은 쓰지 않지만 안전하게 막아 둠) ──
function trap(name) {
  return new Proxy({}, { get() { throw new Error('Google 전역 ' + name + ' 호출됨 (테스트에서는 금지)'); } });
}
const ctx = {
  console: { log() {}, error() {}, warn() {} },
  SpreadsheetApp: trap('SpreadsheetApp'), PropertiesService: trap('PropertiesService'),
  CacheService: trap('CacheService'), UrlFetchApp: trap('UrlFetchApp'), DriveApp: trap('DriveApp'),
  LockService: trap('LockService'), Utilities: trap('Utilities'), ContentService: trap('ContentService'),
  Logger: { log() {} }
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'Code.gs' });
const G = ctx;

// vm 안에서 만든 배열·객체는 프로토타입이 달라 deepStrictEqual 이 실패하므로 JSON 으로 비교
const J = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b, msg) => assert.deepStrictEqual(J(a), J(b), msg);

// ── 아주 작은 테스트 실행기 ──
const results = [];
function test(name, fn) {
  try { fn(); results.push([name, true]); console.log('PASS  ' + name); }
  catch (e) { results.push([name, false]); console.log('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n').join('\n      ')); }
}

// ── python tools/common.py 로 파일 내용 해석 ──
const PY_CODE = [
  'import sys, json',
  'sys.path.insert(0, ' + JSON.stringify(path.join(ROOT, 'tools')) + ')',
  'import common as C',
  "text = sys.stdin.buffer.read().decode('utf-8')",
  'sid, name, rest = C.split_marker(text)',
  't, d, body = C.split_info(rest)',
  "print(json.dumps({'id': sid, 'name': name, 't': t, 'd': d, 'body': body}))"
].join('\n');
let PY = null;
for (const exe of ['python', 'python3', 'py']) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (r.status === 0) { PY = exe; break; }
}
function pyParse(content) {
  const r = spawnSync(PY, ['-c', PY_CODE], {
    input: Buffer.from(content, 'utf8'), env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
  });
  if (r.status !== 0) throw new Error('python 실패: ' + (r.stderr || '').toString('utf8'));
  return JSON.parse(r.stdout.toString('utf8'));
}
function infoLine(t, d) {
  return '<!-- vibe-info:' + encodeURIComponent(JSON.stringify({ t, d })) + ' -->\n';
}

// ═════════ 순수 함수 ═════════

test('학번 검사: 올바른 학번 통과', () => {
  for (const s of ['10101', '31640', '21630', 10101]) assert.strictEqual(G.validateStudentId(s), true, String(s));
});

test('학번 검사: 잘못된 학번 거부', () => {
  for (const s of ['40101', '11701', '10100', '10141', '2031', '203151', '00101', '1010a', '', '２０３１５', '1０101']) {
    assert.strictEqual(G.validateStudentId(s), false, JSON.stringify(s));
  }
});

test('학번 검사: 앞뒤 공백은 잘라서 판정(안전)', () => {
  // 앞뒤 공백을 허용한다면, 저장·비교에 쓰는 값도 잘린 값이어야 안전하다 (bind 종단 테스트에서 확인)
  assert.strictEqual(G.validateStudentId(' 20315 '), true);
  assert.strictEqual(G.validateStudentId('203 15'), false);
});

test('학번 검사: 문자열·숫자가 아니면 거부', () => {
  for (const s of [null, undefined, {}, [], ['10101'], true, { toString() { return '10101'; } }]) {
    assert.strictEqual(G.validateStudentId(s), false, String(s));
  }
});

test('이름 정리: 줄바꿈·|·-->·<·> 제거', () => {
  const n = G.sanitizeName('김\n하\r늘|--><b>x</b>');
  for (const bad of ['\n', '\r', '|', '-->', '<', '>']) assert.ok(!n.includes(bad), '남은 문자: ' + JSON.stringify(bad) + ' in ' + n);
  assert.strictEqual(G.sanitizeName('  김   하늘  '), '김 하늘');
  assert.strictEqual(G.sanitizeName(null), '');
  assert.strictEqual(G.sanitizeName(undefined), '');
  assert.strictEqual(G.sanitizeName('김-->하|늘>'), '김하늘');
  assert.strictEqual(G.sanitizeName('-->'), '');
  // 제거 순서 때문에 '-->' 가 다시 생기지 않는지
  for (const tricky of ['--|>', '-->>', '<-->-->', '--->', '-<->']) {
    const t = G.sanitizeName(tricky);
    assert.ok(!t.includes('-->') && !t.includes('>'), JSON.stringify(tricky) + ' → ' + JSON.stringify(t));
  }
});

test('이름 정리: 길이는 자르지 않고 bind 에서 20자 초과 거부', () => {
  const long = '가'.repeat(50);
  assert.strictEqual(G.sanitizeName(long).length, 50);
  assert.strictEqual(G.NAME_MAX, 20);
});

test('표식: 붙여 넣은 가짜 제출 표식 제거, vibe-info 는 유지', () => {
  const info = infoLine('과학 게임', '재미있는 게임');
  const pasted = '<!-- vibe-submit:99999|해커 -->\n' + info + '<!DOCTYPE html><html><body>hi</body></html>';
  const stripped = G.stripSubmitMarkers(pasted);
  assert.ok(!stripped.includes('vibe-submit'), stripped);
  assert.ok(stripped.startsWith(info), '정보 줄이 맨 앞에 남아야 함');
  // 순서가 섞여 있어도, 여러 개여도 제거
  const mixed = '﻿  ' + info + '<!-- vibe-submit:1|a -->\r\n<!--vibe-submit:2|b-->' + '<html></html>';
  const s2 = G.stripSubmitMarkers(mixed);
  assert.ok(!s2.includes('vibe-submit'), s2);
  assert.ok(s2.includes('vibe-info'), s2);
  assert.strictEqual(G.stripSubmitMarkers(42), '');
});

test('표식: 본문 중간의 주석은 건드리지 않음', () => {
  const html = '<html><!-- vibe-submit:1|x --></html>';
  assert.strictEqual(G.stripSubmitMarkers(html), html);
});

test('표식: buildMarker 형식', () => {
  assert.strictEqual(G.buildMarker(' 20315 ', '김하늘'), '<!-- vibe-submit:20315|김하늘 -->\n');
  const m = G.buildMarker('20315', '김-->하|늘>');
  assert.strictEqual((m.match(/-->/g) || []).length, 1, m);
  assert.strictEqual((m.match(/\|/g) || []).length, 1, m);
});

test('표식: python common.py 가 연결된 (학번, 이름) 과 게임 정보를 읽음', () => {
  if (!PY) throw new Error('python 을 찾지 못함');
  const info = infoLine('원소 퀴즈', '주기율표 게임');
  const body = '<!DOCTYPE html><html><body>게임</body></html>';
  const pasted = '<!-- vibe-submit:99999|해커 -->\n' + info + body;
  for (const nm of ['김하늘', '김-->하|늘>', '이 름--', 'a<b>c']) {
    const content = G.buildMarker('20315', nm) + G.stripSubmitMarkers(pasted);
    const r = pyParse(content);
    assert.strictEqual(r.id, '20315', nm + ' → ' + JSON.stringify(r));
    assert.ok(!/[>|<]/.test(r.name), '이름에 위험 문자: ' + r.name);
    assert.strictEqual(r.name, G.sanitizeName(nm), nm);
    assert.strictEqual(r.t, '원소 퀴즈');
    assert.strictEqual(r.d, '주기율표 게임');
    assert.strictEqual(r.body, body);
  }
});

test('HTML 검사: 형식·크기', () => {
  assert.strictEqual(G.checkHtml(123, 100), 'BAD_REQUEST');
  assert.strictEqual(G.checkHtml(null, 100), 'BAD_REQUEST');
  assert.strictEqual(G.checkHtml('   hello', 100), 'NOT_HTML');
  assert.strictEqual(G.checkHtml('', 100), 'NOT_HTML');
  assert.strictEqual(G.checkHtml('  <html>', 100), null);
  assert.strictEqual(G.checkHtml('﻿<html>', 100), null);
  const h = '<' + '가'.repeat(10); // 11글자, 31바이트
  assert.strictEqual(G.checkHtml(h, 31), null, '정확히 최대 크기는 통과');
  assert.strictEqual(G.checkHtml(h, 30), 'TOO_LARGE', '바이트 기준으로 초과');
  assert.strictEqual(G.checkHtml('<' + '😀', 4), 'TOO_LARGE'); // 1 + 4 바이트
  assert.strictEqual(G.checkHtml('<' + '😀', 5), null);
  assert.strictEqual(G.utf8Length('가a😀'), 3 + 1 + 4);
  assert.strictEqual(G.utf8Length('가a😀'), Buffer.byteLength('가a😀', 'utf8'));
});

const CID = 'cid.apps.googleusercontent.com';
const NOW = 1_700_000_000;
function claims(over) {
  return Object.assign({ aud: CID, iss: 'https://accounts.google.com', exp: NOW + 3000, email: 'kid@school.kr', email_verified: 'true', hd: 'school.kr' }, over || {});
}

test('토큰 검사: aud·iss·exp·email_verified', () => {
  assert.strictEqual(G.checkClaims(claims(), CID, [], NOW), null);
  assert.strictEqual(G.checkClaims(claims({ iss: 'accounts.google.com', email_verified: true }), CID, [], NOW), null);
  assert.strictEqual(G.checkClaims(claims({ aud: 'other' }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims(), '', [], NOW), 'TOKEN_INVALID', 'clientId 없음');
  assert.strictEqual(G.checkClaims(claims({ iss: 'evil.com' }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ exp: NOW - 1 }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ exp: NOW }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ exp: 'abc' }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ email_verified: 'false' }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ email_verified: false }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ email_verified: undefined }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(claims({ email: '' }), CID, [], NOW), 'TOKEN_INVALID');
  assert.strictEqual(G.checkClaims(null, CID, [], NOW), 'TOKEN_INVALID');
});

test('토큰 검사: 허용 도메인', () => {
  const allow = ['school.kr'];
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: '' }), CID, allow, NOW), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@evil-school.kr', hd: 'evil-school.kr' }), CID, allow, NOW), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@evil-school.kr', hd: '' }), CID, allow, NOW), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@sub.school.kr', hd: '' }), CID, allow, NOW), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@school.kr.evil.com', hd: '' }), CID, allow, NOW), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@school.kr', hd: 'school.kr' }), CID, allow, NOW), null, 'hd 로 통과');
  // 보안 검토 반영: 허용 목록이 있으면 hd 만 인정, 이메일 도메인으로 대체하지 않음
  assert.strictEqual(G.checkClaims(claims({ email: 'a@School.KR', hd: '' }), CID, allow, NOW), 'DOMAIN_NOT_ALLOWED', 'hd 없으면 거부');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@school.kr', hd: '' }), CID, ['@SCHOOL.kr '], NOW), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: 'School.KR' }), CID, ['@SCHOOL.kr '], NOW), null, 'hd 대소문자 무시');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: '' }), CID, [], NOW), null, '빈 목록은 모두 허용');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: '' }), CID, [' ', ''], NOW), null);
});

test('캐시 TTL', () => {
  assert.strictEqual(G.cacheTtl(NOW + 3600, NOW), 300);
  const t = G.cacheTtl(NOW + 100, NOW);
  assert.ok(t >= 1 && t <= 90, String(t));
  assert.strictEqual(G.cacheTtl(NOW - 5, NOW), 0);
  assert.strictEqual(G.cacheTtl(NOW + 10, NOW), 0);
  assert.strictEqual(G.cacheTtl('abc', NOW), 0);
});

test('설정 읽기: 기본값', () => {
  const d = { roster_required: true, allowed_domains: [], max_html_bytes: 2097152, session_open: true, submit_per_minute: 5 };
  eq(G.parseConfig([]), d);
  eq(G.parseConfig([['키', '값'], ['submit_per_minute', 'abc']]), d);
  eq(G.parseConfig([['키', '값'], ['submit_per_minute', '50']]).submit_per_minute, 50);
  eq(G.parseConfig([['키', '값'], ['submit_per_minute', 9999]]).submit_per_minute, 200);
  eq(G.parseConfig(null), d);
  eq(G.parseConfig([['키', '값']]), d);
  eq(G.parseConfig([['키', '값'], ['max_html_bytes', 'abc'], ['session_open', ''], ['roster_required', '모름']]), d);
  eq(G.parseConfig([['키', '값'], ['max_html_bytes', -5]]), d);
});

test('설정 읽기: 참/거짓 여러 표현과 도메인 목록', () => {
  for (const v of [false, 'FALSE', 'false', ' No ', 'n', '0', 0, 'x', 'off', '아니오']) {
    const c = G.parseConfig([['키', '값'], ['session_open', v], ['ROSTER_REQUIRED', v]]);
    assert.strictEqual(c.session_open, false, JSON.stringify(v));
    assert.strictEqual(c.roster_required, false, JSON.stringify(v));
  }
  for (const v of [true, 'TRUE', 'yes', 'Y', '1', 1, 'o', 'ㅇ', 'on', '예']) {
    assert.strictEqual(G.parseConfig([['키', '값'], ['session_open', v]]).session_open, true, JSON.stringify(v));
  }
  const c = G.parseConfig([['키', '값'], ['allowed_domains', '@School.kr, b.kr;c.kr  d.kr'], ['max_html_bytes', '1000.7']]);
  eq(c.allowed_domains, ['school.kr', 'b.kr', 'c.kr', 'd.kr']);
  assert.strictEqual(c.max_html_bytes, 1000);
});

test('연결 판단(decideBind) 모든 경우', () => {
  const rows = [{ id: '10101', email: 'a@s.kr' }, { id: '10102', email: 'b@s.kr' }];
  const roster = ['10101', '10102', '10103'];
  assert.strictEqual(G.decideBind(rows, roster, true, '19999', 'z@s.kr'), 'NOT_IN_ROSTER');
  assert.strictEqual(G.decideBind(rows, roster, false, '19999', 'z@s.kr'), null, '명단 필수 아님');
  assert.strictEqual(G.decideBind(rows, roster, true, ' 10101 ', 'A@S.KR '), 'ALREADY_BOUND');
  assert.strictEqual(G.decideBind(rows, roster, true, '10101', 'c@s.kr'), 'ID_BOUND_TO_OTHER');
  assert.strictEqual(G.decideBind(rows, roster, true, '10103', 'a@s.kr'), 'EMAIL_BOUND_TO_OTHER_ID');
  assert.strictEqual(G.decideBind(rows, roster, true, '10103', 'c@s.kr'), null);
  assert.strictEqual(G.decideBind([], new Set(['10103']), true, '10103', 'c@s.kr'), null, 'Set 명단');
  assert.strictEqual(G.decideBind([], { '10103': '김' }, true, '10103', 'c@s.kr'), null, '객체 명단');
  assert.strictEqual(G.decideBind([], { '10103': '김' }, true, 'toString', 'c@s.kr'), 'NOT_IN_ROSTER', '프로토타입 키');
  assert.strictEqual(G.decideBind(null, null, true, '10103', 'c@s.kr'), 'NOT_IN_ROSTER');
});

test('다음 버전 번호(nextVersion)', () => {
  assert.strictEqual(G.nextVersion([], '10101'), 1);
  assert.strictEqual(G.nextVersion(null, '10101'), 1);
  const rows = [{ id: '10101', version: 1 }, { id: '10101', version: '3' }, { id: '10102', version: 9 }, { id: '10101', version: 'x' }];
  assert.strictEqual(G.nextVersion(rows, '10101'), 4);
  assert.strictEqual(G.nextVersion(rows, ' 10102 '), 10);
  assert.strictEqual(G.nextVersion(rows, '10103'), 1);
});

// ═════════ handleRequest 종단 테스트 (가짜 deps) ═════════

const TOKENS = {
  'eyJ.ALICE-SECRET-TOKEN.sig': { email: 'Alice@School.kr', domain: 'school.kr', displayName: '김하늘' },
  'eyJ.BOB-SECRET-TOKEN.sig': { email: 'bob@school.kr', domain: 'school.kr', displayName: '이바다' },
  'eyJ.CAROL-SECRET-TOKEN.sig': { email: 'carol@school.kr', domain: 'school.kr', displayName: '박구름' }
};
const ALL_SECRETS = Object.keys(TOKENS);
const ALL_EMAILS = ['alice@school.kr', 'bob@school.kr', 'carol@school.kr'];

function makeDeps(over) {
  const st = {
    cfg: { roster_required: true, allowed_domains: [], max_html_bytes: 4096, session_open: true },
    roster: { '10101': '김하늘', '10102': '이바다', '10103': '박구름' },
    bindings: [], subs: [], files: new Map(), rateOk: true, discarded: [], logs: [], lockOk: true, locks: 0, releases: 0, seq: 0,
    t: Date.parse('2026-11-20T01:00:00Z')
  };
  const deps = {
    now: () => new Date(st.t += 1000),
    readConfig: () => Object.assign({}, st.cfg),
    rateLimit: () => st.rateOk,
    discardFile: (id) => { st.discarded.push(id); },
    verifyToken: (tok) => (Object.prototype.hasOwnProperty.call(TOKENS, tok)
      ? Object.assign({ ok: true }, TOKENS[tok], { email: TOKENS[tok].email.toLowerCase() })
      : { ok: false, code: 'TOKEN_INVALID' }),
    readRoster: () => Object.assign({}, st.roster),
    readBindings: () => st.bindings.map((r) => Object.assign({}, r)),
    appendBinding: (row) => { st.bindings.push(Object.assign({}, row)); },
    readSubmissions: () => st.subs.map((r) => Object.assign({}, r)),
    saveFile: (name, text) => {
      if (st.files.has(name)) throw new Error('덮어쓰기 시도: ' + name);
      const id = 'file' + (++st.seq);
      st.files.set(name, { id, text });
      return id;
    },
    appendSubmission: (row) => { st.subs.push(Object.assign({}, row)); },
    sha256Hex: (text) => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex'),
    tryLock: () => { st.locks++; return st.lockOk; },
    releaseLock: () => { st.releases++; },
    log: (m) => { st.logs.push(String(m)); }
  };
  Object.assign(deps, over || {});
  return { deps, st };
}

const ALL_RESPONSES = [];
function call(deps, obj, raw) {
  const body = raw !== undefined ? raw : JSON.stringify(obj);
  const res = G.handleRequest(body, deps);
  const out = J(res);
  ALL_RESPONSES.push({ req: obj, res: out });
  return out;
}
const A = 'eyJ.ALICE-SECRET-TOKEN.sig', B = 'eyJ.BOB-SECRET-TOKEN.sig', C = 'eyJ.CAROL-SECRET-TOKEN.sig';
const PAGE = '<!DOCTYPE html><html><body>게임</body></html>';

test('ping', () => {
  const { deps } = makeDeps();
  const r = call(deps, { action: 'ping' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.serverTime && r.version, JSON.stringify(r));
});

test('whoami: 연결 전·후', () => {
  const { deps } = makeDeps();
  let r = call(deps, { action: 'whoami', idToken: A });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.email, 'alice@school.kr');
  assert.strictEqual(r.studentId, null);
  assert.strictEqual(call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' }).ok, true);
  r = call(deps, { action: 'whoami', idToken: A });
  assert.strictEqual(r.studentId, '10101');
  assert.strictEqual(r.name, '김하늘');
});

test('bind: 성공, 같은 쌍 다시 → alreadyBound·중복 행 없음', () => {
  const { deps, st } = makeDeps();
  let r = call(deps, { action: 'bind', idToken: A, studentId: ' 10101 ', name: ' 김하늘 ' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.studentId, '10101');
  assert.strictEqual(r.alreadyBound, false);
  assert.strictEqual(r.nameMismatch, false);
  assert.strictEqual(st.bindings.length, 1);
  assert.strictEqual(st.bindings[0].id, '10101', '저장되는 학번은 공백이 잘린 값');
  r = call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.alreadyBound, true);
  assert.strictEqual(st.bindings.length, 1, '중복 행이 생기면 안 됨');
  assert.strictEqual(st.locks, st.releases, '잠금은 항상 풀려야 함');
});

test('bind: 이름 불일치 표시', () => {
  const { deps, st } = makeDeps();
  const r = call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '홍길동' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.nameMismatch, true);
  assert.strictEqual(st.bindings[0].mismatch, true);
});

test('bind: 거부 경우들', () => {
  const { deps, st } = makeDeps();
  assert.strictEqual(call(deps, { action: 'bind', idToken: A, studentId: '10109', name: '김하늘' }).code, 'NOT_IN_ROSTER');
  assert.strictEqual(call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' }).ok, true);
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '10101', name: '이바다' }).code, 'ID_BOUND_TO_OTHER');
  assert.strictEqual(call(deps, { action: 'bind', idToken: A, studentId: '10102', name: '김하늘' }).code, 'EMAIL_BOUND_TO_OTHER_ID');
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '40101', name: '이바다' }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: ['10102'], name: '이바다' }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '10102' }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '<>|' }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '가'.repeat(21) }).code, 'BAD_REQUEST');
  assert.strictEqual(st.bindings.length, 1);
  assert.strictEqual(st.locks, st.releases);
  st.roster['10102'] = '가'.repeat(20);
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '가'.repeat(20) }).ok, true, '20자는 허용');
});

test('submit: 연결 전 → NOT_BOUND', () => {
  const { deps, st } = makeDeps();
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE }).code, 'NOT_BOUND');
  assert.strictEqual(st.files.size, 0);
});

test('submit: v1, v2 모두 보관(덮어쓰기 없음) + 서버 표식', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김-->하|늘>' });
  const html1 = '<!-- vibe-submit:99999|해커 -->\n' + infoLine('게임', '설명') + PAGE;
  const r1 = call(deps, { action: 'submit', idToken: A, html: html1 });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(r1.version, 1);
  const r2 = call(deps, { action: 'submit', idToken: A, html: PAGE.replace('게임', '게임2') });
  assert.strictEqual(r2.version, 2);
  assert.strictEqual(st.files.size, 2);
  const byPrefix = (p) => [...st.files.keys()].filter((k) => k.startsWith(p)).map((k) => st.files.get(k))[0];
  for (const k of st.files.keys()) assert.ok(/^10101_v[12]_\d{14}\.html$/.test(k), '파일 이름 형식: ' + k);
  const f1 = byPrefix('10101_v1_'), f2 = byPrefix('10101_v2_');
  assert.ok(f1 && f2, [...st.files.keys()].join(','));
  assert.notStrictEqual(f1.id, f2.id);
  assert.ok(f1.text.startsWith('<!-- vibe-submit:10101|김하늘 -->\n'), f1.text.slice(0, 60));
  assert.ok(!f1.text.includes('99999'), '가짜 표식이 남음');
  assert.ok(f1.text.includes('vibe-info'));
  assert.ok(f2.text.includes('게임2') && f1.text.includes('>게임<'));
  assert.strictEqual(r1.size, Buffer.byteLength(f1.text, 'utf8'));
  assert.strictEqual(st.subs.length, 2);
  assert.strictEqual(st.subs[0].fileId, f1.id);
  if (PY) {
    const p = pyParse(f1.text);
    assert.strictEqual(p.id, '10101');
    assert.strictEqual(p.name, '김하늘');
    assert.strictEqual(p.t, '게임');
  }
  assert.strictEqual(st.locks, st.releases);
});

test('submit: 형식·크기 오류', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: 'hello' }).code, 'NOT_HTML');
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: '<!-- vibe-submit:1|a -->\nhello' }).code, 'NOT_HTML');
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: infoLine('a', 'b') }).code, 'NOT_HTML');
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: 5 }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: '<' + '가'.repeat(2000) }).code, 'TOO_LARGE');
  assert.strictEqual(st.files.size, 0);
});

test('list_mine: 내 제출만, 이메일 없음', () => {
  const { deps } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '이바다' });
  call(deps, { action: 'submit', idToken: A, html: PAGE });
  call(deps, { action: 'submit', idToken: B, html: PAGE });
  call(deps, { action: 'submit', idToken: A, html: PAGE });
  const r = call(deps, { action: 'list_mine', idToken: A });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.studentId, '10101');
  eq(r.items.map((i) => i.version), [1, 2]);
  const s = JSON.stringify(r);
  assert.ok(!/email/i.test(s), '응답에 email 필드: ' + s);
  assert.ok(!s.includes('@'), '응답에 이메일 주소: ' + s);
  assert.strictEqual(call(deps, { action: 'list_mine', idToken: C }).code, 'NOT_BOUND');
});

test('제출 시간 아님 → SESSION_CLOSED', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  st.cfg.session_open = false;
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE }).code, 'SESSION_CLOSED');
  assert.strictEqual(st.files.size, 0);
});

test('잠금 실패 → BUSY', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  st.lockOk = false;
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE }).code, 'BUSY');
  assert.strictEqual(call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '이바다' }).code, 'BUSY');
  assert.strictEqual(st.files.size, 0);
  assert.strictEqual(st.bindings.length, 1);
});

test('토큰 검증 실패 → TOKEN_INVALID / 도메인 코드 전달', () => {
  const { deps } = makeDeps();
  for (const action of ['whoami', 'bind', 'submit', 'list_mine']) {
    assert.strictEqual(call(deps, { action, idToken: 'forged', studentId: '10101', name: '김', html: PAGE }).code, 'TOKEN_INVALID', action);
  }
  assert.strictEqual(call(deps, { action: 'whoami' }).code, 'TOKEN_INVALID');
  const d2 = makeDeps({ verifyToken: () => ({ ok: false, code: 'DOMAIN_NOT_ALLOWED' }) }).deps;
  assert.strictEqual(call(d2, { action: 'whoami', idToken: A }).code, 'DOMAIN_NOT_ALLOWED');
  const d3 = makeDeps({ verifyToken: () => ({ ok: false, code: 'WEIRD' }) }).deps;
  assert.strictEqual(call(d3, { action: 'whoami', idToken: A }).code, 'TOKEN_INVALID');
  const d4 = makeDeps({ verifyToken: () => null }).deps;
  assert.strictEqual(call(d4, { action: 'whoami', idToken: A }).code, 'TOKEN_INVALID');
});

test('잘못된 요청 → BAD_REQUEST', () => {
  const { deps } = makeDeps();
  assert.strictEqual(call(deps, { action: 'delete_all', idToken: A }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, { idToken: A }).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, null, '{not json').code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, null, '').code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, null, '[1,2]').code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, null, 'null').code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, null, '"ping"').code, 'BAD_REQUEST');
  assert.strictEqual(G.handleRequest(undefined, deps).code, 'BAD_REQUEST');
  assert.strictEqual(call(deps, null, JSON.stringify({ action: 'whoami', idToken: A, pad: 'x'.repeat(4096 + 64 * 1024 + 10) })).code, 'BAD_REQUEST', '본문 너무 큼');
});

test('deps 예외 → SERVER_ERROR, 비밀 메시지는 응답에 없음', () => {
  const SECRET = 'SHEET_PASSWORD_hunter2_' + 'alice@school.kr';
  const boom = () => { throw new Error(SECRET); };
  for (const key of ['readBindings', 'readConfig', 'saveFile', 'verifyToken', 'now']) {
    const { deps, st } = makeDeps();
    call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
    deps[key] = boom;
    const action = key === 'now' ? 'ping' : 'submit'; // ping 은 readConfig 를 부르지 않음
    const r = call(deps, { action, idToken: A, html: PAGE });
    assert.strictEqual(r.code, 'SERVER_ERROR', key + ' → ' + JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('hunter2'), '비밀이 응답에 노출: ' + key);
    assert.strictEqual(st.locks, st.releases, '예외 후에도 잠금 해제: ' + key);
    for (const l of st.logs) for (const t of ALL_SECRETS) assert.ok(!l.includes(t), '로그에 토큰');
  }
  // log 까지 예외여도 응답은 SERVER_ERROR
  const { deps } = makeDeps({ readConfig: boom, log: boom });
  assert.strictEqual(call(deps, { action: 'whoami', idToken: A }).code, 'SERVER_ERROR');
});

// ═════════ 보안 검토 반영 테스트 ═════════

test('이름 정리: -- 와 양방향 제어문자 제거', () => {
  assert.strictEqual(G.sanitizeName('김--하늘'), '김하늘');
  assert.strictEqual(G.sanitizeName('a---b'), 'ab');
  assert.strictEqual(G.sanitizeName('a-b'), 'a-b', '하이픈 하나는 유지');
  assert.strictEqual(G.sanitizeName('김‮하⁦늘⁩‪'), '김하늘');
  assert.strictEqual(G.sanitizeName('-​-'), '', '숨은 문자 제거 뒤 생긴 -- 도 제거');
  for (const nm of ['a--b', '--', '-<->-', '김-->하', '이 름--']) {
    const m = G.buildMarker('20315', nm);
    const inner = m.slice('<!--'.length, m.lastIndexOf('-->'));
    assert.ok(!inner.includes('--'), '주석 안에 --: ' + JSON.stringify(m));
  }
});

test('이름 비교: 공백만 무시하고 정확히 비교 (포함 관계는 불일치)', () => {
  assert.strictEqual(G.namesMatch('김 하늘', '김하늘'), true);
  assert.strictEqual(G.namesMatch('김하', '김하늘'), false);
  assert.strictEqual(G.namesMatch('김하늘', '김하늘님'), false);
  assert.strictEqual(G.namesMatch('', '김하늘'), false);
  assert.strictEqual(G.namesMatch('', ''), false);
  const { deps, st } = makeDeps();
  const r = call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하' });
  assert.strictEqual(r.ok, true, '불일치여도 연결은 됨');
  assert.strictEqual(r.nameMismatch, true);
  assert.strictEqual(st.bindings[0].mismatch, true);
});

const b64u = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (seg) => Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function jwt(over) {
  return b64u({ alg: 'RS256' }) + '.' + b64u(Object.assign({ aud: CID, iss: 'accounts.google.com', exp: NOW + 600 }, over || {})) + '.c2ln';
}

test('토큰 사전 검사(precheckToken)', () => {
  assert.strictEqual(G.precheckToken(jwt(), CID, NOW, dec), null);
  assert.strictEqual(G.precheckToken(jwt({ iss: 'https://accounts.google.com' }), CID, NOW, dec), null);
  assert.strictEqual(G.precheckToken(jwt({ aud: 'other' }), CID, NOW, dec), 'TOKEN_INVALID');
  assert.strictEqual(G.precheckToken(jwt(), '', NOW, dec), 'TOKEN_INVALID');
  assert.strictEqual(G.precheckToken(jwt({ iss: 'evil.com' }), CID, NOW, dec), 'TOKEN_INVALID');
  assert.strictEqual(G.precheckToken(jwt({ exp: NOW }), CID, NOW, dec), 'TOKEN_INVALID');
  assert.strictEqual(G.precheckToken(jwt({ exp: 'x' }), CID, NOW, dec), 'TOKEN_INVALID');
  for (const bad of ['', 'a.b', 'a.b.c.d', 'a..c', 'a.b c.d', 'a.b+.c', null, 5, 'x'.repeat(5000)]) {
    assert.strictEqual(G.precheckToken(bad, CID, NOW, dec), 'TOKEN_INVALID', JSON.stringify(bad));
  }
  assert.strictEqual(G.precheckToken('aaa.bm90anNvbg.ccc', CID, NOW, dec), 'TOKEN_INVALID', 'JSON 아님');
  assert.strictEqual(G.precheckToken(jwt(), CID, NOW, () => { throw new Error('x'); }), 'TOKEN_INVALID', '디코드 예외');
  assert.strictEqual(G.precheckToken('a.' + b64u(5) + '.c', CID, NOW, dec), 'TOKEN_INVALID', '객체 아님');
});

test('ping: 시트(readConfig) 를 읽지 않음', () => {
  let n = 0;
  const { deps } = makeDeps({ readConfig: () => { n++; throw new Error('시트 읽음'); } });
  const r = call(deps, { action: 'ping' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 0);
});

test('submit: requestId 재전송은 기존 결과 + duplicate (파일 새로 안 만듦)', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '이바다' });
  const r1 = call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: 'req-1' });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.ok(!('duplicate' in r1));
  assert.strictEqual(st.subs[0].requestId, 'req-1');
  const r2 = call(deps, { action: 'submit', idToken: A, html: PAGE + 'x', requestId: 'req-1' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.duplicate, true);
  for (const k of ['studentId', 'version', 'size', 'sha256', 'submittedAt']) assert.strictEqual(r2[k], r1[k], k);
  assert.strictEqual(st.files.size, 1);
  assert.strictEqual(st.subs.length, 1);
  // 다른 사람이 같은 requestId 를 써도 남의 결과를 받지 않음
  const r3 = call(deps, { action: 'submit', idToken: B, html: PAGE, requestId: 'req-1' });
  assert.ok(r3.ok && !r3.duplicate && r3.studentId === '10102', JSON.stringify(r3));
  // 새 requestId·없음은 새 버전
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: 'req-2' }).version, 2);
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE }).version, 3);
  assert.strictEqual(st.locks, st.releases);
});

test('submit: 잘못된 requestId → BAD_REQUEST', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  for (const id of ['', 'a'.repeat(65), 'a b', 'a_b', '가', 5, {}, ['x']]) {
    assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: id }).code, 'BAD_REQUEST', JSON.stringify(id));
  }
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: 'A'.repeat(64) }).ok, true, '64자 허용');
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: null }).ok, true, 'null 은 없음 취급');
  assert.strictEqual(st.files.size, 2);
});

test('submit: 제출 빈도 제한 → BUSY (다른 안내 문구)', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  st.rateOk = false;
  const r = call(deps, { action: 'submit', idToken: A, html: PAGE });
  assert.strictEqual(r.code, 'BUSY');
  st.lockOk = false; st.rateOk = true;
  const busy = call(deps, { action: 'submit', idToken: A, html: PAGE });
  assert.strictEqual(busy.code, 'BUSY');
  assert.notStrictEqual(r.message, busy.message, '빈도 제한 문구는 잠금 실패와 달라야 함');
  assert.strictEqual(st.files.size, 0);
});

test('submit: 기록 실패 시 방금 만든 파일 폐기 → SERVER_ERROR', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  deps.appendSubmission = () => { throw new Error('sheet full'); };
  const r = call(deps, { action: 'submit', idToken: A, html: PAGE });
  assert.strictEqual(r.code, 'SERVER_ERROR');
  assert.strictEqual(st.discarded.length, 1);
  assert.strictEqual(st.discarded[0], [...st.files.values()][0].id);
  assert.strictEqual(st.locks, st.releases);
  // 폐기까지 실패해도 SERVER_ERROR
  deps.discardFile = () => { throw new Error('drive'); };
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE }).code, 'SERVER_ERROR');
});

test('Code.gs: tokeninfo 는 URL 이 아니라 POST 본문으로 토큰 전송', () => {
  assert.ok(!/tokeninfo\?id_token/.test(SRC));
  assert.ok(/method:\s*'post'[\s\S]{0,80}id_token/.test(SRC));
  assert.ok(/tryLock\(20000\)/.test(SRC));
  assert.ok(/SpreadsheetApp\.flush\(\)[\s\S]{0,120}releaseLock\(\)/.test(SRC), 'flush 후 잠금 해제');
});

test('모든 응답에 토큰 문자열·다른 사람 이메일 없음', () => {
  assert.ok(ALL_RESPONSES.length > 30, '응답 수 ' + ALL_RESPONSES.length);
  const own = { [A]: 'alice@school.kr', [B]: 'bob@school.kr', [C]: 'carol@school.kr' };
  for (const { req, res } of ALL_RESPONSES) {
    const s = JSON.stringify(res);
    for (const t of ALL_SECRETS) assert.ok(!s.includes(t) && !s.includes('SECRET-TOKEN'), '토큰 노출: ' + s);
    const mine = req && own[req.idToken];
    for (const e of ALL_EMAILS) if (e !== mine) assert.ok(!s.toLowerCase().includes(e), '다른 사람 이메일 노출: ' + s);
  }
});

// ═════════ 정적 검사 ═════════

test('Code.gs: HtmlService·eval·new Function 없음', () => {
  assert.ok(!/HtmlService/.test(SRC));
  assert.ok(!/\beval\s*\(/.test(SRC));
  assert.ok(!/new\s+Function\b/.test(SRC));
});

test('Code.gs: Logger/console 호출에 토큰 없음', () => {
  const lines = SRC.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    if (/\b(Logger\.log|console\.\w+|deps\.log)\s*\(/.test(l) && /token|idToken|req\b|body\b|html/i.test(l)) bad.push((i + 1) + ': ' + l.trim());
  });
  assert.deepStrictEqual(bad, []);
});

const LAB = fs.readFileSync(LAB_PATH, 'utf8');

test('lab/index.html: 브라우저 저장소·쿠키 사용 없음', () => {
  assert.ok(!/\blocalStorage\b/.test(LAB), 'localStorage');
  assert.ok(!/\bsessionStorage\b/.test(LAB), 'sessionStorage');
  assert.ok(!/document\s*\.\s*cookie/.test(LAB), 'document.cookie');
});

test('lab/index.html: 외부 스크립트는 GIS 하나뿐', () => {
  const srcs = [...LAB.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
  assert.deepStrictEqual(srcs, ['https://accounts.google.com/gsi/client']);
});

test('lab/index.html: CONFIG 자리표시자(YOUR_) 있음', () => {
  assert.ok(/YOUR_/.test(LAB));
  assert.ok(/GOOGLE_CLIENT_ID\s*:\s*'YOUR_/.test(LAB));
  assert.ok(/WEB_APP_URL\s*:\s*'[^']*YOUR_/.test(LAB));
});

test('lab/index.html: 이모지 없음', () => {
  const found = [];
  LAB.split('\n').forEach((l, i) => { const m = l.match(/\p{Extended_Pictographic}/u); if (m) found.push((i + 1) + ': ' + m[0] + ' U+' + m[0].codePointAt(0).toString(16)); });
  assert.deepStrictEqual(found, []);
});

// ── 결과 ──
const fail = results.filter((r) => !r[1]).length;
console.log('\n' + results.length + '개 중 ' + (results.length - fail) + '개 통과, ' + fail + '개 실패');
process.exit(fail ? 1 : 0);
