"""Split exercises into sub-items "1) ..., 2) ..." and pair them with the matching part of the book answer."""
import re, json, glob, os, random
ROOT = os.path.dirname(os.path.abspath(__file__))
SUB = re.compile(r"(?:(?<=^)|(?<=[\s;.,:$]))(\d{1,2})\)\s*")

def split_sub(t):
    ms = list(SUB.finditer(t))
    # keep only an increasing 1,2,3... chain
    chain, want = [], 1
    for m in ms:
        if int(m.group(1)) == want:
            chain.append(m); want += 1
    if len(chain) < 2:
        return t.strip(), {}
    head = t[:chain[0].start()].strip()
    parts = {}
    for i, m in enumerate(chain):
        end = chain[i + 1].start() if i + 1 < len(chain) else len(t)
        parts[int(m.group(1))] = t[m.end():end].strip(" ;.\n,")
    return head, parts

def strip_solution(a):
    """book answers sometimes contain 'Решение./Шешуі.' – keep it separately"""
    m = re.search(r"(Решение|Шешуі|Шешімі)\s*\.?", a)
    return (a[:m.start()].strip(" ;."), a[m.end():].strip()) if m else (a.strip(" ;."), "")

def main():
    items = []
    for f in sorted(glob.glob(f"{ROOT}/parsed/[0-9]*.jsonl")):
        for line in open(f, encoding="utf-8"):
            e = json.loads(line)
            if not e.get("answer"):
                continue
            head, parts = split_sub(e["text"])
            ans, sol = strip_solution(e["answer"])
            ahead, aparts = split_sub(ans)
            task = "\n".join(x for x in (e["instruction"], head) if x).strip()
            base = {k: e[k] for k in ("book", "lang", "num", "section", "section_title", "level", "page")}
            if parts and aparts:
                for i, p in parts.items():
                    if i in aparts:
                        items.append({**base, "id": f"{e['book']}-{e['num']}-{i}", "task": task, "item": p,
                                      "answer": aparts[i], "book_solution": ""})
            else:
                items.append({**base, "id": f"{e['book']}-{e['num']}", "task": task, "item": e["text"] if not parts else "",
                              "answer": ans, "book_solution": sol})
    with open(f"{ROOT}/parsed/items.jsonl", "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    from collections import Counter
    c = Counter(it["lang"] for it in items)
    print("пунктов с ответом:", dict(c))
    print("с готовым решением из книги:", sum(1 for i in items if i["book_solution"]))

if __name__ == "__main__":
    main()
