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
  for (const s of ['10101', '31640', '21630', 10101, '10141', '31699', '31098']) assert.strictEqual(G.validateStudentId(s), true, String(s)); // 번호는 01~99 (시험용 번호 허용)
});

test('학번 검사: 잘못된 학번 거부', () => {
  for (const s of ['40101', '11701', '10100', '2031', '203151', '00101', '1010a', '', '２０３１５', '1０101']) {
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

test('개인 계정 허용(allow_personal)', () => {
  const allow = ['school.kr'];
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: '' }), CID, allow, NOW, true), null, '개인 계정 통과');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: '' }), CID, allow, NOW, false), 'DOMAIN_NOT_ALLOWED');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@gmail.com', hd: '' }), CID, allow, NOW, 'TRUE'), 'DOMAIN_NOT_ALLOWED', '불리언만 인정');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@other.kr', hd: 'other.kr' }), CID, allow, NOW, true), 'DOMAIN_NOT_ALLOWED', '다른 Workspace 는 거부');
  assert.strictEqual(G.checkClaims(claims({ email: 'a@school.kr', hd: 'school.kr' }), CID, allow, NOW, true), null);
  assert.strictEqual(G.checkClaims(claims({ aud: 'x', hd: '' }), CID, allow, NOW, true), 'TOKEN_INVALID', '토큰 검사는 그대로');
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
  const d = { roster_required: true, allowed_domains: [], max_html_bytes: 2097152, session_open: true, submit_per_minute: 5, allow_personal: false, auth_mode: 'password', vote_open: true };
  eq(G.parseConfig([]), d);
  eq(G.parseConfig([['키', '값'], ['vote_open', 'FALSE']]).vote_open, false);
  eq(G.parseConfig([['키', '값'], ['vote_open', '모름']]).vote_open, true);
  eq(G.parseConfig([['키', '값'], ['allow_personal', 'TRUE']]).allow_personal, true);
  eq(G.parseConfig([['키', '값'], ['allow_personal', '모름']]).allow_personal, false);
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
  'eyJ.CAROL-SECRET-TOKEN.sig': { email: 'carol@school.kr', domain: 'school.kr', displayName: '박구름' },
  'eyJ.DAVE-SECRET-TOKEN.sig': { email: 'dave@gmail.com', domain: 'gmail.com', displayName: 'Dave', personal: true }
};
const ALL_SECRETS = Object.keys(TOKENS);
const ALL_EMAILS = ['alice@school.kr', 'bob@school.kr', 'carol@school.kr', 'dave@gmail.com'];

const PEPPER = 'PEPPER-SECRET-q9z8';
function makeDeps(over) {
  const st = {
    cfg: { roster_required: true, allowed_domains: [], max_html_bytes: 4096, session_open: true, vote_open: true, auth_mode: 'google' },
    accounts: [], fails: {}, pepper: PEPPER, saltSeq: 0, sessions: new Map(), sv: {}, globalFails: 0,
    inLock: false, lockHashes: 0, hashedInLock: false,
    roster: { '10101': '김하늘', '10102': '이바다', '10103': '박구름' },
    bindings: [], subs: [], notes: [], votes: [], gallery: [], files: new Map(), rateOk: true, discarded: [], logs: [], lockOk: true, locks: 0, releases: 0, seq: 0,
    t: Date.parse('2026-11-20T01:00:00Z')
  };
  const deps = {
    now: () => new Date(st.t += 1000),
    readConfig: () => Object.assign({}, st.cfg),
    rateLimit: () => st.rateOk,
    // 진짜 드라이브처럼: 휴지통으로 보낸 파일은 목록에서 빠지고, 이름 바꾸기는 같은 파일의 이름만 바꿈
    discardFile: (id) => {
      st.discarded.push(id);
      for (const [n, f] of st.files) if (f.id === id) st.files.delete(n);
    },
    renameFile: (id, name) => {
      for (const [n, f] of st.files) {
        if (f.id !== id) continue;
        if (st.files.has(name)) throw new Error('덮어쓰기 시도: ' + name);
        st.files.delete(n);
        st.files.set(name, f);
        return;
      }
      throw new Error('없는 파일: ' + id);
    },
    verifyToken: (tok) => (Object.prototype.hasOwnProperty.call(TOKENS, tok)
      ? Object.assign({ ok: true }, TOKENS[tok], { email: TOKENS[tok].email.toLowerCase() })
      : { ok: false, code: 'TOKEN_INVALID' }),
    readRoster: () => Object.assign({}, st.roster),
    markReset: (id, at) => {
      const a = st.accounts.find((x) => x.id === id);
      if (!a) return false;
      a.reset = true; a.resetAt = at;
      return true;
    },
    lockedIds: (ids) => ids.filter((id) => (st.fails[id] || 0) >= 5),
    upsertRoster: (id, name) => { st.roster[id] = name; st.rosterAuto = (st.rosterAuto || 0) + 1; },
    readBindings: () => st.bindings.map((r) => Object.assign({}, r)),
    appendBinding: (row) => { st.bindings.push(Object.assign({}, row)); },
    readSubmissions: () => st.subs.map((r) => Object.assign({}, r)),
    appendNote: (n) => { st.notes.push(Object.assign({}, n)); },
    appendVote: (v) => { st.votes.push(Object.assign({}, v)); },
    readNotesMeta: () => st.notes.map((n) => ({ at: n.at, id: n.id, section: n.section })),
    readNotes: () => st.notes.map((n) => Object.assign({}, n)),
    readVotes: () => st.votes.map((v) => Object.assign({}, v)),
    readGallery: () => st.gallery.map((g) => Object.assign({}, g)),
    writeGallery: (rows) => { st.gallery = rows.map((g) => Object.assign({}, g)); },
    voteOpen: () => st.cfg.vote_open !== false,
    saveFile: (name, text) => {
      if (st.files.has(name)) throw new Error('덮어쓰기 시도: ' + name);
      const id = 'file' + (++st.seq);
      st.files.set(name, { id, text });
      return id;
    },
    appendSubmission: (row) => { st.subs.push(Object.assign({}, row)); },
    sha256Hex: (text) => (st.inLock && st.lockHashes++, require('crypto').createHash('sha256').update(text, 'utf8').digest('hex')),
    tryLock: () => { st.locks++; st.inLock = st.lockOk; st.lockHashes = 0; return st.lockOk; },
    releaseLock: () => { st.releases++; if (st.lockHashes > 10) st.hashedInLock = true; st.inLock = false; },
    log: (m) => { st.logs.push(String(m)); },
    readAccounts: () => st.accounts.map((a, i) => Object.assign({}, a, { row: i + 2 })),
    appendAccount: (a) => { st.accounts.push({ id: a.id, name: a.name, hash: a.hash, salt: a.salt, reset: false, resetAt: '', at: a.at }); },
    updateAccountPassword: (id, p) => {
      const a = st.accounts.find((x) => x.id === id);
      if (!a) return false;
      Object.assign(a, { hash: p.hash, salt: p.salt, reset: false, resetAt: '', changedAt: p.at });
      return true;
    },
    getPepper: () => st.pepper,
    newSalt: () => 'salt' + (++st.saltSeq),
    reserveAttempt: (id) => {
      const n = st.fails[id] || 0;
      if (n >= 5) return { ok: false };
      st.fails[id] = n + 1;
      return { ok: true };
    },
    clearFails: (id) => { delete st.fails[id]; },
    globalFails: () => st.globalFails,
    addGlobalFail: () => { st.globalFails++; },
    newSession: (id) => {
      const token = require('crypto').randomBytes(20).toString('hex');
      st.sessions.set(token, { id, v: st.sv[id] || 0, iat: st.t });
      return token;
    },
    resolveSession: (token) => {
      const x = st.sessions.get(token);
      if (!x || x.v !== (st.sv[x.id] || 0)) return null;
      return { id: x.id, issuedAt: x.iat };
    },
    bumpSessionVersion: (id) => { st.sv[id] = (st.sv[id] || 0) + 1; }
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
const D = 'eyJ.DAVE-SECRET-TOKEN.sig';
const PAGE = '<!DOCTYPE html><html><body>게임</body></html>';

test('bind: 개인 계정은 명단 이름이 같아야 연결, 계정종류 기록', () => {
  const { deps, st } = makeDeps();
  let r = call(deps, { action: 'bind', idToken: D, studentId: '10102', name: '이 바 다다' });
  eq(r.code, 'NAME_MISMATCH');
  assert.strictEqual(st.bindings.length, 0, '거부 시 행 없음');
  assert.strictEqual(st.locks, st.releases, '잠금 해제');
  r = call(deps, { action: 'bind', idToken: D, studentId: '10102', name: '이 바다' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st.bindings[0].personal, true);
  // 학교 계정은 이름이 달라도 표시만 하고 연결
  r = call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김구름' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.nameMismatch, true);
  assert.strictEqual(st.bindings[1].personal, false);
  // 개인 계정으로 연결된 학번은 학교 계정이 다시 가져갈 수 없음 (선생님이 행을 지워야 함)
  r = call(deps, { action: 'bind', idToken: B, studentId: '10102', name: '이바다' });
  eq(r.code, 'ID_BOUND_TO_OTHER');
});

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

test('submit: Submissions 는 잠금 안에서만 읽음 (잠금 밖에서 먼저 읽으면 버전이 겹침)', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  const orig = deps.readSubmissions;
  let outside = 0;
  deps.readSubmissions = () => { if (!st.inLock) outside++; return orig(); };
  for (let i = 0; i < 3; i++) {
    const r = call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: 'q' + i });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.version, i + 1);
  }
  // 재전송도 잠금 안에서 확인하고, 만든 파일은 버림
  const d = call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: 'q0' });
  assert.strictEqual(d.duplicate, true);
  assert.strictEqual(d.version, 1);
  assert.strictEqual(st.files.size, 3);
  assert.strictEqual(outside, 0, '잠금 밖에서 Submissions 를 읽으면 안 됨');
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

