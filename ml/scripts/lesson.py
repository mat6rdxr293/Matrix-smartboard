"""Урок по параграфу: задания + текст для шаблонной презентации (JSON) через локальный llama-server.

    scripts/serve.sh &
    python scripts/lesson.py physics_11_fizika_emn_kk_11_part1 --section 7
    python scripts/lesson.py algebra_11_algebra_emn_ru_11 --pages 59-61 --what tasks

Текст берётся из data/vlm/ (распознан моделью со зрением, формулы в LaTeX), если там есть все
страницы параграфа, иначе из data/raw/ (Tesseract — как на доске). Язык ответа = язык учебника.

Порядок запросов важен для скорости: текст параграфа идёт первым и одинаков в обоих запросах,
поэтому llama-server переиспользует его из кэша (cache_prompt) и второй запрос почти не тратит
время на чтение параграфа.

Задания — в формате контракта v1 с бэкендом: {type, question, options, answer, level}, у calc ещё solution;
у теста answer всегда один из options. Формулы — Unicode-текстом ($ и \\ запрещены грамматикой).
Математику проверяет mathcheck.py (SymPy): поле check у задания — ok / fixed / wrong / unverified.

Выход: data/lessons/<книга>_§<n>.json = {book, section, pages, lang, text_source, tasks, slides, timings}
"""
import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

import requests

from mathcheck import check_tasks

ROOT = Path(__file__).resolve().parent.parent

SYSTEM = {
    "kk": "Сен мектеп мұғалімінің көмекшісісің. Оқулық мәтіні бойынша сабаққа материал дайындайсың. "
          "Тек қазақ тілінде жаз. Формулаларды дұрыс жаз, мәтінде жоқ фактілерді ойдан шығарма.",
    "ru": "Ты помощник школьного учителя. Готовишь материалы к уроку по тексту учебника. "
          "Пиши только на русском. Формулы записывай точно, не выдумывай фактов, которых нет в тексте.",
    "en": "You are a school teacher's assistant preparing lesson materials from a textbook text. "
          "Write in English. Write formulas exactly and do not invent facts that are not in the text.",
}
CONTEXT_HEAD = {"kk": "Оқулық мәтіні", "ru": "Текст учебника", "en": "Textbook text"}
# Формулы — обычным текстом с Unicode: python-pptx на стороне бэкенда LaTeX не отрисует (контракт v1)
FORMULAS = {
    "kk": " Формулаларды LaTeX-сыз, қарапайым мәтінмен және Unicode таңбаларымен жаз: α, ω, Φ, ², ³, √, ·, ×, ≤, π.",
    "ru": " Формулы пиши обычным текстом с символами Unicode, без LaTeX: α, ω, Φ, ², ³, √, ·, ×, ≤, π.",
    "en": " Write formulas as plain text with Unicode symbols, no LaTeX: α, ω, Φ, ², ³, √, ·, ×, ≤, π.",
}
ASK = {
    "tasks": {
        "kk": "Осы мәтін бойынша тапсырмалар құрастыр: {test} тест (4 жауап нұсқасы, correct — дұрыс нұсқаның нөмірі "
              "0-ден 3-ке дейін), {open} ашық сұрақ және {calc} есеп. Есептің solution өрісіне шешу жолын қадамдап, "
              "answer өрісіне жауабын бірлігімен жаз; question өрісінде тек есептің шартын жаз. Әр тапсырмаға қиындық деңгейін (1–3) көрсет.",
        "ru": "Составь по этому тексту задания: {test} теста (4 варианта ответа, correct — номер правильного варианта "
              "от 0 до 3), {open} открытых вопроса и {calc} расчётных задач. У задачи в поле solution — ход решения "
              "по шагам, в поле answer — ответ с единицами измерения; в question — только условие задачи. Для каждого задания укажи уровень сложности (1–3).",
        "en": "Create tasks from this text: {test} multiple-choice tests (4 options, correct is the index of the right "
              "option, 0–3), {open} open questions and {calc} calculation problems. For a problem, put the step-by-step "
              "solution in the solution field and the answer with units in answer; question holds only the problem. Give the difficulty (1–3) for each task.",
    },
    "slides": {
        "kk": "Осы мәтін бойынша сабаққа {n} слайдтан тұратын презентация мәтінін жаса: әр слайдқа тақырып, "
              "2–4 қысқа тезис және мұғалімге арналған бір сөйлемдік түсініктеме.",
        "ru": "Сделай по этому тексту текст презентации к уроку из {n} слайдов: для каждого слайда заголовок, "
              "2–4 коротких тезиса и одно предложение-заметку для учителя.",
        "en": "Make the text of a {n}-slide lesson presentation from this text: for each slide a title, "
              "2–4 short bullet points and a one-sentence note for the teacher.",
    },
}


