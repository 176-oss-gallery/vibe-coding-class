"""학생용 앱 자동 테스트. 실행: pip install playwright && playwright install chromium && python tests/test_app.py
제출 서버(구글 앱스크립트)는 진짜로 부르지 않고 이 파일 안의 가짜 서버로 바꿔서 시험한다."""
import functools, http.server, json, pathlib, sys, tempfile, threading, urllib.parse as up
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = tempfile.mkdtemp(prefix='vibe_test_') + '/'
res = []


def ok(name, cond, extra=''):
    res.append((name, bool(cond), extra)); print(('PASS' if cond else 'FAIL'), name, extra)


def iso():
    return datetime.now(timezone.utc).isoformat()


class Fake:
    """앱스크립트 서버 흉내: 등록·로그인·글·투표·제출·현황"""
    def __init__(s):
        s.accounts, s.notes, s.votes, s.subs, s.calls = {}, [], [], [], []
        s.fail_submit, s.expire, s.vote_open = None, False, True

    def handle(s, body):
        a = body.get('action'); s.calls.append(body)
        o = lambda **k: dict(ok=True, **k)
        bad = lambda code, msg: dict(ok=False, code=code, message=msg)
        if a == 'register':
            sid = body['studentId']
            if sid in s.accounts: return bad('ALREADY_REGISTERED', '이미 등록한 학번이에요.')
            s.accounts[sid] = (body['name'], body['password']); return o(studentId=sid)
        if a == 'login':
            acc = s.accounts.get(body['studentId'])
            if not acc: return bad('NOT_REGISTERED', '아직 등록하지 않은 학번이에요. 먼저 등록해 주세요.')
            if acc[1] != body['password']: return bad('WRONG_PASSWORD', '비밀번호가 맞지 않아요.')
            return o(studentId=body['studentId'], name=acc[0], mustChange=False, session='S' + body['studentId'] + 'x' * 20)
        sess = body.get('session') or ''
        if s.expire or not sess.startswith('S'): return bad('SESSION_EXPIRED', '로그인이 만료되었어요.')
        sid = sess[1:6]
        if a == 'note': s.notes.append((sid, body['section'], body['text'])); return o(section=body['section'], savedAt=iso(), length=len(body['text']))
        if a == 'vote':
            if not s.vote_open: return bad('VOTE_CLOSED', '투표가 닫혔어요. 선생님께 물어보세요.')
            s.votes.append((sid, body['votes'])); return o(savedAt=iso(), votes=body['votes'])
        if a == 'submit':
            if s.fail_submit: return bad(*s.fail_submit)
            s.subs.append((sid, body['html'], body['requestId']))
            return o(studentId=sid, version=len([x for x in s.subs if x[0] == sid]), size=len(body['html']), sha256='x', submittedAt=iso())
        if a == 'status':
            notes = {sec: iso() for (i, sec, t) in s.notes if i == sid}
            vote = next(({'at': iso(), 'votes': v} for (i, v) in reversed(s.votes) if i == sid), None)
            return o(notes=notes, vote=vote, voteOpen=s.vote_open, sessionOpen=True)
        return bad('BAD_REQUEST', '요청 형식이 올바르지 않아요.')


fake = Fake()
CORS = {'access-control-allow-origin': '*'}


def server_route(route):
    body = json.loads(route.request.post_data or '{}')
    route.fulfill(status=200, headers=CORS, content_type='application/json', body=json.dumps(fake.handle(body)))


GAL = {'class': 3, 'games': [{'n': n, 'title': 't%d' % n, 'desc': '', 'code': 'c%d' % n, 'size': 1} for n in range(1, 6)]}


def gal_route(route):
    route.fulfill(status=200, content_type='application/json', body=json.dumps(GAL))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'site')))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:%d/index.html' % srv.server_address[1]


def is_on(pg, sel): return pg.eval_on_selector(sel, 'e=>e.classList.contains("on")')