test('submit: 드라이브 저장은 잠금 밖에서, 잠금 안에서는 기록만', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  let inLock = false, savedInLock = null;
  const tl = deps.tryLock, rl = deps.releaseLock, sf = deps.saveFile;
  deps.tryLock = () => { inLock = true; return tl(); };
  deps.releaseLock = () => { inLock = false; return rl(); };
  deps.saveFile = (n, t) => { savedInLock = inLock; return sf(n, t); };
  const r = call(deps, { action: 'submit', idToken: A, html: PAGE });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(savedInLock, false, '드라이브 저장이 잠금 안에서 일어남');
  // 잠금을 못 잡으면 만든 파일은 휴지통으로
  st.lockOk = false;
  assert.strictEqual(call(deps, { action: 'submit', idToken: A, html: PAGE }).code, 'BUSY');
  assert.strictEqual(st.files.size, 1, '잠금 실패 때 만든 파일이 남음');
});

test('submit: 같은 requestId 가 동시에 두 번 와도 기록·파일은 하나', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  const rid = 'same-req-1';
  // 첫 요청이 잠금 밖 확인을 지난 뒤, 잠금 직전에 다른 요청이 같은 requestId 로 먼저 기록한 상황
  const tl = deps.tryLock;
  let injected = false;
  deps.tryLock = () => {
    if (!injected) {
      injected = true;
      st.subs.push({ at: new Date(st.t), id: '10101', email: 'alice@school.kr', version: 1, fileId: 'other', size: 1, sha256: 'abc', requestId: rid });
    }
    return tl();
  };
  const r = call(deps, { action: 'submit', idToken: A, html: PAGE, requestId: rid });
  assert.strictEqual(r.duplicate, true, JSON.stringify(r));
  assert.strictEqual(st.subs.length, 1);
  assert.strictEqual(st.files.size, 0, '중복이면 방금 만든 파일은 휴지통으로');
});