def text(max_len):
    """Строка без $ и \\ — LaTeX невозможен на уровне грамматики. В llama.cpp pattern отменяет maxLength,
    поэтому длина задаётся в самом шаблоне. Кавычка и перевод строки исключены, чтобы не было экранирования."""
    return {"type": "string", "pattern": f'^[^$\\\\"\\n]{{1,{max_len}}}$'}


LEVEL = {"type": "integer", "enum": [1, 2, 3]}
# Порядок полей = порядок генерации: ход решения идёт до ответа, чтобы модель сначала считала
TASK_VARIANTS = [
    {"type": "object", "properties": {
        "type": {"const": "test"}, "question": text(300),
        "options": {"type": "array", "items": text(120), "minItems": 4, "maxItems": 4},
        "correct": {"type": "integer", "enum": [0, 1, 2, 3]}, "level": LEVEL},
     "required": ["type", "question", "options", "correct", "level"]},
    {"type": "object", "properties": {
        "type": {"const": "open"}, "question": text(300), "answer": text(300), "level": LEVEL},
     "required": ["type", "question", "answer", "level"]},
    {"type": "object", "properties": {
        "type": {"const": "calc"}, "question": text(300), "solution": text(400), "answer": text(120), "level": LEVEL},
     "required": ["type", "question", "solution", "answer", "level"]},
]
SCHEMA = {
    "tasks": {
        "type": "object",
        "properties": {"tasks": {"type": "array"}},  # prefixItems — по составу, см. composition()
        "required": ["tasks"],
    },
    "slides": {
        "type": "object",
        "properties": {"slides": {"type": "array", "items": {
            "type": "object",
            "properties": {
                # ограничения длины соблюдаются при генерации (грамматика llama.cpp) → короче и быстрее
                "title": text(80),
                "bullets": {"type": "array", "items": text(140), "minItems": 2, "maxItems": 4},
                "notes": text(200),
            },
            "required": ["title", "bullets", "notes"],
        }}},
        "required": ["slides"],
    },
}


