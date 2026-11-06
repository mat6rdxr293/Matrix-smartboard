"""Assemble train/val JSONL (chat messages) from verified generations, seeds, theory and similar-task pairs."""
import json, re, random, os
from collections import Counter
ROOT = os.path.dirname(os.path.abspath(__file__))
random.seed(42)
SYSTEM = ("Ты — помощник по алгебре и началам анализа для 10 класса (Казахстан). "
          "Отвечай на языке вопроса: на русском или на казахском. Решай по шагам, формулы пиши в LaTeX.")
KK = re.compile(r"[әғқңөұүһіӘҒҚҢӨҰҮҺІ]")

def load(p):
    return [json.loads(l) for l in open(p, encoding="utf-8")]

def lang_ok(text, lang):
    prose = re.sub(r"\$[^$]*\$", " ", text)
    words = re.findall(r"[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]{3,}", prose)
    if not words: return True
    kk_share = sum(1 for w in words if KK.search(w)) / len(words)
    return kk_share > 0.12 if lang == "kk" else kk_share < 0.02

def clean_q(q):
    q = re.sub(r"(^|\n)#+\s*", r"\1", q).replace(" :", ":").replace("**", "")
    return re.sub(r"[ \t]+", " ", q).strip()

rows = load(f"{ROOT}/data/gen_out.jsonl")
last = {}
for r in rows: last[r["id"]] = r
ex, drop = [], Counter()
seen_q = set()
for r in last.values():
    if r["check"] not in ("exact", "numeric", "judge", "theory"): continue
    sol, q = r["solution"].strip(), clean_q(r["q"])
    if not q or len(sol) < 40: drop["short"] += 1; continue
    if len(sol) > 3000: drop["long"] += 1; continue
    if not lang_ok(sol, r["lang"]): drop["lang"] += 1; continue
    if re.search(r"(?i)(thinking process|let me|wait,)", sol): drop["junk"] += 1; continue
    key = (r["lang"], re.sub(r"\s", "", q))
    if key in seen_q: drop["dup"] += 1; continue
    seen_q.add(key)
    ex.append({"lang": r["lang"], "type": r["type"], "q": q, "a": sol})

seeds = [{"lang": s["lang"], "type": "seed", "q": s["q"], "a": s["a"]} for s in load(f"{ROOT}/data/seeds.jsonl")]
sim = load(f"{ROOT}/data/similar.jsonl")
sim_by = {"ru": [s for s in sim if s["lang"] == "ru"], "kk": [s for s in sim if s["lang"] == "kk"]}
sim_sel = []
for lang, lst in sim_by.items():
    random.shuffle(lst)
    sim_sel += [{"lang": lang, "type": "similar", "q": clean_q(s["q"]), "a": s["a"]} for s in lst[:150]]

data = ex + seeds * 2 + sim_sel  # seeds twice: they define the style
random.shuffle(data)
val = [d for d in data if d["type"] == "solve"][:40]
vset = {id(v) for v in val}
train = [d for d in data if id(d) not in vset]

def to_msgs(d):
    return {"messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": d["q"]},
                         {"role": "assistant", "content": d["a"]}], "lang": d["lang"], "type": d["type"]}

os.makedirs(f"{ROOT}/data", exist_ok=True)
for name, part in (("train", train), ("val", val)):
    with open(f"{ROOT}/data/{name}.jsonl", "w", encoding="utf-8") as f:
        for d in part: f.write(json.dumps(to_msgs(d), ensure_ascii=False) + "\n")
print("отброшено:", dict(drop))
print("train:", len(train), dict(Counter((d["lang"], d["type"]) for d in train)))
print("val:", len(val))