test('submit: 기록 실패 시 방금 만든 파일 폐기 → SERVER_ERROR', () => {
  const { deps, st } = makeDeps();
  call(deps, { action: 'bind', idToken: A, studentId: '10101', name: '김하늘' });
  deps.appendSubmission = () => { throw new Error('sheet full'); };
  const r = call(deps, { action: 'submit', idToken: A, html: PAGE });
  assert.strictEqual(r.code, 'SERVER_ERROR');
  assert.strictEqual(st.discarded.length, 1);
  assert.strictEqual(st.files.size, 0, '만든 파일은 휴지통으로');
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

// ═════════ 비밀번호 방식 (auth_mode = password) ═════════

const PW_ALL = ['sky-PW-1234', 'sea-PW-5678', 'new-PW-9999', 'wrongPW-000', 'newer-PW-77', PEPPER];
const PW_RESP = [];
function pcall(deps, obj) {
  const r = J(G.handleRequest(JSON.stringify(obj), deps));
  PW_RESP.push(r);
  return r;
}
function pwDeps(over) {
  const x = makeDeps(over);
  x.st.cfg.auth_mode = 'password';
  return x;
}
const sha = (t) => require('crypto').createHash('sha256').update(t, 'utf8').digest('hex');
// 선생님이 초기화 칸에 Y 를 쓴 것처럼 (onEdit 가 시각을 기록)
function teacherReset(st, id, agoMs) {
  const a = st.accounts.find((x) => x.id === id);
  st.t += (agoMs || 0) + 1000; // 시간이 흐른 뒤 초기화 (세션 발급 이후)
  a.reset = true;
  a.resetAt = new Date(st.t - (agoMs || 0));
}

test('관리자 목록: 학번·이름으로 찾기, 제출 수·최근 제출, 해시·솔트는 내보내지 않음', () => {
  const accounts = [
    { id: '20316', name: '이바다', hash: 'H1', salt: 'S1', at: new Date('2026-11-20T01:00:00Z'), reset: false },
    { id: '20315', name: '김 하늘', hash: 'H2', salt: 'S2', at: '', reset: true }
  ];
  const subs = [
    { id: '20315', at: new Date('2026-11-20T02:00:00Z') },
    { id: '20315', at: new Date('2026-11-20T03:00:00Z') },
    { id: '99999', at: new Date('2026-11-20T03:00:00Z') }
  ];
  let r = J(G.adminRows(accounts, subs, '', ['20316']));
  assert.strictEqual(r.total, 2);
  eq(r.rows.map((x) => x.id), ['20315', '20316'], '학번 순');
  eq(r.rows[0], { id: '20315', name: '김 하늘', registeredAt: '', reset: true, locked: false, count: 2, lastAt: '2026-11-20T03:00:00.000Z',
    t1: '', t2: '', t3: '', voteAt: '', pick: null });
  // 제출 여부: 글 구간별 마지막 시각, 마지막 투표
  const meta = [{ id: '20316', section: 't1', at: new Date('2026-11-20T04:00:00Z') }, { id: '20316', section: 't1', at: new Date('2026-11-20T05:00:00Z') },
    { id: '20316', section: 't3', at: new Date('2026-11-20T06:00:00Z') }, { id: '20316', section: 'zz', at: new Date('2026-11-20T06:00:00Z') }];
  const vts = [{ id: '20316', at: new Date('2026-11-20T07:00:00Z'), pick: 3 }, { id: '20316', at: new Date('2026-11-20T08:00:00Z'), pick: 5 }];
  const r2 = J(G.adminRows(accounts, subs, '20316', [], meta, vts)).rows[0];
  eq([r2.t1, r2.t2, r2.t3, r2.voteAt, r2.pick], ['2026-11-20T05:00:00.000Z', '', '2026-11-20T06:00:00.000Z', '2026-11-20T08:00:00.000Z', 5]);
  assert.strictEqual(r.rows[1].locked, true);
  assert.ok(!JSON.stringify(r).includes('H1') && !JSON.stringify(r).includes('S2'), '해시·솔트 노출');
  eq(J(G.adminRows(accounts, subs, '김하늘', [])).rows.map((x) => x.id), ['20315'], '이름 공백 무시');
  eq(J(G.adminRows(accounts, subs, '0316', [])).rows.map((x) => x.id), ['20316'], '학번 일부');
  eq(J(G.adminRows(accounts, subs, '없는사람', [])).rows, []);
});

function pwLogin(deps, id, name) {
  pcall(deps, { action: 'register', studentId: id, name, password: 'blue-River-47x' });
  const r = pcall(deps, { action: 'login', studentId: id, password: 'blue-River-47x' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.session;
}

test('글 제출(note): 세션 필요, 구간·길이 검사, 다시 내면 추가만, 학번은 세션에서 정해짐', () => {
  const { deps, st } = pwDeps();
  st.cfg.roster_required = false;
  const sess = pwLogin(deps, '31040', '김하늘');
  assert.strictEqual(pcall(deps, { action: 'note', section: 't1', text: '안녕' }).code, 'BAD_REQUEST', '세션 없음');
  assert.strictEqual(pcall(deps, { action: 'note', session: 'x'.repeat(30), section: 't1', text: '안녕' }).code, 'SESSION_EXPIRED');
  const bads = [{ section: 't9', text: 'a' }, { section: 't1', text: '' }, { section: 't1', text: '   ' }, { section: 't1', text: 5 },
    { section: 't1', text: 'a'.repeat(G.NOTE_MAX + 1) }, { section: 'toString', text: 'a' }];
  for (const bad of bads) {
    assert.strictEqual(pcall(deps, Object.assign({ action: 'note', session: sess }, bad)).code, 'BAD_REQUEST', JSON.stringify(bad).slice(0, 40));
  }
  const r = pcall(deps, { action: 'note', session: sess, section: 't1', text: '[1차시] 31040 김하늘\r\n서약서: 2026. 11. 20. 서명 완료‮\n', studentId: '10101' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st.notes.length, 1);
  assert.strictEqual(st.notes[0].id, '31040', '학번은 세션에서 정함(요청의 studentId 무시)');
  assert.ok(!/[\r‮]/.test(st.notes[0].text), '제어·방향 문자 제거');
  assert.ok(st.notes[0].text.includes('서명 완료'));
  pcall(deps, { action: 'note', session: sess, section: 't1', text: '고친 글' });
  assert.strictEqual(st.notes.length, 2, '추가만 함');
  assert.ok(pcall(deps, { action: 'status', session: sess }).notes.t1);
  assert.strictEqual(st.locks, st.releases);
  st.cfg.session_open = false;
  assert.strictEqual(pcall(deps, { action: 'note', session: sess, section: 't2', text: 'a' }).code, 'SESSION_CLOSED');
});

test('투표(vote): 작품 번호 하나, 명단에 있는 우리 반 번호만, 내 작품은 거부, 닫으면 거부, 현황에 마지막 투표·내 번호', () => {
  const { deps, st } = pwDeps();
  st.cfg.roster_required = false;
  const sess = pwLogin(deps, '31040', '김하늘');
  // 명단이 없으면 투표를 받지 않음
  assert.strictEqual(pcall(deps, { action: 'vote', session: sess, pick: 3 }).code, 'VOTE_NOT_READY');
  let stt = pcall(deps, { action: 'status', session: sess });
  assert.strictEqual(stt.galleryReady, false);
  assert.strictEqual(stt.myNumber, null);
  // 10반 작품 1~5번, 31040 은 4번. 다른 반(310 이 아닌 3학년 11반) 7번
  st.gallery = [1, 2, 3, 5].map((n) => ({ id: '3100' + n, cls: 10, n })).concat([{ id: '31040', cls: 10, n: 4 }, { id: '31101', cls: 11, n: 7 }]);
  for (const bad of [null, 0, 100, 1.5, -1, 'a', '1e1', {}, [3]]) assert.strictEqual(pcall(deps, { action: 'vote', session: sess, pick: bad }).code, 'BAD_REQUEST', JSON.stringify(bad));
  assert.strictEqual(pcall(deps, { action: 'vote', pick: 3 }).code, 'BAD_REQUEST', '세션 없음');
  assert.strictEqual(pcall(deps, { action: 'vote', session: sess, pick: 4 }).code, 'SELF_VOTE', '내 작품');
  assert.strictEqual(pcall(deps, { action: 'vote', session: sess, pick: 7 }).code, 'NOT_IN_GALLERY', '다른 반 번호');
  assert.strictEqual(pcall(deps, { action: 'vote', session: sess, pick: 9 }).code, 'NOT_IN_GALLERY', '없는 번호');
  assert.strictEqual(st.votes.length, 0);
  const r = pcall(deps, { action: 'vote', session: sess, pick: '3', cls: 11, studentId: '10101' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  eq([st.votes[0].id, st.votes[0].cls, st.votes[0].pick], ['31040', 10, 3], '학번·반은 세션에서');
  pcall(deps, { action: 'vote', session: sess, pick: 5 });
  stt = pcall(deps, { action: 'status', session: sess });
  assert.strictEqual(stt.vote.pick, 5, '가장 나중 투표');
  assert.strictEqual(stt.myNumber, 4);
  assert.strictEqual(stt.galleryReady, true);
  st.cfg.vote_open = false;
  assert.strictEqual(pcall(deps, { action: 'vote', session: sess, pick: 3 }).code, 'VOTE_CLOSED');
  assert.strictEqual(st.locks, st.releases);
});

test('글·투표·현황은 구글 방식에서는 거부, 현황은 글 내용을 돌려주지 않음', () => {
  const g = makeDeps();
  g.st.cfg.auth_mode = 'google';
  for (const a of ['note', 'vote', 'status']) assert.strictEqual(call(g.deps, { action: a, idToken: A, section: 't1', text: 'a', votes: {} }).code, 'BAD_REQUEST', a);
  const { deps, st } = pwDeps();
  st.cfg.roster_required = false;
  const sess = pwLogin(deps, '31040', '김하늘');
  pcall(deps, { action: 'note', session: sess, section: 't2', text: '비밀 내용 XYZ' });
  assert.ok(!JSON.stringify(pcall(deps, { action: 'status', session: sess })).includes('XYZ'));
});

test('관리자 투표 집계: 투표자마다 마지막 한 번, 반(반 번호)별 득표 순, CSV', () => {
  const T = (m) => new Date(Date.parse('2026-11-20T01:00:00Z') + m * 60000);
  const votes = [
    { id: '31001', at: T(1), pick: 3 }, { id: '31001', at: T(5), pick: 4 },
    { id: '31002', at: T(2), pick: 4 }, { id: '31003', at: T(3), pick: 2 },
    { id: '21105', at: T(4), pick: 9 }, { id: 'bad', at: T(4), pick: 1 }, { id: '31004', at: T(4), pick: 0 }
  ];
  const t = J(G.adminTally(votes));
  eq(t.map((c) => [c.key, c.label, c.voters]), [['10', '10반', 3], ['11', '11반', 1]]);
  eq(t[0].top, [{ n: 4, count: 2 }, { n: 2, count: 1 }], '마지막 표만, 득표 순');
  const d = { readVotes: () => votes, voteOpen: () => true };
  assert.strictEqual(J(G.adminHandle(d, 'tally', '')).voteOpen, true);
  const v = J(G.adminHandle(d, 'votes', ''));
  assert.strictEqual(v.count, 4);
  assert.ok(v.csv.startsWith('﻿"학번","반","번호"'));
  assert.ok(v.csv.includes('"31001","10","4"'), '31001 은 마지막 표');
  assert.ok(!v.csv.includes('bad') && !v.csv.includes('31004'));
});

test('작품 번호 명단: mapping.csv 그대로 붙여넣기(공개 Y 만), 머리글 없는 형식, 잘못된 줄은 건너뜀, 올리면 통째로 바뀜', () => {
  const csv = '﻿학번,이름,반,번호,코드,해시,공개\r\n31001,가,10,1,abcde,h,Y\r\n31002,나,10,2,bcdef,h,\r\n31003,다,10,3,cdefg,h,Y\r\n' +
    '31104,라,11,1,defgh,h,Y\r\n31005,마,11,5,x,h,Y\r\n31006,바,10,3,y,h,Y\r\n31001,가,10,9,z,h,Y\r\n';
  let r = J(G.parseGalleryText(csv));
  eq(r.rows, [{ id: '31001', cls: 10, n: 1 }, { id: '31003', cls: 10, n: 3 }, { id: '31104', cls: 11, n: 1 }]);
  assert.strictEqual(r.skipped, 4, '비공개·반 불일치·번호 중복·학번 중복');
  eq(J(G.parseGalleryText('31001\t10\t2\n31002\t10\t3')).rows.map((x) => x.n), [2, 3], '탭·머리글 없음');
  for (const bad of ['', '   ', 5, null, '학번,이름\n31001,가', 'x'.repeat(G.GALLERY_TEXT_MAX + 1)]) assert.strictEqual(G.parseGalleryText(bad), null, String(bad).slice(0, 20));
  const { deps, st } = makeDeps();
  st.gallery = [{ id: '39999', cls: 99, n: 1 }];
  r = J(G.adminHandle(deps, 'gallery_set', csv));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.count, 3);
  eq(r.classes, ['10반 2개', '11반 1개']);
  assert.strictEqual(st.gallery.length, 3, '이전 명단은 지워짐');
  eq(J(G.adminHandle(deps, 'gallery_info', '')).classes, ['10반 2개', '11반 1개']);
  assert.strictEqual(J(G.adminHandle(deps, 'gallery_set', '학번,반,번호,공개\n31001,10,1,N')).code, 'BAD_REQUEST', '올릴 줄 없음');
  assert.strictEqual(st.gallery.length, 3, '실패하면 그대로');
  assert.strictEqual(st.locks, st.releases);
});

test('관리자 글 보기: 한 학생의 구간별 마지막 글·횟수, 없는 구간은 빈 칸, 잘못된 학번 거부', () => {
  const T = (m) => new Date(Date.parse('2026-11-20T01:00:00Z') + m * 60000);
  const notes = [
    { id: '31001', at: T(1), section: 't1', text: '옛 기획' },
    { id: '31001', at: T(3), section: 't1', text: '<b>새 기획</b>' },
    { id: '31001', at: T(2), section: 't3', text: '소감' },
    { id: '31002', at: T(4), section: 't1', text: '다른 학생' },
    { id: '31001', at: T(5), section: 'zz', text: '잘못된 구간' }
  ];
  const d = { readAccounts: () => [{ id: '31001', name: '김하늘', hash: 'H', salt: 'S' }], readNotes: () => notes,
    readSubmissions: () => [{ id: '31001', at: T(1), version: 1 }, { id: '31001', at: T(6), version: 2 }, { id: '31002', at: T(7), version: 1 }],
    readVotes: () => [{ id: '31001', at: T(2), pick: 3 }, { id: '31001', at: T(8), pick: 5 }],
    readGallery: () => [{ id: '31001', cls: 10, n: 4 }] };
  const r = J(G.adminHandle(d, 'note_view', ' 31001 '));
  eq(r.game, { count: 2, lastAt: T(6).toISOString(), version: 2 });
  eq(r.vote, { pick: 5, at: T(8).toISOString() });
  assert.strictEqual(r.myNumber, 4);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.name, '김하늘');
  eq(r.sections.map((x) => [x.section, x.times, x.text]), [['t1', 2, '<b>새 기획</b>'], ['t2', 0, ''], ['t3', 1, '소감']]);
  assert.strictEqual(r.sections[0].label, '1차시 기획서');
  assert.strictEqual(r.sections[0].at, T(3).toISOString());
  assert.ok(!JSON.stringify(r).includes('다른 학생') && !JSON.stringify(r).includes('"H"'), '다른 학생 글·해시 없음');
  assert.strictEqual(J(G.adminHandle(d, 'note_view', '31740')).code, 'BAD_REQUEST');
  assert.strictEqual(J(G.adminHandle(d, 'note_view', null)).code, 'BAD_REQUEST');
  const none = J(G.adminHandle(d, 'note_view', '31009'));
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.name, '');
  assert.ok(none.sections.every((x) => x.times === 0));
  eq([none.game.count, none.vote, none.myNumber], [0, null, null]);
});

test('관리자 화면: 학생 글은 textContent 로만 넣음(innerHTML 없음)', () => {
  assert.ok(!/innerHTML/.test(G.ADMIN_HTML), 'innerHTML 사용 금지');
  assert.ok(G.ADMIN_HTML.includes('pre.textContent=s.text'));
});

test('관리자 글 CSV: 학생 한 명이 한 줄, 1·2·4차시 글이 나란히(각각 가장 나중), 안 낸 학생도 줄, 반 필터, 수식 방지', () => {
  const T = (m) => new Date(Date.parse('2026-11-20T01:00:00Z') + m * 60000);
  const accounts = [{ id: '31001', name: '김하늘' }, { id: '31002', name: '이바다' }, { id: '31003', name: '안냄' }, { id: '21005', name: '박구름' }];
  const notes = [
    { id: '31001', at: T(1), section: 't1', text: '옛 글' },
    { id: '31001', at: T(3), section: 't1', text: '[1차시] 서약서: 2026. 11. 20. 서명 완료\n"따옴표", 쉼표' },
    { id: '31001', at: T(2), section: 't2', text: '=HYPERLINK("http://x","y")' },
    { id: '31002', at: T(2), section: 't3', text: '소감' },
    { id: '21005', at: T(2), section: 't1', text: '다른 반' },
    { id: '31001', at: T(2), section: 'zz', text: '잘못된 구간' }
  ];
  const d = { readAccounts: () => accounts, readNotes: () => notes };
  const r = J(G.adminHandle(d, 'notes', '310'));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.name, 'notes_310.csv');
  assert.strictEqual(r.count, 3, '안 낸 학생도 줄');
  const lines = r.csv.replace('﻿', '').trim().split('\r\n');
  assert.strictEqual(lines[0], '"학번","이름","1차시 기획서","1차시 기획서 제출시각","2~3차시 제작 기록","2~3차시 제작 기록 제출시각","4차시 소감","4차시 소감 제출시각"');
  assert.ok(lines[1].startsWith('"31001","김하늘","[1차시] 서약서: 2026. 11. 20. 서명 완료'), lines[1].slice(0, 60));
  assert.ok(lines[1].includes('""따옴표"", 쉼표') && lines[1].includes('"\'=HYPERLINK('), '이스케이프·수식 방지');
  assert.ok(lines.some((l) => l.startsWith('"31003","안냄","",""')), '안 낸 학생은 빈칸');
  assert.ok(!r.csv.includes('옛 글') && !r.csv.includes('다른 반') && !r.csv.includes('잘못된'));
  assert.strictEqual(J(G.adminHandle(d, 'notes', '')).count, 4, '전체');
  assert.strictEqual(J(G.adminHandle(d, 'notes', '399')).code, 'BAD_REQUEST');
  assert.strictEqual(J(G.adminHandle({ readAccounts: () => [], readNotes: () => [] }, 'notes', '110')).code, 'NOT_FOUND');
});

test('관리자 zip: 학번마다 최신 버전만, 반 단위, 파일 ID 없는 행 제외', () => {
  const subs = [
    { id: '31040', version: 1, fileId: 'f1' }, { id: '31040', version: 3, fileId: 'f3' }, { id: '31040', version: 2, fileId: 'f2' },
    { id: '31001', version: 1, fileId: 'g1' }, { id: '21005', version: 1, fileId: 'h1' },
    { id: '31002', version: 1, fileId: '' }, { id: 'bad', version: 1, fileId: 'x' }
  ];
  eq(J(G.adminLatest(subs, '310')).map((x) => [x.id, x.version, x.fileId, x.name]),
    [['31001', 1, 'g1', '31001_v1.html'], ['31040', 3, 'f3', '31040_v3.html']]);
  eq(J(G.adminLatest(subs, '')).map((x) => x.id), ['21005', '31001', '31040'], '전체');
  const deps = {
    readSubmissions: () => subs,
    zipFiles: (items) => { deps.got = items; return { b64: 'UEsDBA==' }; }
  };
  let r = J(G.adminHandle(deps, 'classes', ''));
  eq(r.classes.map((c) => [c.key, c.label, c.count]), [['210', '2학년 10반', 1], ['310', '3학년 10반', 2]]);
  r = J(G.adminHandle(deps, 'zip', '310'));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.name, 'submissions_310.zip');
  assert.strictEqual(r.count, 2);
  eq(deps.got, [{ name: '31001_v1.html', fileId: 'g1' }, { name: '31040_v3.html', fileId: 'f3' }]);
  assert.strictEqual(J(G.adminHandle(deps, 'zip', '399')).code, 'BAD_REQUEST');
  assert.strictEqual(J(G.adminHandle(deps, 'zip', '../x')).code, 'BAD_REQUEST');
  assert.strictEqual(J(G.adminHandle(deps, 'zip', '110')).code, 'NOT_FOUND');
  deps.zipFiles = () => ({ b64: 'A'.repeat(G.ADMIN_ZIP_MAX_B64 + 1) });
  assert.strictEqual(J(G.adminHandle(deps, 'zip', '310')).code, 'TOO_BIG');
});

test('관리자 비밀번호: 맞으면 통과, 여러 번 틀려도 잠기지 않음, 설정이 없으면 거부', () => {
  let pw = 'teacher-PW-9';
  const deps = { getAdminPassword: () => pw };
  assert.strictEqual(G.adminPasswordCheck(deps, 'nope'), 'WRONG');
  for (let i = 0; i < 20; i++) assert.strictEqual(G.adminPasswordCheck(deps, 'bad' + i), 'WRONG');
  assert.strictEqual(G.adminPasswordCheck(deps, 'teacher-PW-9'), 'OK', '많이 틀린 뒤에도 맞으면 통과');
  for (const bad of [undefined, null, 5, {}, 'x'.repeat(500), '']) assert.strictEqual(G.adminPasswordCheck(deps, bad), 'WRONG');
  pw = '';
  assert.strictEqual(G.adminPasswordCheck(deps, ''), 'NONE', '설정 없으면 빈 비밀번호도 거부');
});

test('관리자 화면: 스크립트 문법이 맞고 서버 호출 이름이 실제 함수와 맞음', () => {
  const m = /<script>([\s\S]*)<\/script>/.exec(G.ADMIN_HTML);
  assert.ok(m, '스크립트 없음');
  new vm.Script(m[1]); // 문법 오류면 여기서 던짐
  for (const fn of ['adminInfo', 'adminList', 'adminReset', 'adminClasses', 'adminZip', 'adminNotes', 'adminVotes', 'adminTallyView', 'adminNoteView', 'adminGalleryInfo', 'adminSetGallery']) {
    assert.strictEqual(typeof G[fn], 'function', fn);
    assert.ok(G.ADMIN_HTML.includes('.' + fn + '('), '화면이 ' + fn + ' 를 부르지 않음');
  }
  assert.ok(!/<script[^>]+src=|https?:\/\//.test(G.ADMIN_HTML), '외부 요청 금지');
});

test('관리자 초기화: 비밀번호=학번, 잠금 해제, 없는 학번·잘못된 형식 거부', () => {
  const { deps, st } = pwDeps();
  pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  for (let i = 0; i < 5; i++) pcall(deps, { action: 'login', studentId: '10101', password: 'wrong-PW-' + i });
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).code, 'LOCKED');
  let list = J(G.adminHandle(deps, 'list', '10101'));
  assert.strictEqual(list.rows[0].locked, true, '잠김 표시');
  const r = J(G.adminHandle(deps, 'reset', '10101'));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st.accounts[0].reset, true);
  assert.ok(st.accounts[0].resetAt, '초기화시각');
  assert.strictEqual(st.fails['10101'], undefined, '잠금 해제');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: '10101' }).ok, true, '학번으로 로그인');
  list = J(G.adminHandle(deps, 'list', ''));
  assert.strictEqual(list.rows[0].reset, true);
  assert.strictEqual(J(G.adminHandle(deps, 'reset', '10109')).code, 'NOT_REGISTERED');
  assert.strictEqual(J(G.adminHandle(deps, 'reset', '4x')).code, 'BAD_REQUEST');
  assert.strictEqual(J(G.adminHandle(deps, 'drop', '10101')).code, 'BAD_REQUEST');
  assert.strictEqual(st.locks, st.releases);
});

