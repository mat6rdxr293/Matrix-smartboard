"""Разметка «параграф ↔ страницы» по распознанному тексту учебника.

    python scripts/sections.py                        # все data/raw/*.jsonl → data/sections/*.json
    python scripts/sections.py data/raw/physics_11_fizika_emn_kk_11_part1.jsonl --show

Ищет заголовки параграфов «§ 12. Название» в тексте страниц. Tesseract часто читает «§» как
«$», «8», «5», «&» или «S» («812.» вместо «§12.»), поэтому номер проверяется по порядку:
параграфы идут подряд, а номера упражнений («5. Найдите…») в эту последовательность не попадают.
Поддерживаются сдвоенные параграфы «§1-2» (учебник истории).

Выход: [{num: "12", title, page_start, page_end}], page_end — страница перед следующим параграфом.
Оглавление в конце книги не используется: номера страниц в нём после OCR ненадёжны.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# «§12. Название», «$ 9. НАЗВАНИЕ», «812. Название» (§→8), «51-2. Название» (§1-2), «& Т.Дискретные…»
HEAD = re.compile(
    r"^[\s*\\#|]*(?P<sym>§|\$|&|S)?\s?(?P<num>\d{1,4})(?:\s?-\s?(?P<num2>\d{1,2}))?\s?[.,]\s*"
    r"(?P<title>[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ].{6,})$"
)
MAX_GAP = 3  # насколько номер может «перепрыгнуть» (пропущенный OCR-ом заголовок)


def candidates(m):
    """Возможные номера параграфа: как есть (если есть символ «§»), либо без 1–2 первых цифр,
    если это искажённый «§» («812.» → 12, «8513-14» → 13)."""
    d = m["num"]
    if m["sym"]:
        return [int(d)]
    return [int(d[k:]) for k in (1, 2) if len(d) > k and all(c in "85" for c in d[:k])]


# номера рисунков и формул несут номер параграфа: «14.2-сурет», «рис. 14.2», «(14.3)»
FIG = re.compile(r"(?<![\d.,])(\d{1,2})\.\d{1,2}\s?[-–]?\s?(?:сурет|рис)|\((\d{1,2})\.\d{1,2}\)", re.I)


def page_prefixes(text):
    return {int(a or b) for a, b in FIG.findall(text)}


def fill_missing(found, pages, contents_titles):
    """Пропущенные OCR-ом заголовки восстанавливаем по первой странице с рисунком/формулой «n.k»."""
    by_page = {p["page"]: page_prefixes(p["text"]) for p in pages}
    have = {int(s["num"].split("-")[0]) for s in found}
    for n in sorted(set(range(1, max(have, default=0) + 1)) - have):
        prev = max((s for s in found if int(s["num"].split("-")[0]) < n), key=lambda s: s["page_start"], default=None)
        nxt = min((s for s in found if int(s["num"].split("-")[0]) > n), key=lambda s: s["page_start"], default=None)
        lo = prev["page_start"] + 1 if prev else 1
        hi = nxt["page_start"] - 1 if nxt else pages[-1]["page"]
        start = next((pg for pg in range(lo, hi + 1) if n in by_page.get(pg, ())), None)
        if start:
            found.append({"num": str(n), "title": contents_titles.get(n, ""), "page_start": start,
                          "source": "figures"})
    found.sort(key=lambda s: s["page_start"])
    return found


def find_sections(pages):
    found, last, contents = [], 0, {}
    for p in pages:
        lines = [l.strip() for l in p["text"].splitlines() if l.strip()]
        hits = [HEAD.match(l) for l in lines]
        hits = [h for h in hits if h]
        if sum(1 for h in hits if candidates(h)) >= 4:  # страница оглавления: много «§» подряд
            for h in hits:
                for n in candidates(h):
                    contents.setdefault(n, re.sub(r"[\s.…]*\.{2,}.*$", "", h["title"]).strip(" .,"))
            continue
        for h in hits:
            for n in candidates(h):
                if last < n <= last + MAX_GAP:
                    n2 = h["num2"]
                    num = f"{n}-{n2}" if n2 and int(n2) > n else str(n)
                    title = re.sub(r"\s*\.{2,}.*$", "", h["title"]).strip(" .,")
                    found.append({"num": num, "title": title, "page_start": p["page"], "source": "heading"})
                    last = int(n2) if n2 and int(n2) > n else n
                    break
    found = fill_missing(found, pages, contents)
    for cur, nxt in zip(found, found[1:] + [None]):
        cur["page_end"] = (nxt["page_start"] - 1) if nxt else pages[-1]["page"]
        cur["page_end"] = max(cur["page_end"], cur["page_start"])
    return found


def missing(sections):
    nums = []
    for s in sections:
        a, _, b = s["num"].partition("-")
        nums += list(range(int(a), int(b or a) + 1))
    return sorted(set(range(1, max(nums) + 1)) - set(nums)) if nums else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="data/raw/*.jsonl (по умолчанию все)")
    ap.add_argument("--show", action="store_true", help="печатать найденные параграфы")
    args = ap.parse_args()

    files = [Path(f) for f in args.files] or sorted((ROOT / "data" / "raw").glob("*.jsonl"))
    out_dir = ROOT / "data" / "sections"
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in files:
        pages = [json.loads(l) for l in f.open(encoding="utf-8")]
        secs = find_sections(pages)
        (out_dir / f"{f.stem}.json").write_text(json.dumps(secs, ensure_ascii=False, indent=1), encoding="utf-8")
        miss = missing(secs)
        print(f"{f.stem}: найдено {len(secs)} параграфов, пропущены номера: {miss or 'нет'}")
        if args.show:
            for s in secs:
                mark = "" if s["source"] == "heading" else "  [по рисункам]"
                print(f"  §{s['num']:>5}  стр. {s['page_start']:>3}–{s['page_end']:<3}  {s['title'][:65]}{mark}")


if __name__ == "__main__":
    main()