def composition(n, context):
    """Сколько тестов, открытых вопросов и задач. Состав задаётся схемой (prefixItems) — иначе модель
    делает все задания тестами. Задачи — только если в тексте есть формулы (история — без задач)."""
    calc = max(1, n // 6) if context.count("=") >= 5 else 0
    open_ = max(1, round(n / 3)) if n - calc > 1 else 0
    return {"test": n - calc - open_, "open": open_, "calc": calc}


def task_schema(comp):
    by_type = {v["properties"]["type"]["const"]: v for v in TASK_VARIANTS}
    items = [by_type[t] for t in ("test", "open", "calc") for _ in range(comp[t])]
    return {"type": "object", "properties": {"tasks": {"type": "array", "prefixItems": items}},
            "required": ["tasks"]}


def to_contract(tasks, seed=0):
    """Задания в формате контракта v1: {type, question, options, answer, level} (+ solution у calc).
    У теста answer — всегда один из options; варианты перемешиваются, иначе модель чаще ставит верный первым."""
    rng = random.Random(seed)
    out = []
    for t in tasks:
        item = {"type": t["type"], "question": t["question"], "options": [], "answer": t.get("answer", ""),
                "level": t["level"]}
        if t["type"] == "test":
            right = t["options"][t["correct"]]
            opts = t["options"][:]
            rng.shuffle(opts)
            item["options"], item["answer"] = opts, right
        if t["type"] == "calc":
            item["solution"] = t["solution"]
        out.append(item)
    return out


def load_pages(book):
    raw = {json.loads(l)["page"]: json.loads(l) for l in open(ROOT / "data" / "raw" / f"{book}.jsonl", encoding="utf-8")}
    vlm_path = ROOT / "data" / "vlm" / f"{book}.jsonl"
    vlm = {}
    if vlm_path.exists():
        for l in vlm_path.open(encoding="utf-8"):
            r = json.loads(l)
            if not r.get("truncated"):
                vlm[r["page"]] = r["text"]
    return raw, vlm


def pick_text(pages, raw, vlm, max_chars):
    if all(p in vlm for p in pages):
        source, text = "vlm", "\n\n".join(vlm[p] for p in pages)
    else:
        source, text = "tesseract", "\n\n".join(raw[p]["text"] for p in pages if p in raw)
    cut = len(text) > max_chars
    return source, text[:max_chars], cut


def detect_lang(pages, raw):
    # по всему параграфу сразу: на отдельной странице (формулы, рисунки) мало текста и много шума OCR
    from extract_pdf import lang_guess
    lang = lang_guess("\n".join(raw[p]["text"] for p in pages if p in raw))
    return lang if lang in SYSTEM else "ru"


def degenerate(obj):
    """Зацикливание: один и тот же кусок ≥ 6 раз подряд где-то в тексте ответа."""
    return re.search(r"(.{3,30}?)\1{5,}", json.dumps(obj, ensure_ascii=False)) is not None


def ask(api, model, lang, context, what, n, max_tokens, seed=0):
    if what == "tasks":
        comp = composition(n, context)
        schema, ask_text = task_schema(comp), ASK[what][lang].format(**comp)
    else:
        schema = json.loads(json.dumps(SCHEMA[what]))
        schema["properties"][what]["maxItems"] = n
        ask_text = ASK[what][lang].format(n=n)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM[lang] + FORMULAS[lang]},
            # контекст первым и без изменений между запросами → переиспользуется из кэша сервера
            {"role": "user", "content": f"{CONTEXT_HEAD[lang]}:\n\n{context}\n\n---\n{ask_text}"},
        ],
        "temperature": 0.4,
        "repeat_penalty": 1.1,  # против зацикливания вида \bar{\bar{\bar{…
        "seed": seed,
        "max_tokens": max_tokens,
        "cache_prompt": True,
        "response_format": {"type": "json_schema", "json_schema": {"name": what, "schema": schema}},
    }
    t0 = time.perf_counter()
    r = requests.post(f"{api}/chat/completions", json=body, timeout=1800)
    r.raise_for_status()
    js = r.json()
    t = js.get("timings", {})
    timing = {"total_s": round(time.perf_counter() - t0, 1),
              "prompt_tokens": t.get("prompt_n"), "prompt_cached": t.get("cache_n"),
              "prompt_s": round(t.get("prompt_ms", 0) / 1000, 1), "gen_tokens": t.get("predicted_n"),
              "gen_s": round(t.get("predicted_ms", 0) / 1000, 1),
              "gen_tok_per_s": round(t.get("predicted_per_second", 0), 1)}
    return json.loads(js["choices"][0]["message"]["content"])[what], timing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book", help="имя файла в data/raw без .jsonl, напр. physics_11_fizika_emn_kk_11_part1")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--section", help="номер параграфа, напр. 7 или 1-2")
    g.add_argument("--pages", help="страницы, напр. 51-53")
    ap.add_argument("--what", choices=["tasks", "slides", "both"], default="both")
    ap.add_argument("--n-tasks", type=int, default=6)
    ap.add_argument("--n-slides", type=int, default=6)
    ap.add_argument("--max-chars", type=int, default=6000,
                    help="сколько символов параграфа подавать (на CPU каждые ~1000 токенов ≈ 20–25 с)")
    ap.add_argument("--api", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="qwen3.5-4b-q4-k-m")
    args = ap.parse_args()

    raw, vlm = load_pages(args.book)
    if args.section:
        secs = json.loads((ROOT / "data" / "sections" / f"{args.book}.json").read_text(encoding="utf-8"))
        sec = next((s for s in secs if s["num"] == args.section), None)
        if not sec:
            sys.exit(f"§{args.section} не найден; есть: {[s['num'] for s in secs]}")
        pages, label = list(range(sec["page_start"], sec["page_end"] + 1)), f"§{sec['num']} {sec['title']}"
    else:
        a, _, b = args.pages.partition("-")
        pages, label = list(range(int(a), int(b or a) + 1)), f"стр. {args.pages}"

    lang = detect_lang(pages, raw)
    source, context, cut = pick_text(pages, raw, vlm, args.max_chars)
    print(f"{args.book}: {label}, стр. {pages[0]}–{pages[-1]}, язык {lang}, текст: {source}, "
          f"{len(context)} симв.{' (обрезан)' if cut else ''}", flush=True)

    result = {"book": args.book, "section": args.section, "title": label, "pages": [pages[0], pages[-1]],
              "lang": lang, "text_source": source, "text_chars": len(context), "text_cut": cut, "timings": {}}
    for what in (["tasks", "slides"] if args.what == "both" else [args.what]):
        n = args.n_tasks if what == "tasks" else args.n_slides
        for attempt in range(3):
            items, timing = ask(args.api, args.model, lang, context, what, n, max_tokens=2000, seed=attempt)
            if not degenerate(items):
                break
            print(f"  {what}: зацикливание в ответе, повтор (попытка {attempt + 2})", flush=True)
        timing["attempts"] = attempt + 1
        if what == "tasks":
            items = check_tasks(to_contract(items, seed=attempt))
            checks = [t["check"]["status"] for t in items if "check" in t]
            if checks:
                print(f"  проверка математики: " + ", ".join(f"{k} {checks.count(k)}" for k in dict.fromkeys(checks)),
                      flush=True)
        result[what], result["timings"][what] = items, timing
        print(f"  {what}: {len(items)} шт. за {timing['total_s']} с "
              f"(промпт {timing['prompt_tokens']} ток., из кэша {timing['prompt_cached']}, {timing['prompt_s']} с; "
              f"генерация {timing['gen_tokens']} ток., {timing['gen_s']} с, {timing['gen_tok_per_s']} ток/с)", flush=True)

    out = ROOT / "data" / "lessons" / f"{args.book}_§{args.section or args.pages}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {out}")


if __name__ == "__main__":
    main()