test('명단 없이 시작(roster_required=FALSE): 처음 등록하면 명단에 자동 추가, 이후엔 그 이름과 같아야 함', () => {
  const { deps, st } = pwDeps();
  st.cfg.roster_required = false;
  st.roster = {};
  let r = pcall(deps, { action: 'register', studentId: '20315', name: '김 하늘', password: 'sky-PW-1234' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st.roster['20315'], '김 하늘', '명단에 자동 추가');
  assert.strictEqual(st.rosterAuto, 1);
  // 같은 학번 다시 등록은 기존처럼 거부, 명단 추가도 다시 안 함
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '20315', name: '김하늘', password: 'sea-PW-5678' }).code, 'ALREADY_REGISTERED');
  assert.strictEqual(st.rosterAuto, 1);
  // 명단에 이름이 이미 있으면 그 이름과 같아야 함 (자동 추가 없음)
  st.roster['20316'] = '이바다';
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '20316', name: '이바닥', password: 'sea-PW-5678' }).code, 'NAME_MISMATCH');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '20316', name: '이바다', password: 'sea-PW-5678' }).ok, true);
  assert.strictEqual(st.rosterAuto, 1);
  // 명단에 학번만 있고 이름이 빈 경우는 이름을 채움
  st.roster['20317'] = '';
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '20317', name: '박구름', password: 'sun-PW-2468' }).ok, true);
  assert.strictEqual(st.roster['20317'], '박구름');
  // 학번 형식은 여전히 검사
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '41701', name: '누구', password: 'sun-PW-2468' }).code, 'BAD_REQUEST');
  assert.strictEqual(st.locks, st.releases);
});

