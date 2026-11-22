#!/usr/bin/env python3
"""투표 집계: 관리자 화면에서 내려받은 votes.csv 와 private/mapping.csv 로, 자기 작품에 준 표를 빼고 반별 순위를 낸다.

사용법:
  python tools/tally.py votes.csv [--top 3]

- votes.csv 는 관리자 화면의 [투표 내려받기 (CSV)] 파일입니다 (학번, 반, 정확, 재미, 창의, 실용).
- 작품 번호는 갤러리에 보이는 번호(publish.py 가 정함)이고, 누가 그 작품을 만들었는지는
  private/mapping.csv 에만 있습니다. 투표한 학생의 작품 번호와 같은 번호에 준 표는 세지 않습니다.
- 결과는 화면에만 나옵니다(학번이 들어간 파일을 만들지 않습니다).
"""
import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

CATS = [('정확', '과학적으로 가장 정확한 작품'), ('재미', '가장 재미있는 작품'), ('창의', '가장 창의적인 작품'), ('실용', '가장 실용적인 작품')]


def tally(votes_path, top=3, out=print):
    votes = C.read_csv(votes_path)
    mapping = {m['학번']: m for m in C.read_csv(C.MAPPING)}
    counts = defaultdict(lambda: {c: Counter() for c, _ in CATS})
    voters = Counter()
    skipped = []  # (학번, 부문, 번호): 자기 작품에 준 표
    for v in votes:
        sid = (v.get('학번') or '').strip()
        pid = C.parse_id(sid)
        if not pid:
            continue
        cls = pid[1]
        voters[cls] += 1
        own = mapping.get(sid)
        own_n = int(own['번호']) if own and str(own.get('번호', '')).isdigit() else None
        for cat, _ in CATS:
            try:
                n = int(str(v.get(cat, '')).strip())
            except ValueError:
                continue
            if own_n is not None and n == own_n:
                skipped.append((sid, cat, n))
                continue
            counts[cls][cat][n] += 1
    if not voters:
        out('투표가 없습니다.')
        return {}
    result = {}
    for cls in sorted(voters):
        out(f'\n{cls}반 (투표 {voters[cls]}명)')
        result[cls] = {}
        for cat, label in CATS:
            ranked = sorted(counts[cls][cat].items(), key=lambda kv: (-kv[1], kv[0]))
            result[cls][cat] = ranked
            line = ', '.join(f'{n}번({c}표)' for n, c in ranked[:top]) or '-'
            out(f'  {label}: {line}')
    if skipped:
        out(f'\n자기 작품에 준 표 {len(skipped)}건은 뺐습니다: ' + ', '.join(f'{C.parse_id(s)[1]}반 {C.parse_id(s)[2]}번 학생({cat} {n}번)' for s, cat, n in skipped[:20]) + (' ...' if len(skipped) > 20 else ''))
    missing = sorted({(v.get('학번') or '').strip() for v in votes if (v.get('학번') or '').strip() not in mapping})
    if missing:
        out(f'\n주의: mapping.csv 에 없는 학번 {len(missing)}명은 자기 작품 표를 걸러내지 못했습니다(작품을 공개하지 않은 학생이면 정상).')
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('votes', help='관리자 화면에서 내려받은 votes.csv')
    ap.add_argument('--top', type=int, default=3, help='부문마다 보여 줄 순위 수 (기본 3)')
    a = ap.parse_args(argv)
    if not Path(a.votes).exists():
        print('파일이 없습니다:', a.votes)
        return 1
    tally(a.votes, a.top)
    return 0


if __name__ == '__main__':
    sys.exit(main())
