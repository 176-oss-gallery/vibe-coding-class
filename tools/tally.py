#!/usr/bin/env python3
"""좋아요 순위: 관리자 화면에서 내려받은 likes.csv 로 반별 순위를 낸다.

사용법:
  python tools/tally.py likes.csv [--top 5]

- likes.csv 는 관리자 화면의 [좋아요 내려받기 (CSV)] 파일입니다. 지금 눌려 있는 좋아요 하나가 한 줄(학번, 반, 번호).
- 학생은 마음에 드는 작품마다 좋아요를 누릅니다. 자기 작품은 서버가 막지만,
  만일을 위해 private/mapping.csv 가 있으면 자기 작품에 누른 좋아요를 한 번 더 걸러 냅니다.
- 결과는 화면에만 나옵니다(학번이 들어간 파일을 만들지 않습니다).
"""
import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def tally(votes_path, top=5, out=print):
    votes = C.read_csv(votes_path)
    mapping = {m['학번']: m for m in C.read_csv(C.MAPPING)}
    counts = defaultdict(Counter)
    voters = defaultdict(set)
    skipped = []  # (학번, 번호): 자기 작품에 준 표
    for v in votes:
        sid = (v.get('학번') or '').strip()
        pid = C.parse_id(sid)
        if not pid:
            continue
        try:
            n = int(str(v.get('번호', '')).strip())
        except ValueError:
            continue
        cls = pid[1]
        own = mapping.get(sid)
        if own and str(own.get('번호', '')).isdigit() and int(own['번호']) == n:
            skipped.append((sid, n))
            continue
        voters[cls].add(sid)
        counts[cls][n] += 1
    if not voters:
        out('좋아요가 없습니다.')
        return {}
    result = {}
    for cls in sorted(voters):
        ranked = sorted(counts[cls].items(), key=lambda kv: (-kv[1], kv[0]))
        result[cls] = ranked
        out(f'{cls}반 (누른 학생 {len(voters[cls])}명): ' + (', '.join(f'{n}번({c}개)' for n, c in ranked[:top]) or '-'))
    if skipped:
        out(f'\n자기 작품에 누른 좋아요 {len(skipped)}건은 뺐습니다: ' + ', '.join(f'{C.parse_id(s)[1]}반 {C.parse_id(s)[2]}번 학생({n}번)' for s, n in skipped[:20]) + (' ...' if len(skipped) > 20 else ''))
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('votes', help='관리자 화면에서 내려받은 likes.csv')
    ap.add_argument('--top', type=int, default=5, help='반마다 보여 줄 순위 수 (기본 5)')
    a = ap.parse_args(argv)
    if not Path(a.votes).exists():
        print('파일이 없습니다:', a.votes)
        return 1
    tally(a.votes, a.top)
    return 0


if __name__ == '__main__':
    sys.exit(main())