test('설정 읽기: auth_mode 기본 password, 잘못된 값도 password', () => {
  assert.strictEqual(G.parseConfig([]).auth_mode, 'password');
  assert.strictEqual(G.parseConfig([['키', '값'], ['auth_mode', ' Google ']]).auth_mode, 'google');
  assert.strictEqual(G.parseConfig([['키', '값'], ['auth_mode', 'oauth']]).auth_mode, 'password');
  assert.strictEqual(G.parseConfig([['키', '값'], ['auth_mode', '']]).auth_mode, 'password');
});

test('hashPassword: 결정적, 솔트·페퍼·반복에 따라 달라짐', () => {
  const h1 = G.hashPassword('abcd', 's1', 'p', sha, 300);
  assert.strictEqual(h1, G.hashPassword('abcd', 's1', 'p', sha, 300));
  assert.ok(/^[0-9a-f]{64}$/.test(h1));
  assert.notStrictEqual(h1, G.hashPassword('abcd', 's2', 'p', sha, 300));
  assert.notStrictEqual(h1, G.hashPassword('abcd', 's1', 'q', sha, 300));
  assert.notStrictEqual(h1, G.hashPassword('abce', 's1', 'p', sha, 300));
  assert.notStrictEqual(h1, G.hashPassword('abcd', 's1', 'p', sha, 299));
  let h = 'abcd';
  for (let i = 0; i < 3; i++) h = sha(h + 's1' + 'p');
  assert.strictEqual(G.hashPassword('abcd', 's1', 'p', sha, 3), h, '정의대로 반복');
  assert.strictEqual(G.ITERATIONS, 300);
  assert.strictEqual(G.safeEqual('abc', 'abc'), true);
  assert.strictEqual(G.safeEqual('abc', 'abd'), false);
  assert.strictEqual(G.safeEqual('abc', 'abcd'), false);
  assert.strictEqual(G.safeEqual('', 'a'), false);
  assert.strictEqual(G.safeEqual('', ''), true);
});

