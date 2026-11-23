/* 갤러리 공통 스크립트. 작품 제목은 학생이 쓴 글이므로 항상 textContent 로만 넣는다. */
(function () {
  'use strict';
  var EMB = /[?&]embed=1\b/.test(location.search);
  if (EMB) document.documentElement.classList.add('embed');
  function L(u) { return EMB ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'embed=1' : u; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var qs = new URLSearchParams(location.search);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }
  function hue(i, total) { return total > 1 ? Math.round(i / (total - 1) * 270) : 0; } // 빨강 → 보라
  function intParam(name, lo, hi) {
    var v = parseInt(qs.get(name), 10);
    return v >= lo && v <= hi ? v : null;
  }
  function fail(box, title, text) {
    box.textContent = '';
    var m = el('div', 'msg');
    m.appendChild(el('b', null, title));
    m.appendChild(document.createTextNode(text));
    box.appendChild(m);
  }
  var LOAD_ERR = '주소(링크)로 접속했는지 확인하고, 그래도 안 되면 선생님께 알려 주세요.';

  /* ---- 좋아요: 학생 앱 안에 끼워졌을 때만. 누르면 앱(부모 창)에 알리고, 앱이 로그인 정보로 서버에 보낸다 ---- */
  var LIKE_ON = EMB && window.parent !== window;
  var LK = { ready: false, can: false, own: null, mine: {}, msg: '', btns: [] };
  function paintLikes() {
    LK.btns.forEach(function (b) {
      var n = Number(b.getAttribute('data-n')), on = !!LK.mine[n], own = LK.own === n;
      b.hidden = !LK.ready;
      b.disabled = !LK.can || own || b.getAttribute('data-busy') === '1';
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = own ? '내 작품' : (on ? '♥ 좋아요' : '♡ 좋아요');
      b.title = own ? '내 작품에는 좋아요를 누를 수 없어요' : (!LK.can ? LK.msg : (on ? '다시 누르면 취소돼요' : ''));
    });
  }
  function likeButton(n) {
    var b = el('button', 'like');
    b.type = 'button';
    b.setAttribute('data-n', String(n));
    b.hidden = true;
    b.onclick = function () {
      if (!LK.can || LK.own === n) return;
      b.setAttribute('data-busy', '1'); paintLikes();
      window.parent.postMessage({ type: 'vibe-like', n: n, on: !LK.mine[n] }, location.origin);
    };
    LK.btns.push(b);
    paintLikes();
    return b;
  }
  if (LIKE_ON) {
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent || e.origin !== location.origin) return;
      var d = e.data || {};
      if (d.type !== 'vibe-likes') return;
      LK.ready = true; LK.can = !!d.can; LK.own = typeof d.own === 'number' ? d.own : null; LK.msg = String(d.msg || '');
      LK.mine = {};
      (Array.isArray(d.liked) ? d.liked : []).forEach(function (n) { LK.mine[Number(n)] = true; });
      LK.btns.forEach(function (b) { b.removeAttribute('data-busy'); });
      paintLikes();
    });
    window.parent.postMessage({ type: 'vibe-likes-hello' }, location.origin);
  }

  /* ---- 반 선택 ---- */
  function pageIndex() {
    var box = $('#classes');
    getJSON('../data/index.json').then(function (d) {
      box.textContent = '';
      d.classes.forEach(function (x, i) {
        var has = x.count > 0;
        var t = el(has ? 'a' : 'div', 'tile' + (has ? '' : ' empty'));
        t.style.setProperty('--h', hue(i, d.classes.length));
        if (has) t.href = L('class.html?c=' + x.c);
        var no = el('span', 'no', String(x.c));
        no.appendChild(el('small', null, '반'));
        t.appendChild(no);
        t.appendChild(el('span', 'meta', has ? '작품 ' + x.count + '개' : '아직 없어요'));
        var li = el('li');
        li.appendChild(t);
        box.appendChild(li);
      });
      if (d.updated) $('#updated').textContent = '목록 갱신: ' + d.updated;
    }).catch(function () { fail(box, '목록을 불러오지 못했어요.', LOAD_ERR); });
  }

  /* ---- 반별 작품 ---- */
  function pageClass() {
    var c = intParam('c', 1, 16), box = $('#games');
    if (!c) { fail(box, '반을 찾을 수 없어요.', ''); return; }
    document.title = c + '반 작품 · 과학 게임 갤러리';
    $('#cname').textContent = c + '반 작품';
    getJSON('../data/class' + pad(c) + '.json').then(function (d) {
      var g = d.games || [], tiles = [];
      $('#count').textContent = g.length ? '작품 ' + g.length + '개가 있어요.' : '';
      if (LIKE_ON && $('#hint')) $('#hint').textContent = '해 보고 마음에 드는 작품마다 ♡ 좋아요를 눌러요. 여러 개 눌러도 돼요.';
      box.textContent = '';
      if (!g.length) {
        $('#find').hidden = true;
        var m = el('div', 'msg');
        m.appendChild(el('b', null, '아직 올라온 작품이 없어요.'));
        m.appendChild(document.createTextNode('선생님이 점검을 마치면 이곳에 나타나요.'));
        box.replaceWith(m);
        return;
      }
      var IMG_OK = /^thumbs\/\d\d\/[a-z0-9]{5}\.jpg$/;
      g.forEach(function (x, i) {
        var li = el('li'), a = el('a', 'card'), shot = el('span', 'shot');
        a.href = L('play.html?c=' + c + '&n=' + x.n);
        a.style.setProperty('--h', hue(i, g.length));
        a.setAttribute('aria-label', x.n + '번 ' + x.title);
        if (x.img && IMG_OK.test(x.img)) {
          var im = document.createElement('img');
          im.src = '../' + x.img; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async';
          im.width = 400; im.height = 300;
          im.onerror = function () { im.remove(); shot.classList.add('noimg'); shot.appendChild(el('span', 'ph', x.title)); };
          shot.appendChild(im);
        } else {
          shot.classList.add('noimg');
          shot.appendChild(el('span', 'ph', x.title));
        }
        shot.appendChild(el('span', 'badge', String(x.n)));
        a.appendChild(shot);
        var cap = el('span', 'cap');
        cap.appendChild(el('span', 'ttl', x.title));
        if (x.desc) cap.appendChild(el('span', 'desc', x.desc));
        a.appendChild(cap);
        li.appendChild(a);
        if (LIKE_ON) li.appendChild(likeButton(x.n));
        box.appendChild(li);
        tiles.push({ li: li, n: String(x.n) });
      });
      $('#num').addEventListener('input', function () {
        var v = this.value.trim();
        tiles.forEach(function (t) { t.li.hidden = v !== '' && t.n.indexOf(v) !== 0; });
      });
    }).catch(function () { fail(box, '작품 목록을 불러오지 못했어요.', LOAD_ERR); });
    $('#back').href = L('./');
  }

  /* ---- 플레이 ---- */
  function pagePlay() {
    var c = intParam('c', 1, 16), n = intParam('n', 1, 999), stage = $('#stage');
    if (!c || !n) { fail(stage, '작품을 찾을 수 없어요.', ''); return; }
    var back = L('class.html?c=' + c);
    $('#back').href = back;
    $('#back').textContent = '← ' + c + '반 목록';
    getJSON('../data/class' + pad(c) + '.json').then(function (d) {
      var g = d.games || [], i = g.findIndex(function (x) { return x.n === n; });
      if (i < 0 || !/^[a-z0-9]{5,10}$/.test(g[i].code)) throw new Error('none');
      var game = g[i];
      document.title = n + '번 ' + game.title + ' · 과학 게임 갤러리';
      $('#pno').textContent = String(n);
      $('#ptitle').textContent = game.title;
      if (LIKE_ON) $('.name').insertAdjacentElement('afterend', likeButton(n));
      var src = '../games/' + pad(c) + '/' + game.code + '.html';
      var f = el('iframe');
      f.title = game.title;
      // 게임은 갤러리와 분리된 상자(sandbox) 안에서 실행: 다른 작품·앱의 저장 데이터를 읽을 수 없다
      f.setAttribute('sandbox', 'allow-scripts allow-modals allow-pointer-lock');
      f.setAttribute('referrerpolicy', 'no-referrer');
      // 인터넷 요청 차단(CSP)은 publish.py 가 게임 파일 맨 앞에 넣는다 (GitHub Pages 는 서버 헤더를 설정할 수 없으므로)
      f.src = src;
      stage.textContent = '';
      stage.appendChild(f);
      $('#reload').onclick = function () { f.src = src; };
      $('#full').onclick = function () { (f.requestFullscreen || f.webkitRequestFullscreen || function () {}).call(f); };
      function nav(btn, x) {
        if (x) { btn.href = L('play.html?c=' + c + '&n=' + x.n); btn.setAttribute('aria-label', x.n + '번'); }
        else btn.setAttribute('aria-disabled', 'true');
      }
      nav($('#prev'), g[i - 1]);
      nav($('#next'), g[i + 1]);
    }).catch(function () { fail(stage, '작품을 불러오지 못했어요.', '목록으로 돌아가 다시 골라 보세요.'); });
  }

  var page = document.body.getAttribute('data-page');
  if (page === 'index') pageIndex();
  else if (page === 'class') pageClass();
  else if (page === 'play') pagePlay();
})();
