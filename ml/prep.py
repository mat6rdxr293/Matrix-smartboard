"""Build generation tasks: solve-items (with book answers), theory questions, similar-task pairs; hold out a test set."""
import json, re, random, os
from collections import defaultdict
ROOT = os.path.dirname(os.path.abspath(__file__))
random.seed(42)

items = [json.loads(l) for l in open(f"{ROOT}/parsed/items.jsonl", encoding="utf-8")]
for it in items:
    for k in ("task", "item", "answer"):
        it[k] = re.sub(r"\n?-{3,}\n?", " ", it[k]).strip()
    it["answer"] = re.sub(r"(?<![A-Za-zА-Яа-яЁё\\])П(?![A-Za-zА-Яа-яЁё])", r"\\pi", it["answer"])

BAD_TASK = re.compile(r"(Постройте|Начертите график|Докажите|Изобразите|салыңдар|сызыңдар|Дәлелде|дәлелде|графигін сал|Покажите|Объясните, почему|Түсіндіріңдер)", re.I)

def ok(it):
    q = (it["task"] + " " + it["item"]).strip()
    a = it["answer"]
    if not it["item"] and len(it["task"]) < 15: return False
    if BAD_TASK.search(q): return False
    if len(a) < 1 or len(a) > 250 or len(q) > 900: return False
    if re.search(r"(рис\.|сурет)", a, re.I): return False
    if "$" not in q and len(q) < 80: return False
    if re.match(r"\s*1\)", a) and not it["item"]: return False
    if not it["item"] and re.search(r"(^|\s)1\)", it["task"]) is None and len(it["task"]) < 40: return False
    return True

def clean_q(it):
    task = re.sub(r"\s*\(\d+\.\d+\s*[—–-]+\s*\d+\.\d+\)\s*", " ", it["task"]).strip().rstrip("*").strip()
    task = re.split(r"\n\s*\n", task)[0] if len(task) > 400 else task
    item = re.split(r"\n\s*\n", it["item"])[0].strip().rstrip(";.,")
    q = f"{task} {item}".strip() if item else task
    return re.sub(r"\s+\n", "\n", q)

good = [it for it in items if ok(it)]
# --- test set: 25 exercise numbers present in BOTH languages, spread over sections, from 518/490 and 517/489
by_num = defaultdict(dict)
for it in good:
    part = "1" if it["book"] in ("517", "489") else "2"
    by_num[(part, it["num"])].setdefault(it["lang"], []).append(it)
both = [k for k, v in by_num.items() if "ru" in v and "kk" in v]
by_sec = defaultdict(list)
for k in both:
    by_sec[k[1].split(".")[0] + k[0]].append(k)
secs = list(by_sec)
random.shuffle(secs)
test_keys = set()
for s in secs:
    if len(test_keys) >= 25: break
    test_keys.add(random.choice(by_sec[s]))

test, train = [], []
for it in good:
    part = "1" if it["book"] in ("517", "489") else "2"
    (test if (part, it["num"]) in test_keys else train).append(it)
# one sub-item per exercise in test, same sub-item for ru/kk
tsel = {}
for it in test:
    part = "1" if it["book"] in ("517", "489") else "2"
    k = (part, it["num"], it["lang"])
    tsel.setdefault(k, it)
os.makedirs(f"{ROOT}/data", exist_ok=True)
with open(f"{ROOT}/data/test.jsonl", "w", encoding="utf-8") as f:
    for it in tsel.values():
        f.write(json.dumps({"id": it["id"], "lang": it["lang"], "section": it["section"], "q": clean_q(it), "answer": it["answer"]}, ensure_ascii=False) + "\n")

with open(f"{ROOT}/data/gen_tasks.jsonl", "w", encoding="utf-8") as f:
    for it in train:
        f.write(json.dumps({"type": "solve", "id": it["id"], "lang": it["lang"], "section": it["section"],
                            "level": it["level"], "q": clean_q(it), "answer": it["answer"]}, ensure_ascii=False) + "\n")
    # theory: definitions with surrounding textbook context
    n_th = 0
    for book, lang in (("517", "ru"), ("518", "ru"), ("489", "kk"), ("490", "kk")):
        body = open(f"{ROOT}/parsed/{book}_body.md", encoding="utf-8").read()
        for m in re.finditer(r"(Определение|Анықтама|Теорема)", body):
            ctx = body[max(0, m.start() - 1200): m.start() + 1500]
            sec = re.findall(r"§\s*(\d{1,2})", body[:m.start()])
            f.write(json.dumps({"type": "theory", "id": f"{book}-th-{m.start()}", "lang": lang,
                                "section": int(sec[-1]) if sec else None, "context": ctx,
                                "kind": m.group(1)}, ensure_ascii=False) + "\n")
            n_th += 1

# similar tasks: built directly from sibling sub-items of one exercise (no model needed)
sim = []
grp = defaultdict(list)
for it in train:
    grp[(it["book"], it["num"])].append(it)
for (book, num), g in grp.items():
    if len(g) < 3: continue
    lang = g[0]["lang"]
    src, rest = g[0], g[1:4]
    task = re.sub(r"\s*\(\d+\.\d+\s*[—–-]+\s*\d+\.\d+\)\s*", " ", src["task"]).strip().rstrip("*:").strip()
    if lang == "ru":
        q = f"Придумай {len(rest)} похожих задания на это: {clean_q(src)}"
        a = (f"Вот {len(rest)} похожих задания ({task[0].lower() + task[1:] if task else 'того же типа'}):\n\n" if task else f"Вот {len(rest)} похожих задания:\n\n")
        a += "\n".join(f"{i}) {r['item'].strip().rstrip(';.,')}" for i, r in enumerate(rest, 1))
        a += "\n\n**Ответы:** " + "; ".join(f"{i}) {r['answer'].strip().rstrip(';.')}" for i, r in enumerate(rest, 1)) + "."
    else:
        q = f"Мына тапсырмаға ұқсас {len(rest)} тапсырма құрастырып бер: {clean_q(src)}"
        a = f"Міне, ұқсас {len(rest)} тапсырма" + (f" ({task[0].lower() + task[1:]})" if task else "") + ":\n\n"
        a += "\n".join(f"{i}) {r['item'].strip().rstrip(';.,')}" for i, r in enumerate(rest, 1))
        a += "\n\n**Жауаптары:** " + "; ".join(f"{i}) {r['answer'].strip().rstrip(';.')}" for i, r in enumerate(rest, 1)) + "."
    sim.append({"type": "similar", "id": f"{book}-{num}-sim", "lang": lang, "section": src["section"], "q": q, "a": a})
with open(f"{ROOT}/data/similar.jsonl", "w", encoding="utf-8") as f:
    for s in sim:
        f.write(json.dumps(s, ensure_ascii=False) + "\n")

from collections import Counter
print("отобрано пунктов:", len(good), "| train:", Counter(i["lang"] for i in train), "| test:", Counter(i["lang"] for i in tsel.values()))
print("теория (определения/теоремы):", n_th, "| похожие задания:", Counter(s["lang"] for s in sim))