test('validatePassword: 규칙 없음(빈칸·문자열 아님·너무 긴 것만 거부)', () => {
  for (const ok of ['a', '1234', '0000', '10101', '김하늘아', 'password', ' ', 'x'.repeat(100)]) {
    assert.strictEqual(G.validatePassword(ok), null, JSON.stringify(ok));
  }
  for (const bad of ['', 5, null, undefined, ['abcd'], 'x'.repeat(101)]) {
    assert.strictEqual(G.validatePassword(bad), 'WEAK_PASSWORD', JSON.stringify(bad));
  }
  assert.strictEqual(G.isLocked(4), false);
  assert.strictEqual(G.isLocked(5), true);
  assert.strictEqual(G.LOCK_AFTER, 5);
  assert.strictEqual(G.LOCK_SEC, 300);
});

test('register: 성공(세션 발급)·명단 없음·이름 불일치·중복·약한 비밀번호', () => {
  const { deps, st } = pwDeps();
  let r = pcall(deps, { action: 'register', studentId: ' 10101 ', name: '김 하늘', password: 'sky-PW-1234' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.studentId, '10101');
  assert.strictEqual(r.name, '김 하늘');
  assert.ok(typeof r.session === 'string' && r.session.length >= 16, '세션');
  assert.strictEqual(st.accounts.length, 1);
  assert.notStrictEqual(st.accounts[0].hash, 'sky-PW-1234', '평문 저장 금지');
  assert.strictEqual(st.accounts[0].hash, G.hashPassword('sky-PW-1234', st.accounts[0].salt, PEPPER, sha, 300));
  assert.strictEqual(st.hashedInLock, false, '해시는 잠금 밖에서');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10109', name: '아무개', password: 'sky-PW-1234' }).code, 'NOT_IN_ROSTER');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10102', name: '이바닥', password: 'sea-PW-5678' }).code, 'NAME_MISMATCH');
  // 명단에 이름이 비어 있으면 아무 이름으로나 등록되지 않게 거부
  st.roster['10104'] = '';
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10104', name: '아무나', password: 'sea-PW-5678' }).code, 'NOT_IN_ROSTER');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sea-PW-5678' }).code, 'ALREADY_REGISTERED');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10102', name: '이바다', password: '' }).code, 'WEAK_PASSWORD', '빈칸');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10103', name: '박구름', password: '1234' }).ok, true, '쉬운 비밀번호도 됨');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10102', name: '', password: 'sea-PW-5678' }).code, 'BAD_REQUEST');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '40102', name: '이바다', password: 'sea-PW-5678' }).code, 'BAD_REQUEST');
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10102', name: '이바다', password: 1234 }).code, 'BAD_REQUEST');
  assert.strictEqual(st.accounts.length, 2, '10101 과 쉬운 비밀번호로 등록한 10103');
  st.cfg.roster_required = false;
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10109', name: '아무개', password: 'sea-PW-5678' }).ok, true, '명단 필수 아님');
  assert.strictEqual(st.locks, st.releases);
  st.pepper = null;
  assert.strictEqual(pcall(deps, { action: 'register', studentId: '10103', name: '박구름', password: 'sea-PW-5678' }).code, 'SERVER_ERROR', '페퍼 없음');
});

test('login: 성공(세션)·틀림·미등록, 시도 5번이면 맞아도 LOCKED', () => {
  const { deps, st } = pwDeps();
  pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  const ok = pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.mustChange, false);
  assert.strictEqual(ok.name, '김하늘');
  assert.ok(typeof ok.session === 'string' && ok.session.length >= 16);
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10102', password: 'sky-PW-1234' }).code, 'NOT_REGISTERED');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'wrongPW-000' }).code, 'WRONG_PASSWORD');
  assert.strictEqual(st.fails['10101'], 1, '시도 횟수');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).ok, true);
  assert.strictEqual(st.fails['10101'], undefined, '성공하면 초기화');
  for (let i = 0; i < 5; i++) assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'wrongPW-000' }).code, 'WRONG_PASSWORD');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).code, 'LOCKED');
  assert.strictEqual(pcall(deps, { action: 'submit', studentId: '10101', password: 'sky-PW-1234', html: PAGE }).code, 'LOCKED');
  delete st.fails['10101']; // 5분 지남
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).ok, true);
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101' }).code, 'BAD_REQUEST', '비밀번호 없음');
  // 시도 예약 실패(짧은 잠금 실패) → BUSY
  const d2 = pwDeps({ reserveAttempt: () => ({ ok: false, busy: true }) });
  pcall(d2.deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  assert.strictEqual(pcall(d2.deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).code, 'BUSY');
});