def auth(pg, sid, pw, name=None):
    """로그인 창에서 로그인(name 이 있으면 처음 등록)"""
    if not is_on(pg, '#aov'): pg.click('#loginbtn')
    if name:
        pg.click('#amreg'); pg.fill('#aname', name); pg.fill('#apw2', pw)
    else:
        pg.click('#amlogin')
    pg.fill('#aid', sid); pg.fill('#apw', pw); pg.click('#aok')


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'], accept_downloads=True)
    ctx.route('https://script.google.com/**', server_route)
    ctx.route('**/data/class03.json', gal_route)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(URL)
    pg.wait_for_selector('#aov.on')
    ok('처음 열면 로그인 창부터', is_on(pg, '#aov'))
    ok('초기: 1차시 본문 잠김', pg.eval_on_selector('#t1body', 'e=>e.classList.contains("lock")'))
    ok('초기: 칩 서약 전', pg.inner_text('#pchip') == '서약 전')
    ok('학번·이름 칸은 직접 못 고침', pg.get_attribute('#sid', 'readonly') is not None and pg.get_attribute('#sname', 'readonly') is not None)
    pg.screenshot(path=OUT + 'login.png')
    # 로그인 입력 검사와 서버 오류 표시
    pg.fill('#aid', '999'); pg.fill('#apw', 'x'); pg.click('#aok'); ok('잘못된 학번 안내', '5자리' in pg.inner_text('#aerr'))
    pg.fill('#aid', '20315'); pg.fill('#apw', ''); pg.click('#aok'); ok('비밀번호 비면 안내', '비밀번호' in pg.inner_text('#aerr'))
    pg.fill('#apw', 'blue-River-47x'); pg.click('#aok'); pg.wait_for_function('document.getElementById("aerr").innerText.includes("등록")')
    ok('등록 안 한 학번: 서버 안내 표시', '먼저 등록' in pg.inner_text('#aerr'), pg.inner_text('#aerr'))
    pg.click('#amreg'); pg.fill('#aname', '김하늘'); pg.fill('#apw2', 'different'); pg.click('#aok'); ok('비밀번호 두 칸 다르면 막힘', '서로 달라요' in pg.inner_text('#aerr'))
    pg.fill('#apw2', 'blue-River-47x'); pg.click('#aok'); pg.wait_for_selector('#aov:not(.on)', state='attached')
    ok('등록하면 바로 로그인', pg.input_value('#sid') == '20315' and pg.input_value('#sname') == '김하늘')
    ok('학번 해석', '2학년 3반 15번' in pg.inner_text('#idinfo'), pg.inner_text('#idinfo'))
    ok('로그인 버튼 숨김·로그아웃 보임', pg.is_hidden('#loginbtn') and pg.is_visible('#logoutbtn'))
    pg.wait_for_function('document.getElementById("ns_t1").innerText.includes("아직")')
    ok('로그인 뒤 제출 현황 표시', '아직 제출하지 않았어요' in pg.inner_text('#ns_t1'))
    ok('로그인만으로는 서약 전', pg.inner_text('#pchip') == '서약 전')
    # 서약 서명
    pg.click('#signbtn'); ok('팝업 열림', is_on(pg, '#pov'))
    pg.screenshot(path=OUT + 'modal.png')
    pg.click('#pok'); ok('체크 안 하면 막힘', '①' in pg.inner_text('#perr'))
    pg.eval_on_selector_all('#pl input', 'es=>es.forEach(e=>e.click())')
    pg.click('#pok'); ok('이름 미입력 막힘', '②' in pg.inner_text('#perr'))
    pg.fill('#pname', '김하날'); pg.click('#pok'); ok('이름 불일치 막힘', '②' in pg.inner_text('#perr'))
    pg.fill('#pname', '김하늘'); pg.click('#pok'); ok('서명 없으면 막힘', '③' in pg.inner_text('#perr'))
    bb = pg.locator('#sigc').bounding_box()
    pg.mouse.move(bb['x'] + 40, bb['y'] + 100); pg.mouse.down()
    for i in range(30): pg.mouse.move(bb['x'] + 40 + i * 15, bb['y'] + 100 + (40 if i % 2 else -40))
    pg.mouse.up()
    pg.screenshot(path=OUT + 'modal_signed.png')
    pg.click('#pok')
    ok('서명 후 팝업 닫힘', not is_on(pg, '#pov'))
    ok('칩 서약 완료', pg.inner_text('#pchip') == '서약 완료')
    ok('본문 잠금 해제', not pg.eval_on_selector('#t1body', 'e=>e.classList.contains("lock")'))
    raw = pg.evaluate('localStorage.getItem("vibe_class_v2")'); st = json.loads(raw)
    ok('서명 이미지는 저장 안 함', 'sign' not in st['f'] and 'data:image' not in raw)
    ok('비밀번호·세션은 브라우저에 저장 안 함', 'blue-River' not in raw and 'S20315x' not in raw and 'session' not in raw and not pg.evaluate('sessionStorage.length'))
    # 로그아웃하면 다시 잠김, 같은 학생이 다시 로그인하면 서약 유지
    pg.click('#logoutbtn')
    ok('로그아웃: 칩 서약 전·본문 잠김', pg.inner_text('#pchip') == '서약 전' and pg.eval_on_selector('#t1body', 'e=>e.classList.contains("lock")'))
    ok('로그아웃 상태: 1차시 본문 버튼 못 누름', pg.eval_on_selector('#t1body', 'e=>getComputedStyle(e).pointerEvents') == 'none')
    n_before = len(fake.notes); pg.evaluate("submitNote('t1','1차시 기획')"); pg.wait_for_selector('#aov.on')
    ok('로그아웃 상태에서 제출을 시도하면 로그인 창', is_on(pg, '#aov') and len(fake.notes) == n_before)
    pg.fill('#apw', 'wrong-pw'); pg.click('#aok'); pg.wait_for_function('document.getElementById("aerr").innerText.includes("맞지")')
    ok('비밀번호 틀리면 서버 안내', '맞지 않아요' in pg.inner_text('#aerr'))
    auth(pg, '20315', 'blue-River-47x'); pg.wait_for_selector('#aov:not(.on)', state='attached')
    ok('다시 로그인하면 서약 유지', pg.inner_text('#pchip') == '서약 완료')
    # 아이디어 상담 (1차시)
    pg.fill('#i1', '원소와 주기율표'); pg.click('text=상담 프롬프트 만들기')
    ip = pg.input_value('#ideap'); ok('상담 프롬프트: 주제·코드 금지·안전 규칙', '원소와 주기율표' in ip and '코드는 만들지 말고' in ip and '[안전 규칙]' in ip)
    # 기획서 (1차시) → 프롬프트 (2차시)
    pg.click('#nav button[data-t=t2]')
    ok('기획서 비었을 때 안내', '1차시 기획서를 채우세요' in pg.inner_text('#planview'))
    pg.click('text=프롬프트로 합치기'); ok('기획서 없으면 합치기 막힘', pg.input_value('#prompt1') == '')
    pg.click('#nav button[data-t=t1]')
    pg.fill('[data-k=title]', '원소 짝꿍 찾기'); pg.select_option('[data-k=kind]', '과학 개념 게임')
    pg.fill('[data-k=concept]', '원소 기호'); pg.fill('[data-k=user]', '우리 반 친구들')
    pg.fill('[data-k=feat1]', '카드 짝 맞추기'); pg.fill('[data-k=feat2]', '점수'); pg.fill('[data-k=sketch]', '파란색, 큰 카드')
    pg.click('#nav button[data-t=t2]')
    pv = pg.inner_text('#planview'); ok('기획서 내용이 2차시에 표시', '원소 짝꿍 찾기' in pv and '카드 짝 맞추기' in pv and '비어 있어요' not in pv)
    pg.fill('#f1', '웹 개발자'); pg.fill('#f6', '난이도 선택'); pg.click('text=프롬프트로 합치기')
    v = pg.input_value('#prompt1')
    ok('프롬프트에 기획서·추가 요구사항·안전 규칙', all(x in v for x in ['너는 웹 개발자야', '원소 짝꿍 찾기', '우리 반 친구들', '1) 카드 짝 맞추기', '원소 기호', '파란색, 큰 카드', '난이도 선택', '[Gemini Canvas용 개발 지침]', '순수 JavaScript', '첫 화면에 게임 제목과 시작 버튼', '[안전 규칙]']), v)
    pg.screenshot(path=OUT + 't2_prompt.png', full_page=True)
    pg.fill('#prompt1', '내 마음대로'); pg.click('#t2 >> text=📋 복사')
    ok('복사 시 개발 지침·안전 규칙 자동 복원', '[안전 규칙]' in pg.input_value('#prompt1') and '[Gemini Canvas용 개발 지침]' in pg.input_value('#prompt1'))
    pv2 = pg.input_value('#prompt1'); ok('복원해도 중복 없음', pv2.count('[안전 규칙]') == 1 and pv2.count('[Gemini Canvas용 개발 지침]') == 1)
    pg.click('#nav button[data-t=t1]')
    # 요약 복사(백업) / 1차시 제출
    pg.fill('[data-k=title]', '원소 퀴즈'); pg.click("#t1 button:has-text('요약 복사')")
    pg.wait_for_timeout(300)
    clip = pg.evaluate('navigator.clipboard.readText()')
    ok('요약 복사 내용', '[1차시 기획] 20315 김하늘 (2학년 3반 15번)' in clip and '서약서:' in clip and '원소 퀴즈' in clip and '불편할 사람 점검' in clip, clip[:80].replace('\n', ' | '))
    pg.click('#nb_t1'); pg.wait_for_function('document.getElementById("ns_t1").innerText.includes("제출했어요")')
    n1 = [n for n in fake.notes if n[1] == 't1']
    ok('1차시 제출: 서버로 글 전달', len(n1) == 1 and n1[0][0] == '20315' and '서명 완료' in n1[0][2] and '원소 퀴즈' in n1[0][2], n1[0][2][:60] if n1 else '')
    ok('제출 요청에 학번·비밀번호 없이 세션만', all('password' not in c and 'studentId' not in c for c in fake.calls if c['action'] in ('note', 'vote', 'submit', 'status')))
    # 2~3차시
    pg.click('#nav button[data-t=t2]')
    ok('2~3차시: 서명 배너 숨김', not pg.is_visible('#t2 .signbanner'))
    pg.screenshot(path=OUT + 't2_top.png', full_page=False)
    bad = '<!DOCTYPE html><html><head><title>t</title><script src="https://cdn.x.com/a.js"></script></head><body>김하늘 20315 <script>fetch("http://evil.com/x");eval("1")</script></body></html>'
    pg.fill('#gcode', bad)
    ok('게임 이름 없으면 제출·내려받기 막힘', pg.is_disabled('#gdl') and pg.is_disabled('#gsub') and '게임 이름' in pg.inner_text('#gwarn'))
    pg.fill('#gtitle', '김하늘 게임'); ok('이름에 내 이름 있으면 막힘', pg.is_disabled('#gdl') and pg.is_disabled('#gsub'))
    pg.fill('#gtitle', '원소 짝꿍'); pg.fill('#gdesc', '원소 카드를 짝지어요')
    w = pg.inner_text('#gwarn'); ok('점검: 외부주소/외부파일/API/이름 경고', '외부 주소' in w and '외부 파일' in w and 'fetch' in w and '학번이나 이름' in w, w[:100].replace('\n', ' | '))
    ok('경고 있어도 제출은 가능(교사가 최종 판단)', not pg.is_disabled('#gdl') and not pg.is_disabled('#gsub'))
    pg.fill('#gcode', '<p>조각 코드</p>'); ok('전체 코드 아님 경고', '전체가 아닌' in pg.inner_text('#gwarn'))
    big = '<!DOCTYPE html><html><head><title>t</title></head><body>' + ('가' * 400000) + '</body></html>'
    pg.fill('#gcode', big)
    ok('1MB 초과: 제출·내려받기 비활성', pg.is_disabled('#gdl') and pg.is_disabled('#gsub'), pg.inner_text('#barlbl'))
    ok('1MB 초과: 막대 빨강', pg.eval_on_selector('#barfill', 'e=>e.className') == 'r')
    mid = '<!DOCTYPE html><html><head><title>t</title></head><body>' + ('a' * 600000) + '</body></html>'
    pg.fill('#gcode', mid); ok('600KB: 노랑', pg.eval_on_selector('#barfill', 'e=>e.className') == 'y', pg.inner_text('#barlbl'))
    good = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>원소 퀴즈</title></head><body><h1>퀴즈</h1><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>'
    pg.fill('#gcode', good); ok('정상 코드: 통과 메시지', '문제를 찾지 못했어요' in pg.inner_text('#gwarn'), pg.inner_text('#gwarn')); ok('막대 초록', pg.eval_on_selector('#barfill', 'e=>e.className') == '')
    pg.screenshot(path=OUT + 't2_export.png', full_page=True)
    with pg.expect_download() as d: pg.click('#gdl')
    dd = d.value; path = OUT + dd.suggested_filename; dd.save_as(path); txt = open(path, encoding='utf-8').read()
    ok('다운로드 파일 이름', '20315_김하늘.html' == dd.suggested_filename, dd.suggested_filename)
    ok('첫 줄 제출 표식 + 게임 정보', txt.startswith('<!-- vibe-submit:20315|김하늘 -->\n<!-- vibe-info:') and '\n<!DOCTYPE html>' in txt[:300], txt[:120])
    info = json.loads(up.unquote(txt.split('vibe-info:')[1].split(' -->')[0])); ok('게임 정보 내용', info == {'t': '원소 짝꿍', 'd': '원소 카드를 짝지어요'}, str(info))
    pg.fill('#gcode', txt)
    with pg.expect_download() as d2: pg.click('#gdl')
    t2 = d2.value; t2.save_as(OUT + 're.html'); r = open(OUT + 're.html', encoding='utf-8').read()
    ok('표식 중복 없음', r.count('vibe-submit') == 1 and r.count('vibe-info') == 1)
    # 게임 제출
    pg.click('#gsub'); pg.wait_for_function('document.getElementById("gstate").innerText.includes("제출했어요")')
    ok('게임 제출: 1번째 제출 표시', '1번째 제출' in pg.inner_text('#gstate'), pg.inner_text('#gstate'))
    sub = fake.subs[-1]
    ok('게임 제출: 표식·게임 정보·본문 전달', sub[0] == '20315' and sub[1].startswith('<!-- vibe-submit:20315|김하늘 -->\n<!-- vibe-info:') and '<h1>퀴즈</h1>' in sub[1] and len(sub[2]) >= 16, sub[1][:60])
    pg.click('#gsub'); pg.wait_for_function('document.getElementById("gstate").innerText.includes("2번째")')
    ok('다시 제출: 새 요청 번호', fake.subs[-1][2] != fake.subs[-2][2] and len(fake.subs) == 2)
    fake.fail_submit = ('SESSION_CLOSED', '지금은 제출 시간이 아니에요.')
    pg.click('#gsub'); pg.wait_for_function('document.getElementById("gstate").innerText.includes("❌")')
    ok('서버가 거절하면 이유를 보여 줌', '제출 시간이 아니에요' in pg.inner_text('#gstate'), pg.inner_text('#gstate'))
    ok('실패 뒤 제출 버튼 다시 켜짐', not pg.is_disabled('#gsub'))
    fake.fail_submit = None
    # 2~3차시 기록 제출
    pg.click('#nb_t2'); pg.wait_for_function('document.getElementById("ns_t2").innerText.includes("제출했어요")')
    t2n = [n for n in fake.notes if n[1] == 't2'][0][2]
    ok('2~3차시 기록 제출: 표 포함', '제작 일지' in t2n and '피드백 카드' in t2n and '불편했던 부분' in t2n)
    # 4차시
    pg.click('#nav button[data-t=t3]'); ok('4차시 탭에 갤러리 iframe', pg.locator('#galframe').count() == 1)
    ok('구글 폼 링크 없음', pg.locator('a[href*="forms.gle"]').count() == 0 and pg.locator('[data-link]').count() == 0)
    pg.click('#vbtn'); ok('투표: 빈 칸 막힘', '모두' in pg.inner_text('#vstate'))
    for k, n in (('sci', 1), ('fun', 2), ('creative', 3), ('practical', 50)): pg.fill('#v_' + k, str(n))
    pg.click('#vbtn'); pg.wait_for_function('document.getElementById("vstate").innerText.includes("없는 번호")')
    ok('투표: 우리 반 갤러리에 없는 번호 막힘', '50' in pg.inner_text('#vstate') and not fake.votes, pg.inner_text('#vstate'))
    pg.fill('#v_practical', '4'); pg.click('#vbtn'); pg.wait_for_function('document.getElementById("vstate").innerText.includes("투표했어요")')
    ok('투표 전달: 네 부문 번호, 반·학번은 보내지 않음', fake.votes and fake.votes[-1][1] == {'sci': 1, 'fun': 2, 'creative': 3, 'practical': 4}
       and all('cls' not in c and 'studentId' not in c for c in fake.calls if c['action'] == 'vote'))
    fake.vote_open = False
    pg.click('#vbtn'); pg.wait_for_function('document.getElementById("vstate").innerText.includes("❌")')
    ok('투표가 닫히면 이유 표시', '닫혔어요' in pg.inner_text('#vstate'), pg.inner_text('#vstate'))
    fake.vote_open = True
    pg.click('#nb_t3'); pg.wait_for_function('document.getElementById("ns_t3").innerText.includes("제출했어요")')
    ok('4차시 소감 제출', any(n[1] == 't3' for n in fake.notes))
    pg.screenshot(path=OUT + 't3.png', full_page=True)
    # 로그인 시간이 지난 경우
    fake.expire = True
    pg.click('#nb_t3'); pg.wait_for_selector('#aov.on')
    ok('로그인 만료: 다시 로그인 창과 안내', '다시 로그인' in pg.inner_text('#aerr') and pg.inner_text('#pchip') == '서약 전', pg.inner_text('#aerr'))
    fake.expire = False
    auth(pg, '20315', 'blue-River-47x'); pg.wait_for_selector('#aov:not(.on)', state='attached')
    # 백업
    with pg.expect_download() as d3: pg.click('.bk >> text=백업 저장')
    bj = json.load(open(d3.value.path(), encoding='utf-8')); ok('백업 JSON', bj['v'] == 2 and bj['f']['sid'] == '20315' and 'sign' not in bj['f'] and 'pw' not in json.dumps(bj))
    # 새로고침: 기록은 남고 로그인은 다시 해야 함, 현황 복원
    pg.reload(); pg.wait_for_selector('#aov.on')
    ok('새로고침 후 학번은 남고 로그인은 다시', pg.input_value('#sid') == '20315' and pg.is_visible('#loginbtn'))
    ok('새로고침 후 로그인 창에 학번 채워짐', pg.input_value('#aid') == '20315')
    auth(pg, '20315', 'blue-River-47x'); pg.wait_for_selector('#aov:not(.on)', state='attached')
    ok('새로고침 후 서약 유지', pg.inner_text('#pchip') == '서약 완료')
    pg.wait_for_function('document.getElementById("ns_t1").innerText.includes("제출함")')
    ok('다시 로그인하면 제출 현황 복원', '제출함' in pg.inner_text('#ns_t1'))
    pg.click('#nav button[data-t=t3]'); pg.wait_for_function('document.getElementById("v_sci").value!==""')
    ok('투표 현황 복원', pg.input_value('#v_practical') == '4')
    # 같은 컴퓨터에서 다른 학생이 로그인
    fake.accounts['10107'] = ('이서준', 'green-Forest-9q')
    msgs = []
    pg.once('dialog', lambda dlg: (msgs.append(dlg.message), dlg.dismiss()))
    pg.click('#logoutbtn'); auth(pg, '10107', 'green-Forest-9q'); pg.wait_for_timeout(500)
    ok('다른 학생 기록이 남아 있으면 물어봄(취소하면 로그인 안 됨)', msgs and '20315' in msgs[0] and is_on(pg, '#aov') and pg.is_visible('#loginbtn'), str(msgs))
    pg.once('dialog', lambda dlg: dlg.accept())
    pg.click('#aok'); pg.wait_for_selector('#aov:not(.on)', state='attached')
    ok('확인하면 이전 학생 기록 비우고 새 학생으로', pg.input_value('#sid') == '10107' and pg.input_value('[data-k=title]') == '' and pg.inner_text('#pchip') == '서약 전')
    errs = [e for e in errs if 'Failed to load resource' not in e]
    # 모바일 로그인 창
    ctx2 = b.new_context(viewport={'width': 390, 'height': 780}, has_touch=True, is_mobile=True)
    ctx2.route('https://script.google.com/**', server_route)
    m = ctx2.new_page(); m.goto(URL); m.wait_for_selector('#aov.on'); m.screenshot(path=OUT + 'login_mobile.png')
    ok('모바일: 로그인 창이 화면 안에', m.eval_on_selector('#aov .pm', 'e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}'))
    ok('JS 오류 없음', not errs, str(errs))
    b.close()
print('\nFAILED:', [r[0] for r in res if not r[1]])
sys.exit(1 if any(not r[1] for r in res) else 0)
