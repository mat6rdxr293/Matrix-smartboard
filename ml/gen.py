"""Generate step-by-step solutions with local Qwen (Ollama) and keep only those whose final answer matches the textbook.

usage:
  python gen.py baseline          # 44 held-out test questions, plain model -> data/baseline.jsonl
  python gen.py run [limit]       # solve + theory tasks -> data/gen_out.jsonl (resumable)
  python gen.py stats
"""
import json, os, re, sys, time, random, urllib.request

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
MODEL = os.environ.get("MODEL", "qwen3.5:4b")
URL = "http://localhost:11434/api/chat"

SYS = {
    "ru": ("Ты — помощник учителя математики в казахстанской школе (алгебра и начала анализа, 10 класс). "
           "Решай задачу по шагам, кратко и понятно для ученика, используй обозначения учебника "
           "(tg, ctg, arctg, arcctg, $n \\in Z$). Формулы пиши в LaTeX ($...$). "
           "Отвечай только на русском. В конце обязательно напиши строку «**Ответ:** ...»."),
    "kk": ("Сен — қазақстандық мектептегі математика мұғалімінің көмекшісісің (алгебра және анализ бастамалары, 10-сынып). "
           "Есепті қадам бойынша, оқушыға қысқа әрі түсінікті етіп шығар, оқулықтағы белгілеулерді қолдан "
           "(tg, ctg, arctg, arcctg, $n \\in Z$). Формулаларды LaTeX-те жаз ($...$). "
           "Тек қазақ тілінде жауап бер, орысша сөздер қолданба. Соңында міндетті түрде «**Жауабы:** ...» жолын жаз."),
}
MARK = {"ru": r"\*\*Ответ:?\*\*:?", "kk": r"\*\*Жауабы:?\*\*:?"}

