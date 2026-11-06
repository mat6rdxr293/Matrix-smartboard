import json, re, os
ROOT = os.path.dirname(os.path.abspath(__file__))
P = f"{ROOT}/data/test.jsonl"
rows = [json.loads(l) for l in open(P, encoding="utf-8")]
DROP = {"517-1.9", "518-47.14", "490-47.14", "489-25.7", "517-25.7", "490-30.10-1", "518-30.10-1"}
FIX = {
    "489-10.7-1": ("$f(x) = x - 1$, $g(x) = \\sqrt{3x - 2}$ болса, $f(g(x))$, $f(f(x))$, $g(g(x))$ күрделі функцияларын құрыңдар.",
                   "$f(g(x)) = \\sqrt{3x-2} - 1$; $f(f(x)) = x - 2$; $g(g(x)) = \\sqrt{3\\sqrt{3x-2}-2}$"),
    "490-41.13-1": ("$x > 0$ болғанда, $f(x) = |2x|$ функциясының туындысын табыңдар.", "2"),
    "490-46.7-1": ("$f''(x)$ табыңдар: $f(x) = x \\sin x$", "$f''(x) = 2\\cos x - x\\sin x$"),
    "517-23.7": ("Найдите число способов выбора старосты и физрука класса из 20 учащихся.", "380"),
    "489-5.5": ("$y = x^2 + 3x$ функциясының графигіне $Ox$ осі бойымен 0,4 есе созуды орындаңдар. Шыққан функцияның формуласын жазыңдар.",
                "$y = 0,16x^2 + 1,2x$"),
    "517-5.5": ("Выполните растяжение вдоль оси $Ox$ в 0,4 раза графика функции $y = x^2 + 3x$. Запишите формулу полученной функции.",
                "$y = 0,16x^2 + 1,2x$"),
    "489-28.6": (None, "$\\approx 0,724$"), "517-28.6": (None, "$\\approx 0,724$"),
}
out = []
for r in rows:
    if r["id"] in DROP: continue
    r["q"] = re.sub(r"(^|\n)#+\s*", r"\1", r["q"]).replace(" :", ":").strip()
    if r["id"] in FIX:
        q, a = FIX[r["id"]]
        if q: r["q"] = q
        if a: r["answer"] = a
    out.append(r)
out.append({"id": "517-1.9-1", "lang": "ru", "section": 1, "q": "Найдите множество значений функции: $y = 2 + \\sqrt{x}$", "answer": "$E(y) = [2; +\\infty)$"})
with open(P, "w", encoding="utf-8") as f:
    for r in out: f.write(json.dumps(r, ensure_ascii=False) + "\n")
from collections import Counter
print(Counter(r["lang"] for r in out))
