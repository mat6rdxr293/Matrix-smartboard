"""Parse OCR'd textbook pages into exercises + answers, linked by number (e.g. 15.6)."""
import re, json, glob, os, sys

BOOKS = {  # book: (lang, first answers page)
    "517": ("ru", 224), "518": ("ru", 159),
    "489": ("kk", 228), "490": ("kk", 164),
}
ROOT = os.path.dirname(os.path.abspath(__file__))

def clean(t):
    t = t.replace("arccctg", "arcctg")
    t = re.sub(r"\\operatorname\{arc\}\s*\\operatorname\{ctg\}", r"\\operatorname{arcctg}", t)
    t = re.sub(r"\\operatorname\{arc ?ctg\}", r"\\operatorname{arcctg}", t)
    t = re.sub(r"\\operatorname\{arc ?tg\}", r"\\operatorname{arctg}", t)
    t = re.sub(r"\\operatorname\{arc\}\s*\\cos", r"\\arccos", t)
    t = re.sub(r"\\operatorname\{ar?c?cos\}", r"\\arccos", t)
    t = t.replace("```markdown", "").replace("```", "")
    t = re.sub(r"[^\S\n]+\n", "\n", t)
    return t

def dedup_lines(t):
    """drop runaway repeats produced by the OCR model"""
    out, seen = [], {}
    for line in t.split("\n"):
        k = line.strip()
        if k and len(k) > 3:
            seen[k] = seen.get(k, 0) + 1
            if seen[k] > 2:
                continue
        out.append(line)
    return "\n".join(out)

def load(book):
    pages = sorted(glob.glob(f"{ROOT}/ocr/{book}/p*.md"))
    res = []
    for p in pages:
        n = int(re.search(r"p(\d+)", p).group(1))
        res.append((n, dedup_lines(clean(open(p, encoding="utf-8").read()))))
    return res

EX_START = re.compile(r"^\s*(?:#+\s*)?(?:\*\*)?(?:Упр\.\s*)?(\d{1,2})\.(\d{1,2})(?![\d-])\.?(?:\*\*)?\s*(?=\S)", re.M)
RANGE = re.compile(r"\((\d{1,2})\.(\d{1,2})\s*[—–-]+\s*(\d{1,2})\.(\d{1,2})\s*\)")
SECTION = re.compile(r"^#+\s*(?:\*\*)?§\s*(\d{1,2})\.?\s*(.*)$", re.M)
LEVEL = re.compile(r"^\s*(?:#+\s*)?(?:\*\*)?([ABCАВС])(?:\*\*)?\s*$", re.M)

def parse_body(book, pages, ans_from):
    text = ""
    starts = []
    for n, t in pages:
        if n >= ans_from:
            break
        starts.append((len(text), n))
        text += t + "\n\n"
    def page_of(pos):
        pg = starts[0][1]
        for s, n in starts:
            if s <= pos: pg = n
        return pg

    # section titles (theory) by position
    secs = [(m.start(), int(m.group(1)), m.group(2).strip(" *")) for m in SECTION.finditer(text)]
    levels = [(m.start(), m.group(1).replace("А", "A").replace("В", "B").replace("С", "C")) for m in LEVEL.finditer(text)]
    ranges = [(m.start(), m.group(0), (int(m.group(1)), int(m.group(2))), (int(m.group(3)), int(m.group(4)))) for m in RANGE.finditer(text)]

    marks = list(EX_START.finditer(text))
    ex = {}
    for i, m in enumerate(marks):
        num = (int(m.group(1)), int(m.group(2)))
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end]
        # cut trailing headings / level markers / next instruction line
        body = re.split(r"\n\s*(?:#+ |ОПОРНЫЕ|ТІРЕК)", body)[0]
        body = LEVEL.sub("", body).strip()
        # instruction covering this number
        instr = ""
        for pos, line, a, b in ranges:
            if pos < m.start() and a <= num <= b:
                ls = text.rfind("\n", 0, pos) + 1
                le = text.find("\n", pos)
                instr = text[ls:le].strip()
        sec = None
        for pos, s, title in secs:
            if pos < m.start(): sec = (s, title)
        lvl = None
        for pos, l in levels:
            if pos < m.start(): lvl = l
        key = f"{num[0]}.{num[1]}"
        if key in ex or num[0] != (sec[0] if sec else num[0]):
            # duplicates / numbers inside theory (e.g. "15.2-сурет") -> keep first real exercise
            if key in ex: continue
        if len(body) < 3: continue
        ex[key] = {"book": book, "num": key, "page": page_of(m.start()),
                   "section": sec[0] if sec else None, "section_title": sec[1] if sec else None,
                   "level": lvl, "instruction": instr, "text": body}
    return ex, text, secs

ANS = re.compile(r"(?<![\d.,])(\d{1,2})\.(\d{1,2})\s*\.\s*", re.M)

def parse_answers(pages, ans_from):
    text = "\n".join(t for n, t in pages if n >= ans_from)
    text = re.sub(r"^#+\s*(\d{1,2}\.\d{1,2})\.?\s*$", r"\1.", text, flags=re.M)  # '### 1.1.' headings
    ms = list(ANS.finditer(text))
    out = {}
    for i, m in enumerate(ms):
        key = f"{int(m.group(1))}.{int(m.group(2))}"
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        a = text[m.end():end].strip()
        a = re.split(r"\n\s*#", a)[0].strip()
        if key not in out and a:
            out[key] = a
    return out

def main():
    os.makedirs(f"{ROOT}/parsed", exist_ok=True)
    stats = {}
    for book, (lang, af) in BOOKS.items():
        pages = load(book)
        ex, body, secs = parse_body(book, pages, af)
        ans = parse_answers(pages, af)
        for k, e in ex.items():
            e["lang"] = lang
            e["answer"] = ans.get(k)
        with open(f"{ROOT}/parsed/{book}.jsonl", "w", encoding="utf-8") as f:
            for e in sorted(ex.values(), key=lambda e: tuple(map(int, e["num"].split(".")))):
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        with open(f"{ROOT}/parsed/{book}_body.md", "w", encoding="utf-8") as f:
            f.write(body)
        stats[book] = (len(ex), sum(1 for e in ex.values() if e["answer"]), len(ans), len(secs))
    for b, s in stats.items():
        print(f"{b}: упражнений {s[0]}, с ответом {s[1]}, ответов всего {s[2]}, параграфов {s[3]}")

if __name__ == "__main__":
    main()