def chat(messages, think, num_predict=3000, temperature=0.2):
    body = {"model": MODEL, "messages": messages, "stream": False, "think": think,
            "options": {"temperature": temperature, "num_predict": num_predict, "num_ctx": 8192}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                return json.loads(r.read())["message"]
        except Exception as e:
            print("  ollama error:", e, flush=True); time.sleep(5)
    return {"content": ""}

# ---------- answer checking ----------
def norm(s):
    s = s.strip().strip(".;").replace("$", "").replace("{,}", ".").replace("\\dfrac", "\\frac").replace("\\ ", " ")
    s = re.sub(r"\\(left|right|displaystyle|,|;|!|quad|qquad)", "", s)
    s = re.sub(r"\\text\{[^}]*\}", " ", s)
    s = re.sub(r"(где|мұндағы|при|бұл жерде)", " ", s)
    s = re.sub(r"\\in\s*(Z|\\mathbb\{Z\})", "", s)
    s = re.sub(r"\b[knm]\b", "n", s)
    s = s.replace("\\operatorname{tg}", "tg").replace("\\operatorname", "").replace("\\leqslant", "\\le").replace("\\leq", "\\le")
    s = s.replace("\\geqslant", "\\ge").replace("\\geq", "\\ge").replace("\\cdot", "*").replace("\\times", "*")
    s = re.sub(r"(\d),(\d)", r"\1.\2", s)
    s = re.sub(r"^[a-zA-Z]\s*(\([^)]*\))?\s*=", "", s)  # drop leading "x =" / "f'(x) ="
    return re.sub(r"[\s{}]", "", s).lower()

def to_num(s):
    """evaluate simple numeric LaTeX (fractions, roots, pi, degrees) without extra deps"""
    import math
    try:
        t = s.replace("$", "").strip().strip(".;").replace("{,}", ".").replace("\\dfrac", "\\frac")
        t = re.split(r"=|\\approx|≈", t)[-1].strip()
        t = re.sub(r"\\(left|right|,|approx)|≈", "", t).replace("\\cdot", "*").replace("\\times", "*")
        t = re.sub(r"(\d),(\d)", r"\1.\2", t)
        t = re.sub(r"\^\{?\\circ\}?", "*pi/180", t)
        for _ in range(4):
            t = re.sub(r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"((\1)/(\2))", t)
            t = re.sub(r"\\sqrt\[(\d+)\]\{([^{}]*)\}", r"((\2)**(1/\1))", t)
            t = re.sub(r"\\sqrt\{([^{}]*)\}", r"sqrt(\1)", t)
        t = re.sub(r"\\sqrt\s*(\d+)", r"sqrt(\1)", t)
        t = t.replace("\\pi", "pi").replace("^", "**").replace("{", "(").replace("}", ")")
        t = re.sub(r"(\d)\s*(pi|sqrt|\()", r"\1*\2", t)
        t = re.sub(r"\)\s*(pi|sqrt|\(|\d)", r")*\1", t)
        t = re.sub(r"pi\s*(\d|\()", r"pi*\1", t)
        if not t or re.search(r"[^0-9+\-*/(). pisqrt]", t):
            return None
        return complex(eval(t, {"__builtins__": {}}, {"pi": math.pi, "sqrt": math.sqrt}))
    except Exception:
        return None

def judge(book, got):
    msg = [{"role": "user", "content":
            "Ответ из учебника: " + book + "\nОтвет ученика: " + got +
            "\nОни математически совпадают? Другая форма записи, другая буква для целого параметра, "
            "десятичная дробь вместо обыкновенной — считаются совпадением. Ответь одним словом: ДА или НЕТ."}]
    r = chat(msg, think=False, num_predict=5, temperature=0)["content"].strip().upper()
    return r.startswith("ДА") or r.startswith("YES")

def check(book, got):
    if not got: return "no_answer"
    if norm(book) == norm(got): return "exact"
    a, b = to_num(book), to_num(got)
    if a is not None and b is not None:
        return "numeric" if abs(a - b) < 1e-6 * max(1, abs(a)) else "wrong"
    return "judge" if judge(book, got) else "wrong"

def final_answer(text, lang):
    m = list(re.finditer(MARK[lang], text))
    return text[m[-1].end():].strip().split("\n")[0].strip() if m else ""

# ---------- tasks ----------
def load(p):
    return [json.loads(l) for l in open(p, encoding="utf-8")] if os.path.exists(p) else []

SEEDS = load(os.path.join(D, "seeds.jsonl"))

def shots(lang, section, k=2):
    pool = [s for s in SEEDS if s["lang"] == lang and not s["q"].startswith(("Объясни", "Санның"))]
    pool.sort(key=lambda s: abs((s["section"] or 0) - (section or 0)))
    pick = pool[:1] + random.sample(pool[1:], k - 1)
    msgs = []
    for s in pick:
        msgs += [{"role": "user", "content": s["q"]}, {"role": "assistant", "content": s["a"]}]
    return msgs

def do_solve(t):
    msgs = [{"role": "system", "content": SYS[t["lang"]]}] + shots(t["lang"], t["section"]) + [{"role": "user", "content": t["q"]}]
    r = chat(msgs, think=False, num_predict=2500)
    sol = r.get("content", "").strip()
    got = final_answer(sol, t["lang"])
    return {**t, "solution": sol, "model_answer": got, "check": check(t["answer"], got)}

TH_PROMPT = {
    "ru": ("Ниже фрагмент учебника алгебры 10 класса.\n\n<<<\n{ctx}\n>>>\n\n"
           "Придумай один вопрос, который ученик мог бы задать по главному определению или теореме этого фрагмента "
           "(например «Что такое ...?», «Объясни ...», «Чем отличается ...?»), и напиши на него ответ учителя: "
           "своими словами, но строго по учебнику, с одним коротким примером. Ничего не выдумывай сверх фрагмента. "
           "Формат строго:\nВОПРОС: ...\nОТВЕТ: ..."),
    "kk": ("Төменде 10-сыныпқа арналған алгебра оқулығының үзіндісі берілген.\n\n<<<\n{ctx}\n>>>\n\n"
           "Осы үзіндідегі негізгі анықтама немесе теорема бойынша оқушы қоюы мүмкін бір сұрақ құрастыр "
           "(мысалы «... дегеніміз не?», «... түсіндіріп бер»), және оған мұғалімнің жауабын жаз: өз сөзіңмен, "
           "бірақ тек оқулық бойынша, бір қысқа мысалмен. Үзіндіде жоқ нәрсені ойдан шығарма. Тек қазақ тілінде жаз. "
           "Формат:\nСҰРАҚ: ...\nЖАУАП: ..."),
}

def do_theory(t):
    r = chat([{"role": "user", "content": TH_PROMPT[t["lang"]].format(ctx=t["context"])}], think=True)
    c = r.get("content", "")
    qk, ak = ("ВОПРОС:", "ОТВЕТ:") if t["lang"] == "ru" else ("СҰРАҚ:", "ЖАУАП:")
    if qk in c and ak in c:
        q = c.split(qk, 1)[1].split(ak, 1)[0].strip()
        a = c.split(ak, 1)[1].strip()
        return {**{k: t[k] for k in ("type", "id", "lang", "section")}, "q": q, "solution": a, "check": "theory"}
    return {**{k: t[k] for k in ("type", "id", "lang", "section")}, "q": "", "solution": c, "check": "bad_format"}

def run(limit=None):
    tasks = load(os.path.join(D, "gen_tasks.jsonl"))
    random.seed(0); random.shuffle(tasks)
    outp = os.path.join(D, "gen_out.jsonl")
    done = {r["id"] for r in load(outp) if r["check"] not in ("no_answer", "bad_format")}
    todo = [t for t in tasks if t["id"] not in done][: int(limit) if limit else None]
    print(f"готово {len(done)}, осталось {len(todo)}", flush=True)
    ok = 0
    with open(outp, "a", encoding="utf-8") as f:
        for i, t in enumerate(todo, 1):
            t0 = time.time()
            r = do_solve(t) if t["type"] == "solve" else do_theory(t)
            f.write(json.dumps(r, ensure_ascii=False) + "\n"); f.flush()
            ok += r["check"] in ("exact", "numeric", "judge", "theory")
            print(f"[{i}/{len(todo)}] {t['id']} {t['type']} -> {r['check']}  ({time.time() - t0:.0f} c, принято {ok})", flush=True)

def baseline():
    tests = load(os.path.join(D, "test.jsonl"))
    out = []
    for t in tests:
        r = chat([{"role": "user", "content": t["q"]}], think=False, num_predict=1500)
        out.append({**t, "model_output": r.get("content", "")})
        print(t["id"], "ok", flush=True)
    with open(os.path.join(D, "baseline.jsonl"), "w", encoding="utf-8") as f:
        for r in out: f.write(json.dumps(r, ensure_ascii=False) + "\n")

def stats():
    from collections import Counter
    rows = load(os.path.join(D, "gen_out.jsonl"))
    print(Counter((r["lang"], r["check"]) for r in rows))

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    {"run": lambda: run(sys.argv[2] if len(sys.argv) > 2 else None), "baseline": baseline, "stats": stats}[cmd]()