test('login: 시도 예약은 해시 계산 전에 (동시 요청 경쟁 방지)', () => {
  const order = [];
  const x = pwDeps();
  pcall(x.deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  const r0 = x.deps.reserveAttempt, h0 = x.deps.sha256Hex;
  x.deps.reserveAttempt = (id) => { order.push('reserve'); return r0(id); };
  x.deps.sha256Hex = (t) => { if (order[order.length - 1] !== 'hash') order.push('hash'); return h0(t); };
  pcall(x.deps, { action: 'login', studentId: '10101', password: 'wrongPW-000' });
  eq(order, ['reserve', 'hash']);
});

test('전체 오답이 1분에 40번 넘으면 BUSY', () => {
  const { deps, st } = pwDeps();
  pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  pcall(deps, { action: 'register', studentId: '10102', name: '이바다', password: 'sea-PW-5678' });
  pcall(deps, { action: 'login', studentId: '10102', password: 'wrongPW-000' });
  assert.strictEqual(st.globalFails, 1);
  st.globalFails = 40;
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).ok, true, '40 은 허용');
  st.globalFails = 41;
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).code, 'BUSY');
  assert.strictEqual(pcall(deps, { action: 'change_password', studentId: '10101', password: 'sky-PW-1234', newPassword: 'new-PW-9999' }).code, 'BUSY');
  assert.strictEqual(st.fails['10101'], undefined, 'BUSY 는 시도 횟수를 쓰지 않음');
});

test('선생님 초기화: 학번으로 로그인하면 새 비밀번호를 먼저 정해야 함(학번 그대로는 안 됨), 예전 비밀번호·세션은 무효', () => {
  const { deps, st } = pwDeps();
  const reg = pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  teacherReset(st, '10101', 60000);
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: reg.session }).code, 'SESSION_EXPIRED', '초기화 전 세션 무효');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).code, 'WRONG_PASSWORD', '예전 비밀번호 무효');
  const r = pcall(deps, { action: 'login', studentId: '10101', password: '10101' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.mustChange, true, '새 비밀번호를 정해야 함');
  assert.strictEqual(r.session, null, '세션 없음');
  assert.strictEqual(pcall(deps, { action: 'submit', studentId: '10101', password: '10101', html: PAGE }).code, 'MUST_CHANGE_PASSWORD');
  const same = pcall(deps, { action: 'change_password', studentId: '10101', password: '10101', newPassword: '10101' });
  assert.strictEqual(same.code, 'WEAK_PASSWORD', '학번 그대로는 안 됨');
  assert.ok(same.message.includes('다른'), same.message);
  assert.strictEqual(pcall(deps, { action: 'change_password', studentId: '10101', password: '10101', newPassword: '' }).code, 'WEAK_PASSWORD');
  const ch = pcall(deps, { action: 'change_password', studentId: '10101', password: '10101', newPassword: '1234' });
  assert.strictEqual(ch.ok, true, JSON.stringify(ch));
  assert.strictEqual(ch.name, '김하늘');
  assert.ok(typeof ch.session === 'string' && ch.session.length >= 16, '바꾸면 바로 세션');
  assert.strictEqual(pcall(deps, { action: 'submit', session: ch.session, html: PAGE }).ok, true);
  assert.strictEqual(st.accounts[0].reset, false, '초기화 해제');
  assert.strictEqual(st.hashedInLock, false, '해시는 잠금 밖에서');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: '10101' }).code, 'WRONG_PASSWORD');
  const again = pcall(deps, { action: 'login', studentId: '10101', password: '1234' });
  assert.strictEqual(again.ok && again.mustChange === false && !!again.session, true, '다음부터는 새 비밀번호로 바로');
  assert.strictEqual(st.locks, st.releases);
});

test('선생님 초기화: 잠긴 학번도 바로 학번으로 로그인(잠금 해제), 초기화시각이 없어도 Y면 초기화', () => {
  const { deps, st } = pwDeps();
  pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  for (let i = 0; i < 5; i++) pcall(deps, { action: 'login', studentId: '10101', password: 'wrong-PW-' + i });
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).code, 'LOCKED');
  // 트리거가 시각을 못 적은 경우도 Y 만으로 초기화
  st.accounts[0].reset = true;
  st.accounts[0].resetAt = '';
  const r = pcall(deps, { action: 'login', studentId: '10101', password: '10101' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st.fails['10101'], undefined, '성공하면 시도 횟수 지움');
  assert.strictEqual(pcall(deps, { action: 'login', studentId: '10101', password: 'x10101' }).code, 'WRONG_PASSWORD');
});

test('세션: 비밀번호 변경 시 예전 세션 무효, 잘못된·만료 세션은 SESSION_EXPIRED, 행 삭제 시 무효', () => {
  const { deps, st } = pwDeps();
  const reg = pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  const s1 = pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).session;
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: s1 }).ok, true);
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: reg.session }).ok, true);
  const ch = pcall(deps, { action: 'change_password', studentId: '10101', password: 'sky-PW-1234', newPassword: 'new-PW-9999' });
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: s1 }).code, 'SESSION_EXPIRED');
  assert.strictEqual(pcall(deps, { action: 'submit', session: reg.session, html: PAGE }).code, 'SESSION_EXPIRED');
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: ch.session }).ok, true);
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: 'A'.repeat(40) }).code, 'SESSION_EXPIRED');
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: 'bad token!' }).code, 'SESSION_EXPIRED');
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: 12345 }).code, 'BAD_REQUEST');
  st.sessions.clear(); // 6시간 지남
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: ch.session }).code, 'SESSION_EXPIRED');
  const s2 = pcall(deps, { action: 'login', studentId: '10101', password: 'new-PW-9999' }).session;
  st.accounts = []; // 선생님이 행 삭제
  assert.strictEqual(pcall(deps, { action: 'list_mine', session: s2 }).code, 'SESSION_EXPIRED');
  // 세션 경로는 해시를 계산하지 않음
  pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' });
  const s3 = pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' }).session;
  let hashes = 0;
  const h0 = deps.sha256Hex;
  deps.sha256Hex = (t) => { hashes++; return h0(t); };
  assert.strictEqual(pcall(deps, { action: 'submit', session: s3, html: PAGE }).ok, true);
  assert.ok(hashes <= 1, '파일 해시 1번만: ' + hashes);
});

test('비밀번호 방식 submit: 세션·비밀번호 둘 다, v1·v2 보관, 이메일 칸 비움, list_mine 은 내 것만', () => {
  const { deps, st } = pwDeps();
  const sa = pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' }).session;
  pcall(deps, { action: 'register', studentId: '10102', name: '이바다', password: 'sea-PW-5678' });
  const A1 = { studentId: '10101', password: 'sky-PW-1234' };
  assert.strictEqual(pcall(deps, { action: 'submit', html: PAGE, studentId: '10101', password: 'wrongPW-000' }).code, 'WRONG_PASSWORD');
  const r1 = pcall(deps, { action: 'submit', session: sa, html: '<!-- vibe-submit:99999|x -->\n' + PAGE, requestId: 'r-1' });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(r1.version, 1);
  const dup = pcall(deps, Object.assign({ action: 'submit', html: PAGE, requestId: 'r-1' }, A1));
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(dup.version, 1);
  const rb = pcall(deps, { action: 'submit', studentId: '10102', password: 'sea-PW-5678', html: PAGE, requestId: 'r-1' });
  assert.ok(rb.ok && !rb.duplicate && rb.studentId === '10102', JSON.stringify(rb));
  const r2 = pcall(deps, Object.assign({ action: 'submit', html: PAGE }, A1));
  assert.strictEqual(r2.version, 2);
  assert.strictEqual(st.files.size, 3);
  for (const s of st.subs) assert.strictEqual(s.email, '');
  const f1 = [...st.files.entries()].find(([k]) => k.startsWith('10101_v1_'))[1];
  assert.ok(f1.text.startsWith('<!-- vibe-submit:10101|김하늘 -->\n'), f1.text.slice(0, 50));
  assert.ok(!f1.text.includes('99999'));
  const l = pcall(deps, { action: 'list_mine', session: sa });
  assert.strictEqual(l.studentId, '10101');
  eq(l.items.map((i) => i.version), [1, 2]);
  eq(pcall(deps, Object.assign({ action: 'list_mine' }, A1)).items.length, 2);
  st.cfg.session_open = false;
  assert.strictEqual(pcall(deps, { action: 'submit', session: sa, html: PAGE }).code, 'SESSION_CLOSED');
  assert.strictEqual(pcall(deps, { action: 'submit', studentId: '10101', password: 'wrongPW-000', html: PAGE }).code, 'SESSION_CLOSED', '인증 전에 확인');
  assert.strictEqual(st.locks, st.releases);
});

test('비밀번호 방식 빈도 제한은 학번 기준', () => {
  const keys = [];
  const { deps, st } = pwDeps({ rateLimit: (k) => { keys.push(k); return false; } });
  const s = pcall(deps, { action: 'register', studentId: '10101', name: '김하늘', password: 'sky-PW-1234' }).session;
  assert.strictEqual(pcall(deps, { action: 'submit', studentId: '10101', password: 'sky-PW-1234', html: PAGE }).code, 'BUSY');
  assert.strictEqual(pcall(deps, { action: 'submit', session: s, html: PAGE }).code, 'BUSY');
  eq(keys, ['id:10101', 'id:10101']);
  assert.strictEqual(st.files.size, 0);
});

test('인증 방식에 맞지 않는 동작은 BAD_REQUEST', () => {
  const p = pwDeps().deps;
  for (const action of ['whoami', 'bind']) {
    assert.strictEqual(pcall(p, { action, idToken: A, studentId: '10101', name: '김하늘' }).code, 'BAD_REQUEST', action);
  }
  assert.strictEqual(pcall(p, { action: 'submit', idToken: A, html: PAGE }).code, 'BAD_REQUEST', '비밀번호 방식 submit 에 토큰만');
  const g = makeDeps().deps; // google
  for (const action of ['register', 'login', 'change_password']) {
    assert.strictEqual(pcall(g, { action, studentId: '10101', name: '김하늘', password: 'sky-PW-1234', newPassword: 'new-PW-9999' }).code, 'BAD_REQUEST', action);
  }
  assert.strictEqual(pcall(p, { action: 'ping' }).ok, true);
});

test('비밀번호·페퍼·솔트는 어떤 응답·로그에도 없음', () => {
  assert.ok(PW_RESP.length > 60, String(PW_RESP.length));
  const { deps, st } = pwDeps({ readAccounts: () => { throw new Error('boom'); } });
  pcall(deps, { action: 'login', studentId: '10101', password: 'sky-PW-1234' });
  const all = PW_RESP.map((r) => JSON.stringify(r)).concat(st.logs);
  for (const s of all) for (const pw of PW_ALL) assert.ok(!s.includes(pw), '노출: ' + pw + ' in ' + s);
  assert.ok(!/salt\d/.test(all.join('')), '솔트 노출');
});

test('Code.gs: onEdit·setup 페퍼 보호·세션 키는 해시', () => {
  assert.ok(/function onEdit\(e\)/.test(SRC));
  assert.ok(/'sess:' \+ sha256HexReal_\(token\)/.test(SRC), '세션 캐시 키는 토큰 해시');
  assert.ok(/getLastRow\(\) >= 2\)\s*\{\s*throw new Error/.test(SRC), '계정이 있으면 새 페퍼를 만들지 않음');
  assert.ok(/tryLock\(3000\)/.test(SRC), '시도 예약 짧은 잠금');
});

// ═════════ 정적 검사 ═════════

test('Code.gs: HtmlService 는 관리자 화면(고정 문자열)에만, eval·new Function 없음', () => {
  const uses = SRC.split('\n').filter((l) => /HtmlService/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.ok(uses.length >= 1);
  for (const l of uses) assert.ok(/createHtmlOutput\((ADMIN_HTML|ADMIN_DENIED_HTML)\)/.test(l), '관리자 화면 외 HtmlService: ' + l.trim());
  assert.ok(!/\beval\s*\(/.test(SRC));
  assert.ok(!/new\s+Function\b/.test(SRC));
});

test('Code.gs: Logger/console 호출에 토큰 없음', () => {
  const lines = SRC.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    if (/\b(Logger\.log|console\.\w+|deps\.log)\s*\(/.test(l) && /token|idToken|req\b|body\b|html|password|pepper/i.test(l)) bad.push((i + 1) + ': ' + l.trim());
  });
  assert.deepStrictEqual(bad, []);
});

const LAB = fs.readFileSync(LAB_PATH, 'utf8');

test('lab/index.html: 브라우저 저장소·쿠키 사용 없음', () => {
  // 설명 주석(// ..., <!-- ... -->, /* ... */)에서 이름만 언급하는 것은 허용
  const code = LAB.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.ok(!/\blocalStorage\b/.test(code), 'localStorage');
  assert.ok(!/\bsessionStorage\b/.test(code), 'sessionStorage');
  assert.ok(!/document\s*\.\s*cookie/.test(code), 'document.cookie');
});

test('lab/index.html: 외부 스크립트는 GIS 하나뿐', () => {
  const srcs = [...LAB.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
  // 비밀번호 방식으로 바뀌며 GIS 를 뺄 수도 있음: 외부 스크립트는 없거나 GIS 하나
  assert.ok(srcs.length <= 1 && srcs.every((x) => x === 'https://accounts.google.com/gsi/client'), srcs.join(','));
});

test('lab/index.html: CONFIG 형식(자리표시자 또는 실제 값), 비밀 값 없음', () => {
  assert.ok(/GOOGLE_CLIENT_ID\s*:\s*'(YOUR_CLIENT_ID|\d+-[a-z0-9]+)\.apps\.googleusercontent\.com'/.test(LAB));
  assert.ok(/WEB_APP_URL\s*:\s*'https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec'/.test(LAB));
  assert.ok(!/GOCSPX-/.test(LAB), '클라이언트 보안 비밀번호가 들어가면 안 됨');
  assert.ok(!/GOCSPX-/.test(SRC));
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
