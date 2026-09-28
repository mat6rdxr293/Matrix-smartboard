"""Веб-интерфейс для работы с моделью: данные → обучение → экспорт → проверка → урок.

    source venv/bin/activate
    python scripts/ui.py            # открыть в браузере http://127.0.0.1:7860

Интерфейс только запускает готовые скрипты (finetune.py, export_gguf.py, run_bench.py, score.py,
serve.sh, lesson.py) и показывает их прогресс. Каждая задача пишет лог в runs/<время>_<тип>_<имя>/ и
продолжает работать, даже если закрыть или обновить страницу.
"""
import csv
import datetime
import io
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import gradio as gr
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from prompts import SYSTEM_PROMPT  # noqa: E402

PY = sys.executable
RUNS = ROOT / "runs"
SFT = ROOT / "data" / "sft"
MODELS = ROOT / "models"
BENCH = ROOT / "benchmark"
BASE_MODELS = ["unsloth/Qwen3.5-4B", "unsloth/Qwen3.5-2B"]
GPU_KINDS = {"train", "export", "bench"}  # задачи, которым нужна видеокарта (одновременно — только одна)
LATEX = [{"left": "$$", "right": "$$", "display": True}, {"left": "$", "right": "$", "display": False}]
KIND_RU = {"train": "обучение", "export": "экспорт", "bench": "бенчмарк", "score": "оценка",
           "server": "сервер", "lesson": "урок"}


# ───────────────────────── фоновые задачи ─────────────────────────

def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    # зомби (процесс завершился, но родитель ещё не забрал код) — тоже «не жив»
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except OSError:
        return False


def start_job(kind, name, cmd):
    RUNS.mkdir(exist_ok=True)
    run = RUNS / f"{datetime.datetime.now():%Y%m%d_%H%M%S}_{kind}_{re.sub(r'[^\w.-]+', '_', name)}"
    run.mkdir()
    log = open(run / "log.txt", "w", encoding="utf-8")
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    p = subprocess.Popen([str(c) for c in cmd], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                         env=env, start_new_session=True)  # своя группа процессов → можно остановить целиком
    meta = {"kind": kind, "name": name, "cmd": [str(c) for c in cmd], "pid": p.pid, "started": time.time()}
    (run / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return run


def list_runs(kind=None):
    out = []
    for m in sorted(RUNS.glob("*/meta.json"), reverse=True) if RUNS.exists() else []:
        meta = json.loads(m.read_text(encoding="utf-8"))
        if kind and meta["kind"] != kind:
            continue
        meta["dir"] = m.parent
        meta["alive"] = pid_alive(meta["pid"])
        out.append(meta)
    return out


def running(kinds):
    return [r for r in list_runs() if r["alive"] and r["kind"] in kinds]


def stop_run(run):
    try:
        os.killpg(run["pid"], signal.SIGTERM)
    except OSError:
        pass


def tail(path, n=40):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    text = re.sub(r"\r(?!\n)", "\n", text)  # прогресс-бары перерисовываются через \r
    lines = [l for l in text.splitlines() if l.strip() and "torchao/_C" not in l and "UserWarning" not in l]
    return "\n".join(lines[-n:])


def gpu_status():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
        used, total, util = [int(x) for x in out.strip().split(",")]
        return f"GPU: занято {used / 1024:.1f} из {total / 1024:.1f} ГБ, загрузка {util}%"
    except Exception:  # noqa: BLE001
        return "GPU: нет данных (nvidia-smi недоступен)"


def gpu_busy_message():
    busy = running(GPU_KINDS)
    if busy:
        r = busy[0]
        return f"⛔ Видеокарта занята: идёт {KIND_RU[r['kind']]} «{r['name']}». Дождитесь окончания или остановите."
    return None


def elapsed(run):
    s = int(time.time() - run["started"])
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


# ───────────────────────── 0. Обзор и план ─────────────────────────

DOCS = ROOT / "docs"
STATUS_ICON = {"done": "✅", "progress": "🟡", "todo": "⬜"}
STATUS_RU = {"done": "готово", "progress": "в работе", "todo": "не начато"}
STATUS_COLOR = {"done": "#16a34a", "progress": "#d97706", "todo": "#9ca3af"}

# Скорость на ноутбуке разработчика (i7-13650HX, 4 потока, Q4_K_M) — benchmark/board_speed.md
BASE_SPEED = {"4B": {"gen": 11.0, "pp": 45.0}, "2B": {"gen": 24.0, "pp": 110.0}}
# Процессоры доски: (множитель генерации, множитель чтения промпта) относительно ноутбука.
# Кроме первой строки — грубые ориентиры по открытым замерам llama.cpp, НЕ наши замеры.
BOARD_PRESETS = {
    "Ноутбук разработчика, i7-13650HX (наш замер)": (1.0, 1.0),
    "Современный x86: Core i5/i7 12–13 пок., 2 канала памяти": (0.8, 0.8),
    "Бюджетный x86: Intel N100/N200, 1 канал памяти": (0.45, 0.35),
    "ARM: Rockchip RK3588 (частый в Android-досках)": (0.4, 0.25),
    "Старый ARM: RK3399 / Cortex-A73": (0.15, 0.1),
}
# Размер типичных задач в токенах: (прочитать, сгенерировать) — из наших прогонов
WORKLOADS = [
    ("Урок ru: 6 заданий + 6 слайдов", [(2271, 860), (498, 1054)], "алгебра §1"),
    ("Урок kk: 6 заданий + 6 слайдов", [(2677, 889), (498, 1551)], "физика §7"),
    ("Только 6 заданий (ru)", [(2271, 860)], "алгебра §1"),
    ("Слайды в формате контракта v1 (6 шт., с координатами)", [(498, 2616)], "расчёт: 436 ток. на слайд"),
    ("Короткий ответ на вопрос", [(50, 60)], "медиана бенчмарка"),
    ("Ответ с поиском по учебнику (RAG)", [(1030, 70)], "медиана бенчмарка"),
]
TESSERACT_MIN = 13.7  # физика kk, 240 стр., 4 потока — самая долгая из трёх книг


def fmt_time(s):
    if s < 60:
        return f"{s:.0f} с"
    return f"{s / 60:.1f} мин".replace(".0 мин", " мин")


def board_estimate(model, gen_f, pp_f):
    gen, pp = BASE_SPEED[model]["gen"] * gen_f, BASE_SPEED[model]["pp"] * pp_f
    rows = [f"**Модель {model}:** генерация ≈ **{gen:.1f} ток/с**, чтение промпта ≈ **{pp:.0f} ток/с**\n",
            "| Операция | Время на доске | Откуда цифры |", "|---|---:|---|"]
    for name, parts, src in WORKLOADS:
        t = sum(p / pp + g / gen for p, g in parts)
        first = parts[0][0] / pp  # до первого слова (при стриминге учитель видит текст с этого момента)
        rows.append(f"| {name} | **{fmt_time(t)}** (первое слово через {fmt_time(first)}) | {src} |")
    rows.append(f"| Загрузка учебника 240 стр. (Tesseract) | **~{fmt_time(TESSERACT_MIN * 60 / pp_f)}** | физика kk |")
    verdict = sum(p / pp + g / gen for p, g in WORKLOADS[1][1]) / 60
    if verdict <= 3:
        rows.append("\n🟢 Урок можно генерировать прямо на уроке.")
    elif verdict <= 8:
        rows.append("\n🟡 Урок лучше готовить заранее или показывать текст по мере генерации (стриминг).")
    else:
        rows.append("\n🔴 Урок «при учителе» — слишком долго: только подготовка заранее в фоне "
                    "(например, накануне) + стриминг. Для коротких ответов скорости хватает.")
    rows.append("\n*Время = токены промпта ÷ скорость чтения + токены ответа ÷ скорость генерации. "
                "Для всех процессоров, кроме первого, — оценка, не замер.*")
    return "\n".join(rows)


def apply_preset(name):
    g, p = BOARD_PRESETS[name]
    return g, p


def load_plan():
    try:
        return json.loads((DOCS / "plan.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {"stages": [], "next": [], "error": str(e)}


def bar(percent, color):
    return (f'<div style="background:var(--border-color-primary);border-radius:6px;height:10px;overflow:hidden">'
            f'<div style="width:{percent}%;height:100%;background:{color}"></div></div>')


def plan_html():
    plan = load_plan()
    if plan.get("error"):
        return f"<p>⚠️ Не удалось прочитать docs/plan.json: {plan['error']}</p>"
    stages = plan["stages"]
    total = round(sum(s["percent"] for s in stages) / max(len(stages), 1))
    counts = {k: sum(s["status"] == k for s in stages) for k in STATUS_RU}
    out = [f'<div style="margin-bottom:14px"><b style="font-size:1.15em">Общий прогресс: {total}%</b> '
           f'<span style="opacity:.75">— готово {counts["done"]}, в работе {counts["progress"]}, '
           f'не начато {counts["todo"]} (план от {plan.get("updated", "?")})</span>{bar(total, "#3b82f6")}</div>']
    for i, s in enumerate(stages, 1):
        color = STATUS_COLOR[s["status"]]
        items = "".join(f"<li>✔️ {x}</li>" for x in s.get("done", [])) + \
            "".join(f"<li>▫️ {x}</li>" for x in s.get("todo", []))
        blocker = (f'<div style="margin-top:6px;color:#dc2626">⛔ Нужно от команды: {s["blocker"]}</div>'
                   if s.get("blocker") else "")
        out.append(
            f'<details style="border:1px solid var(--border-color-primary);border-left:4px solid {color};'
            f'border-radius:8px;padding:8px 12px;margin:6px 0">'
            f'<summary style="cursor:pointer"><b>{i}. {s["title"]}</b> — {STATUS_ICON[s["status"]]} '
            f'{STATUS_RU[s["status"]]}, {s["percent"]}%{bar(s["percent"], color)}</summary>'
            f'<ul style="margin:8px 0 0 0;padding-left:20px;list-style:none">{items}</ul>{blocker}</details>')
    if plan.get("next"):
        out.append('<h3 style="margin-top:18px">Следующие шаги</h3><ol>')
        for n in sorted(plan["next"], key=lambda x: x["priority"]):
            out.append(f'<li><b>{"🔥" * (4 - n["priority"])} {n["task"]}</b><br>'
                       f'<span style="opacity:.75">{n["why"]}</span></li>')
        out.append("</ol>")
    return "".join(out)


def count_lines(path):
    try:
        return sum(1 for l in path.open(encoding="utf-8") if l.strip())
    except OSError:
        return 0


def overview_cards():
    secs = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (ROOT / "data" / "sections").glob("*.json")}
    raw_pages = sum(count_lines(p) for p in (ROOT / "data" / "raw").glob("*.jsonl"))
    vlm_pages = sum(count_lines(p) for p in (ROOT / "data" / "vlm").glob("*.jsonl"))
    sft = {p.name: count_lines(p) for p in SFT.glob("*.jsonl")}
    lessons = sorted((ROOT / "data" / "lessons").glob("*.json"), key=lambda p: p.stat().st_mtime)
    last = ""
    if lessons:
        d = json.loads(lessons[-1].read_text(encoding="utf-8"))
        t = sum(x["total_s"] for x in d.get("timings", {}).values())
        last = f"последний: {d['title'][:40]}… за {fmt_time(t)}"
    best = "—"
    try:
        df = results_table()
        if "всего" in df:
            vals = [int(v[:-1]) for v in df["всего"] if isinstance(v, str) and v.endswith("%")]
            best = f"{max(vals)}%" if vals else "—"
    except Exception:  # noqa: BLE001
        pass
    srv = server_run()
    cards = [
        ("📚", "Учебники", f"{len(secs)}", f"{sum(len(v) for v in secs.values())} параграфов, {raw_pages} стр. распознано"),
        ("🔍", "Точный текст (зрение)", f"{vlm_pages} стр.", "формулы в LaTeX — для обучения"),
        ("🗂", "Данные для обучения", f"{sum(sft.values())}",
         "примеров" + (" — пока только тестовые" if sum(sft.values()) < 200 else "")),
        ("📦", "Модели для доски", f"{len(ggufs())}", ", ".join(g.replace("-Q4_K_M.gguf", "") for g in ggufs())[:60]),
        ("🎯", "Лучший балл бенчмарка", best, "30 вопросов kk/ru/en, оценка предварительная"),
        ("✨", "Готовых уроков", f"{len(lessons)}", last),
        ("🖥", "Сервер модели", "работает" if srv else "выключен",
         srv["name"] if srv else "запуск — вкладка «5. Сервер и урок»"),
    ]
    html = ['<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px">']
    for icon, title, value, sub in cards:
        html.append(f'<div style="border:1px solid var(--border-color-primary);border-radius:10px;padding:10px 12px;'
                    f'background:var(--block-background-fill)"><div style="opacity:.75">{icon} {title}</div>'
                    f'<div style="font-size:1.5em;font-weight:700;margin:2px 0">{value}</div>'
                    f'<div style="font-size:.85em;opacity:.7">{sub}</div></div>')
    html.append("</div>")
    return "".join(html)


def status_report():
    try:
        return (DOCS / "STATUS.md").read_text(encoding="utf-8")
    except OSError:
        return "Отчёт docs/STATUS.md не найден."


SCENARIO_HTML = """
<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin:6px 0 4px">
""" + "".join(
    f'<div style="flex:1 1 150px;border:1px solid var(--border-color-primary);border-radius:10px;padding:10px">'
    f'<div style="font-size:1.4em">{i}</div><b>{t}</b><div style="font-size:.85em;opacity:.75">{d}</div></div>'
    for i, t, d in [
        ("1️⃣", "Учитель загружает PDF", "один раз на учебник"),
        ("2️⃣", "Доска распознаёт текст", "Tesseract, ~6–14 мин на ноутбуке"),
        ("3️⃣", "Делит на параграфы", "§ ↔ страницы, автоматически"),
        ("4️⃣", "Учитель выбирает §", "из списка"),
        ("5️⃣", "ИИ готовит урок", "задания + слайды, 4–8 мин на ноутбуке"),
    ]) + "</div>"

GLOSSARY = """
| Термин | Простыми словами |
|---|---|
| **Токен** | Кусочек слова, в котором модель считает текст. Русский: ~2.7 символа на токен, казахский: ~2 — поэтому казахский медленнее. |
| **ток/с** | Скорость модели: сколько токенов в секунду она читает (промпт) или пишет (генерация). |
| **Промпт** | Всё, что модель читает перед ответом: инструкция + текст параграфа. |
| **GGUF, Q4_K_M** | Формат одного файла модели для доски. Q4 — сжатие до ~4 бит на число: 2.6 ГБ вместо ~8 ГБ, качество почти то же. |
| **mmap** | Способ загрузки файла модели. На доске его выключаем: иначе в памяти две копии весов (+1.5 ГБ). |
| **Дообучение (LoRA, QLoRA)** | Модель учится на наших примерах, меняя маленькую «надстройку» (~100 МБ), а не всю модель. |
| **Loss** | Ошибка модели на обучающих примерах. Должна снижаться. |
| **RAG** | Перед ответом модель ищет подходящие фрагменты учебника и отвечает по ним — меньше выдумок. |
| **Бенчмарк** | Фиксированный набор вопросов с эталонами, чтобы сравнивать модели в цифрах. |
| **LLM-судья** | Модель, которая сравнивает ответ с эталоном и ставит 0/1/2. Оценка предварительная — окончательную ставит человек. |
| **Tesseract** | Бесплатная программа распознавания текста со сканов (OCR). Работает на процессоре доски. |
"""


def intro(what, do, get, when):
    """Одинаковая подсказка вверху каждой вкладки: зачем, что делать, что получится, сколько ждать."""
    return gr.Markdown(f"> **Зачем:** {what}  \n> **Что делать:** {do}  \n> **Что получится:** {get}  \n"
                       f"> **Сколько ждать:** {when}")


# ───────────────────────── 1. Данные ─────────────────────────

def dataset_files():
    SFT.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in SFT.glob("*.jsonl"))


def load_dataset_rows(name):
    rows, errors = [], []
    for i, line in enumerate((SFT / name).open(encoding="utf-8"), 1):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
            msgs = r["messages"]
            assert msgs[-1]["role"] == "assistant", "последнее сообщение должно быть от assistant"
            user = next(m["content"] for m in msgs if m["role"] == "user")
            rows.append({"язык": r.get("lang", ""), "вопрос": user, "ответ": msgs[-1]["content"]})
        except Exception as e:  # noqa: BLE001
            errors.append(f"строка {i}: {e}")
    return rows, errors


def show_dataset(name):
    if not name:
        return "Датасетов пока нет — загрузите CSV или JSONL ниже.", pd.DataFrame()
    rows, errors = load_dataset_rows(name)
    df = pd.DataFrame(rows)
    by_lang = df["язык"].value_counts().to_dict() if len(df) else {}
    avg_q = int(df["вопрос"].str.len().mean()) if len(df) else 0
    avg_a = int(df["ответ"].str.len().mean()) if len(df) else 0
    info = (f"**{name}** — {len(df)} примеров. По языкам: "
            + (", ".join(f"{k or '?'}: {v}" for k, v in by_lang.items()) or "—")
            + f". Средняя длина: вопрос {avg_q} симв., ответ {avg_a} симв.")
    if errors:
        info += f"\n\n⚠️ Ошибки формата ({len(errors)}): " + "; ".join(errors[:5])
    if len(df) < 200:
        info += ("\n\n💡 Для заметного эффекта от обучения обычно нужны сотни–тысячи примеров. "
                 "50 примеров хватает только для проверки, что всё работает.")
    return info, df


def upload_dataset(file, new_name):
    if not file:
        return "Выберите файл.", gr.Dropdown()
    src = Path(file)
    name = (re.sub(r"[^\w.-]+", "_", new_name.strip()) if new_name.strip() else src.stem) + ".jsonl"
    SFT.mkdir(parents=True, exist_ok=True)
    out = SFT / name
    if out.exists():
        return f"⛔ Файл {name} уже есть — укажите другое имя.", gr.Dropdown()
    text = src.read_text(encoding="utf-8-sig")
    records, errors = [], []
    if src.suffix.lower() == ".csv":
        # CSV из Excel/Google Таблиц: колонки lang, question, answer (разделитель , или ;)
        dialect = csv.Sniffer().sniff(text.splitlines()[0], delimiters=",;\t")
        for i, row in enumerate(csv.DictReader(io.StringIO(text), dialect=dialect), 2):
            row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
            lang, q, a = row.get("lang", ""), row.get("question", ""), row.get("answer", "")
            if lang not in SYSTEM_PROMPT or not q or not a:
                errors.append(f"строка {i}: нужны lang (kk/ru/en), question, answer")
                continue
            records.append({"lang": lang, "messages": [
                {"role": "system", "content": SYSTEM_PROMPT[lang]},
                {"role": "user", "content": q}, {"role": "assistant", "content": a}]})
    else:
        for i, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
                assert r["messages"][-1]["role"] == "assistant"
                records.append(r)
            except Exception:  # noqa: BLE001
                errors.append(f"строка {i}: нужен {{\"messages\": [..., {{\"role\": \"assistant\", ...}}]}}")
    if not records:
        return "⛔ Не найдено ни одного корректного примера. " + "; ".join(errors[:5]), gr.Dropdown()
    with open(out, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    msg = f"✅ Сохранено {len(records)} примеров в data/sft/{name}."
    if errors:
        msg += f" Пропущено строк с ошибками: {len(errors)} ({'; '.join(errors[:3])})"
    return msg, gr.Dropdown(choices=dataset_files(), value=name)


# ───────────────────────── 2. Обучение ─────────────────────────

LOSS_RE = re.compile(r"\{'loss': '([\d.]+)'.*?'epoch': '([\d.]+)'\}")
STEP_RE = re.compile(r"(\d+)/(\d+) \[")


def start_training(base, dataset, name, epochs, lr, lora_r, batch, accum, seq_len):
    if msg := gpu_busy_message():
        return msg
    if not dataset:
        return "⛔ Выберите датасет."
    name = re.sub(r"[^\w.-]+", "_", name.strip() or f"lora_{datetime.datetime.now():%m%d_%H%M}")
    out = MODELS / name
    if out.exists():
        return f"⛔ Модель models/{name} уже есть — укажите другое имя."
    start_job("train", name, [
        PY, ROOT / "scripts" / "finetune.py", "--model", base, "--data", SFT / dataset, "--output", out,
        "--epochs", epochs, "--lr", lr, "--lora-r", int(lora_r), "--lora-alpha", int(lora_r),
        "--batch-size", int(batch), "--grad-accum", int(accum), "--max-seq-length", int(seq_len)])
    return f"▶️ Обучение «{name}» запущено. Прогресс обновляется ниже каждые несколько секунд."


def training_status():
    runs = list_runs("train")
    if not runs:
        return "Обучение ещё не запускалось.", pd.DataFrame({"шаг": [], "loss": []}), "", gpu_status()
    r = runs[0]
    log = (r["dir"] / "log.txt").read_text(encoding="utf-8", errors="replace") if (r["dir"] / "log.txt").exists() else ""
    losses = [float(m.group(1)) for m in LOSS_RE.finditer(log)]
    # прогресс-бары загрузки весов и подготовки данных идут раньше — шаги считаем после старта обучения
    train_log = log.split("Trainable parameters", 1)[1] if "Trainable parameters" in log else ""
    steps = STEP_RE.findall(train_log)
    metrics_path = MODELS / r["name"] / "train_metrics.json"
    if r["alive"]:
        if not train_log:
            prog = " — загрузка модели и подготовка данных…"
        elif not steps or steps[-1][0] == "0":
            prog = " — первый шаг (компиляция, обычно 1–2 мин)…"
        else:
            prog = f" — шаг {steps[-1][0]} из {steps[-1][1]}"
        status = f"⏳ Идёт обучение «{r['name']}»{prog}, прошло {elapsed(r)}."
    elif metrics_path.exists():
        m = json.loads(metrics_path.read_text(encoding="utf-8"))
        status = (f"✅ Обучение «{r['name']}» завершено за {m['train_time_s']:.0f} с: {m['steps']} шагов, "
                  f"итоговый loss {m['final_loss']}, пик видеопамяти {m['peak_vram_gb']} ГБ, "
                  f"{m['samples_per_s']} примеров/с. Адаптер: models/{r['name']}. "
                  f"Следующий шаг — вкладка «Экспорт».")
    else:
        status = f"❌ Обучение «{r['name']}» остановлено или завершилось с ошибкой — смотрите лог."
    df = pd.DataFrame({"шаг": list(range(1, len(losses) + 1)), "loss": losses})
    return status, df, tail(r["dir"] / "log.txt", 25), gpu_status()


def stop_training():
    runs = [r for r in list_runs("train") if r["alive"]]
    for r in runs:
        stop_run(r)
    return "⏹ Остановлено." if runs else "Нечего останавливать."


# ───────────────────────── 3. Экспорт ─────────────────────────

def adapters():
    return sorted(p.parent.name for p in MODELS.glob("*/adapter_config.json"))


def ggufs():
    return sorted(p.name for p in MODELS.glob("*.gguf"))


def start_export(adapter, name, quant):
    if msg := gpu_busy_message():
        return msg
    if not adapter:
        return "⛔ Выберите обученный адаптер."
    name = re.sub(r"[^\w.-]+", "_", name.strip() or adapter)
    if (MODELS / f"{name}-{quant}.gguf").exists():
        return f"⛔ models/{name}-{quant}.gguf уже есть — укажите другое имя."
    start_job("export", name, [PY, ROOT / "scripts" / "export_gguf.py", "--adapter", MODELS / adapter,
                               "--name", name, "--quant", quant, "--rm-merged"])
    return f"▶️ Экспорт «{name}» запущен (обычно 3–5 минут)."


def export_status():
    runs = list_runs("export")
    if not runs:
        return "Экспорт ещё не запускался.", ""
    r = runs[0]
    log = tail(r["dir"] / "log.txt", 100000)  # этап ищем по всему логу: конвертер печатает тысячи строк
    if r["alive"]:
        stage = ("квантование" if "llama-quantize" in log else "конвертация в GGUF" if "convert_hf_to_gguf" in log
                 else "слияние адаптера с базой")
        status = f"⏳ Экспорт «{r['name']}»: {stage}, прошло {elapsed(r)}."
    elif m := re.search(r"Готово: (.+?\.gguf) \(([\d.]+) GiB\)", log):
        status = f"✅ Готово: {Path(m.group(1)).name} ({m.group(2)} ГБ). Его можно запустить на вкладке «Сервер и урок»."
    else:
        status = f"❌ Экспорт «{r['name']}» остановлен или упал — смотрите лог."
    return status, "\n".join(log.splitlines()[-25:])


# ───────────────────────── 4. Проверка ─────────────────────────

def bench_models():
    return BASE_MODELS + [f"models/{a}" for a in adapters()]


def start_bench(model, use_rag):
    if msg := gpu_busy_message():
        return msg
    cmd = [PY, BENCH / "run_bench.py", "--model", model if model in BASE_MODELS else ROOT / model,
           "--max-seq-length", "4096"]
    if use_rag:
        cmd.append("--rag")
    start_job("bench", Path(model).name + ("_rag" if use_rag else ""), cmd)
    return "▶️ Бенчмарк запущен: 30 вопросов, обычно 3–5 минут."


def start_score(results_name):
    if not results_name:
        return "⛔ Выберите результаты."
    if not server_run():
        return "⛔ Для оценки нужен запущенный сервер модели (вкладка «Сервер и урок»)."
    start_job("score", results_name, [PY, BENCH / "score.py", BENCH / results_name])
    return "▶️ Оценка судьёй запущена (~3 мин на 30 ответов). Итог появится в таблице."


def results_files():
    return sorted((p.name for p in BENCH.glob("results_*.jsonl")), reverse=True)


def results_table():
    rows = []
    for name in results_files():
        recs = [json.loads(l) for l in (BENCH / name).open(encoding="utf-8")]
        row = {"прогон": name.replace("results_", "").replace(".jsonl", ""), "вопросов": len(recs),
               "ток/с": round(sum(r["new_tokens"] for r in recs) / max(sum(r["gen_time_s"] for r in recs), 1e-9), 1)}
        scores = BENCH / name.replace("results_", "scores_").replace(".jsonl", ".csv")
        if scores.exists():
            sc = list(csv.DictReader(scores.open(encoding="utf-8-sig")))
            for lang in ("kk", "ru", "en", None):
                vals = [float(r["human_score"] or r["judge_score"]) for r in sc
                        if (lang is None or r["lang"] == lang) and (r["human_score"] or r["judge_score"]) != ""]
                row[lang or "всего"] = f"{100 * sum(vals) / (2 * len(vals)):.0f}%" if vals else "—"
            row["проверено вручную"] = sum(1 for r in sc if r["human_score"])
        rows.append(row)
    df = pd.DataFrame(rows)
    if "проверено вручную" in df:
        df["проверено вручную"] = df["проверено вручную"].map(lambda v: "—" if pd.isna(v) else int(v))
    return df.fillna("—")


def show_results(name):
    if not name:
        return pd.DataFrame()
    recs = [json.loads(l) for l in (BENCH / name).open(encoding="utf-8")]
    scores = BENCH / name.replace("results_", "scores_").replace(".jsonl", ".csv")
    sc = {r["id"]: r for r in csv.DictReader(scores.open(encoding="utf-8-sig"))} if scores.exists() else {}
    return pd.DataFrame([{"id": r["id"], "язык": r["lang"], "вопрос": r["question"], "эталон": r["reference_answer"],
                          "ответ модели": r["answer"], "судья (0–2)": sc.get(r["id"], {}).get("judge_score", ""),
                          "человек": sc.get(r["id"], {}).get("human_score", "")} for r in recs])


def bench_status():
    runs = [r for r in list_runs() if r["kind"] in ("bench", "score")]
    if not runs:
        return "Бенчмарк ещё не запускался.", ""
    r = runs[0]
    log = tail(r["dir"] / "log.txt", 400)
    done = re.findall(r"\[(\d+)/(\d+)\]", log)
    what = KIND_RU[r["kind"]]
    if r["alive"]:
        status = f"⏳ Идёт {what} «{r['name']}»: " + (f"{done[-1][0]} из {done[-1][1]}" if done else "загрузка…")
    elif "Готово" in log or "Средний балл" in log:
        status = f"✅ {what.capitalize()} «{r['name']}» завершён(а). Таблица обновлена."
    else:
        status = f"❌ {what.capitalize()} «{r['name']}» остановлен(а) или упал(а) — смотрите лог."
    return status, "\n".join(log.splitlines()[-15:])


# ───────────────────────── 5. Сервер и урок ─────────────────────────

def server_run():
    return next((r for r in list_runs("server") if r["alive"]), None)


def start_server_env(gguf):
    # serve.sh берёт модель из переменной MODEL — задаём её только для дочернего процесса
    if server_run():
        return "Сервер уже запущен."
    if not gguf:
        return "⛔ Выберите модель."
    os.environ["MODEL"] = str(MODELS / gguf)
    try:
        start_job("server", gguf, [ROOT / "scripts" / "serve.sh"])
    finally:
        os.environ.pop("MODEL", None)
    return f"▶️ Сервер с {gguf} запускается (несколько секунд)…"


def stop_server():
    r = server_run()
    if r:
        stop_run(r)
        return "⏹ Сервер остановлен."
    return "Сервер не запущен."


def server_status():
    r = server_run()
    if not r:
        return "⚪ Сервер не запущен."
    try:
        import requests
        ok = requests.get("http://127.0.0.1:8080/health", timeout=2).json().get("status") == "ok"
    except Exception:  # noqa: BLE001
        ok = False
    return (f"🟢 Сервер работает: {r['name']} (http://127.0.0.1:8080/v1), CPU 4 потока, как на доске."
            if ok else f"🟡 Сервер {r['name']} загружает модель…")


def books():
    return sorted(p.stem for p in (ROOT / "data" / "sections").glob("*.json"))


def sections_of(book):
    if not book:
        return gr.Dropdown(choices=[])
    secs = json.loads((ROOT / "data" / "sections" / f"{book}.json").read_text(encoding="utf-8"))
    choices = [(f"§{s['num']} {s['title'][:60]} (стр. {s['page_start']}–{s['page_end']})", s["num"]) for s in secs]
    return gr.Dropdown(choices=choices, value=choices[0][1] if choices else None)


def start_lesson(book, section, what, n_tasks, n_slides):
    if not server_run():
        return "⛔ Сначала запустите сервер модели (слева)."
    if running({"lesson"}):
        return "⛔ Урок уже генерируется — дождитесь окончания."
    if not book or not section:
        return "⛔ Выберите учебник и параграф."
    start_job("lesson", f"{book}_§{section}", [
        PY, ROOT / "scripts" / "lesson.py", book, "--section", section, "--what", what,
        "--n-tasks", int(n_tasks), "--n-slides", int(n_slides)])
    return "▶️ Урок генерируется. На CPU это несколько минут — результат появится ниже."


TYPE_RU = {"test": "тест", "open": "открытый вопрос", "calc": "задача"}


def render_lesson(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    md = [f"## {d['title']}", f"*Стр. {d['pages'][0]}–{d['pages'][1]}, язык: {d['lang']}, "
          f"текст: {'распознан моделью со зрением' if d['text_source'] == 'vlm' else 'Tesseract'}*"]
    for what, t in d.get("timings", {}).items():
        md.append(f"*{'Задания' if what == 'tasks' else 'Слайды'}: {t['total_s']} с "
                  f"(чтение {t['prompt_s']} с, генерация {t['gen_tokens']} ток. за {t['gen_s']} с)*")
    if d.get("tasks"):
        md.append("\n### Задания")
        for i, t in enumerate(d["tasks"], 1):
            md.append(f"**{i}. [{TYPE_RU.get(t['type'], t['type'])}, уровень {t['level']}]** {t['question']}")
            for j, o in enumerate(t.get("options") or []):
                md.append(f"   {'ABCD'[j] if j < 4 else '-'}) {o}")
            warn = ""
            if t["type"] == "calc":
                warn = "  ⚠️ *проверьте расчёт*"
            elif t.get("options") and t["answer"].strip() not in [o.strip() for o in t["options"]]:
                warn = "  ⚠️ *ответ не совпадает ни с одним вариантом*"
            md.append(f"   ✔️ *Ответ:* {t['answer']}{warn}")
            md.append("")
    if d.get("slides"):
        md.append("\n### Слайды")
        for i, s in enumerate(d["slides"], 1):
            md.append(f"**Слайд {i}. {s['title']}**")
            md += [f"- {b}" for b in s["bullets"]]
            md.append(f"  \n  🗒 *{s['notes']}*\n")
    return "\n".join(md)


def lesson_status():
    runs = list_runs("lesson")
    if not runs:
        return "", ""
    r = runs[0]
    log = tail(r["dir"] / "log.txt", 50)
    if r["alive"]:
        return f"⏳ Генерируется «{r['name']}», прошло {elapsed(r)}…\n\n```\n{log}\n```", ""
    m = re.search(r"→ (.+\.json)", log)
    if m and Path(m.group(1)).exists():
        return f"✅ Готово — файл `data/lessons/{Path(m.group(1)).name}`", render_lesson(m.group(1))
    return f"❌ Ошибка при генерации «{r['name']}»:\n\n```\n{log[-1500:]}\n```", ""


# ───────────────────────── интерфейс ─────────────────────────

HELP = {
    "epochs": "Сколько раз модель пройдёт по всему датасету. 1–3 обычно достаточно; больше — риск «зазубрить» примеры.",
    "lr": "Скорость обучения. 2e-4 — стандарт для LoRA. Если loss скачет или растёт — уменьшите (1e-4).",
    "lora_r": "«Ёмкость» дообучения. 16 — хороший старт; 32–64 — больше возможностей, но дольше и больше памяти.",
    "batch": "Сколько примеров за раз на видеокарте. Если не хватает памяти — уменьшите до 1.",
    "accum": "Накопление шагов: эффективный размер пакета = batch × это число (по умолчанию 2 × 4 = 8).",
    "seq": "Максимальная длина примера в токенах. Длинные примеры (с текстом параграфа) — 2048–4096.",
}


def build():
    with gr.Blocks(title="Matrix Smartboard — обучение модели") as app:
        gr.Markdown("# 🧠 Matrix Smartboard — ИИ-помощник учителя\n"
                    "Здесь готовится модель для интерактивной доски: она работает **без интернета и видеокарты** "
                    "и по параграфу учебника делает задания и слайды на казахском, русском и английском.  \n"
                    "Начните с вкладки **🏠 Обзор и план**. Рабочий порядок: **1. Данные → 2. Обучение → "
                    "3. Экспорт → 4. Проверка → 5. Урок**. Задачи работают в фоне: страницу можно закрыть.")
        gpu = gr.Markdown(gpu_status())

        # 0. Обзор и план
        with gr.Tab("🏠 Обзор и план"):
            gr.Markdown("### Как это будет работать на доске")
            gr.HTML(SCENARIO_HTML)
            gr.Markdown("### Что готово сейчас")
            o_cards = gr.HTML(overview_cards())
            gr.Markdown("### План работ\nНажмите на этап, чтобы увидеть, что сделано (✔️) и что осталось (▫️). "
                        "План хранится в `docs/plan.json`.")
            o_plan = gr.HTML(plan_html())
            gr.Markdown("### ⏱ Сколько это займёт на доске\n"
                        "Процессор доски пока неизвестен. Выберите похожий — таблица пересчитается. "
                        "Ползунками можно задать свой: 1.0 = как ноутбук разработчика, 0.5 = в 2 раза медленнее.")
            with gr.Row():
                with gr.Column(scale=1):
                    o_preset = gr.Dropdown(list(BOARD_PRESETS), value=list(BOARD_PRESETS)[3],
                                           label="Процессор доски")
                    o_model = gr.Radio(["4B", "2B"], value="4B", label="Модель",
                                       info="4B — точнее; 2B — в 2 раза быстрее, но чаще выдумывает факты")
                    o_gen = gr.Slider(0.05, 1.5, BOARD_PRESETS[list(BOARD_PRESETS)[3]][0], step=0.05,
                                      label="Скорость генерации относительно ноутбука",
                                      info="Зависит в основном от скорости памяти")
                    o_pp = gr.Slider(0.05, 1.5, BOARD_PRESETS[list(BOARD_PRESETS)[3]][1], step=0.05,
                                     label="Скорость чтения промпта относительно ноутбука",
                                     info="Зависит в основном от мощности ядер")
                with gr.Column(scale=2):
                    o_est = gr.Markdown(board_estimate("4B", *BOARD_PRESETS[list(BOARD_PRESETS)[3]]))
            with gr.Accordion("📄 Подробный отчёт: что сделано, тайминги, прогноз, что предстоит", open=False):
                gr.Markdown(status_report())
            with gr.Accordion("📖 Словарик терминов", open=False):
                gr.Markdown(GLOSSARY)
            o_refresh = gr.Button("🔄 Обновить состояние и план", size="sm")
            o_preset.change(apply_preset, o_preset, [o_gen, o_pp])
            for c in (o_model, o_gen, o_pp):
                c.change(board_estimate, [o_model, o_gen, o_pp], o_est)
            o_refresh.click(lambda: (overview_cards(), plan_html()), None, [o_cards, o_plan])
            app.load(lambda: (overview_cards(), plan_html()), None, [o_cards, o_plan])

        # 1. Данные
        with gr.Tab("1. 📚 Данные"):
            intro("модель учится на примерах «вопрос → ответ». Чем больше хороших примеров (особенно на казахском), "
                  "тем лучше она отвечает.",
                  "подготовьте таблицу в Excel или Google Таблицах с колонками **lang** (kk / ru / en), "
                  "**question**, **answer**, сохраните как CSV и загрузите ниже.",
                  "датасет, который можно выбрать на вкладке «Обучение».", "секунды.")
            with gr.Row():
                ds = gr.Dropdown(dataset_files(), value=(dataset_files() or [None])[0], label="Датасет", scale=3)
                ds_refresh = gr.Button("🔄", scale=0)
            ds_info = gr.Markdown()
            ds_table = gr.Dataframe(wrap=True, max_height=400)
            with gr.Accordion("⬆️ Загрузить новый датасет (CSV или JSONL)", open=False):
                up_file = gr.File(file_types=[".csv", ".jsonl"], type="filepath", label="Файл")
                up_name = gr.Textbox(label="Имя датасета (необязательно)", placeholder="например: physics_kk_v1")
                up_btn = gr.Button("Загрузить", variant="primary")
                up_msg = gr.Markdown()
            ds.change(show_dataset, ds, [ds_info, ds_table])
            ds_refresh.click(lambda: gr.Dropdown(choices=dataset_files()), None, ds)
            up_btn.click(upload_dataset, [up_file, up_name], [up_msg, ds])
            app.load(show_dataset, ds, [ds_info, ds_table])

        # 2. Обучение
        with gr.Tab("2. 🎓 Обучение"):
            intro("дообучить модель на ваших примерах, чтобы она лучше писала по-казахски и в нужном стиле.",
                  "выберите датасет, придумайте имя и нажмите «Начать». Параметры можно не трогать.",
                  "«адаптер» в папке models/ — небольшая надстройка над моделью. Дальше — вкладка «Экспорт».",
                  "50 примеров — ~2 мин, 1000 примеров — ориентировочно 10–30 мин (видеокарта).")
            with gr.Row():
                with gr.Column(scale=1):
                    t_base = gr.Dropdown(BASE_MODELS, value=BASE_MODELS[0], label="Базовая модель")
                    t_ds = gr.Dropdown(dataset_files(), value=(dataset_files() or [None])[0], label="Датасет")
                    t_name = gr.Textbox(label="Имя новой модели", placeholder="например: physics_kk_v1")
                    with gr.Accordion("Параметры (можно не трогать)", open=False):
                        t_epochs = gr.Number(1, label="Эпохи", info=HELP["epochs"])
                        t_lr = gr.Number(2e-4, label="Скорость обучения", info=HELP["lr"])
                        t_r = gr.Slider(8, 64, 16, step=8, label="LoRA r", info=HELP["lora_r"])
                        t_batch = gr.Slider(1, 8, 2, step=1, label="Размер пакета", info=HELP["batch"])
                        t_accum = gr.Slider(1, 16, 4, step=1, label="Накопление", info=HELP["accum"])
                        t_seq = gr.Dropdown([1024, 2048, 4096], value=2048, label="Макс. длина", info=HELP["seq"])
                    with gr.Row():
                        t_start = gr.Button("▶️ Начать обучение", variant="primary")
                        t_stop = gr.Button("⏹ Остановить", variant="stop")
                    t_msg = gr.Markdown()
                with gr.Column(scale=2):
                    t_status = gr.Markdown()
                    t_plot = gr.LinePlot(x="шаг", y="loss", title="Loss (ошибка модели) — должна снижаться",
                                         height=260)
                    with gr.Accordion("Лог", open=False):
                        t_log = gr.Code(language=None, lines=14)
            t_start.click(start_training, [t_base, t_ds, t_name, t_epochs, t_lr, t_r, t_batch, t_accum, t_seq], t_msg)
            t_stop.click(stop_training, None, t_msg)
            ds.change(lambda: gr.Dropdown(choices=dataset_files()), None, t_ds)
            up_btn.click(lambda: gr.Dropdown(choices=dataset_files()), None, t_ds)

        # 3. Экспорт
        with gr.Tab("3. 📦 Экспорт"):
            intro("доске нужен один сжатый файл модели (GGUF), который работает без видеокарты.",
                  "выберите обученный адаптер и нажмите «Экспортировать». Сжатие оставьте Q4_K_M.",
                  "файл models/<имя>-Q4_K_M.gguf (~2.6 ГБ для 4B). Q5_K_M / Q8_0 — точнее, но больше и медленнее.",
                  "около 5 минут.")
            with gr.Row():
                e_adapter = gr.Dropdown(adapters(), label="Обученный адаптер", scale=3)
                e_refresh = gr.Button("🔄", scale=0)
            e_name = gr.Textbox(label="Имя файла (необязательно)")
            e_quant = gr.Radio(["Q4_K_M", "Q5_K_M", "Q8_0"], value="Q4_K_M", label="Сжатие")
            e_start = gr.Button("📦 Экспортировать", variant="primary")
            e_msg, e_status = gr.Markdown(), gr.Markdown()
            with gr.Accordion("Лог", open=False):
                e_log = gr.Code(language=None, lines=14)
            e_refresh.click(lambda: gr.Dropdown(choices=adapters()), None, e_adapter)
            e_start.click(start_export, [e_adapter, e_name, e_quant], e_msg)

        # 4. Проверка
        with gr.Tab("4. 🧪 Проверка"):
            intro("сравнить модели в цифрах: стало ли лучше после обучения, помогает ли поиск по текстам (RAG).",
                  "выберите модель → «Запустить бенчмарк». Потом запустите сервер (вкладка 5) и нажмите "
                  "«Оценить судьёй».",
                  "процент правильных ответов по языкам и ответы модели рядом с эталоном. Оценка судьёй "
                  "предварительная: окончательную ставит человек в колонке **human_score** файла "
                  "`benchmark/scores_*.csv`.",
                  "бенчмарк 3–5 мин, оценка ~3 мин.")
            with gr.Row():
                b_model = gr.Dropdown(bench_models(), value=BASE_MODELS[0], label="Модель", scale=3)
                b_refresh = gr.Button("🔄", scale=0)
                b_rag = gr.Checkbox(label="С поиском по текстам (RAG)")
                b_start = gr.Button("🧪 Запустить бенчмарк", variant="primary")
            b_msg, b_status = gr.Markdown(), gr.Markdown()
            b_table = gr.Dataframe(results_table(), label="Все прогоны (% от максимума по языкам)", interactive=False)
            with gr.Row():
                b_res = gr.Dropdown(results_files(), label="Посмотреть ответы прогона", scale=3)
                b_score = gr.Button("⚖️ Оценить судьёй (нужен сервер)")
            b_detail = gr.Dataframe(wrap=True, max_height=500, interactive=False)
            with gr.Accordion("Лог", open=False):
                b_log = gr.Code(language=None, lines=12)
            b_refresh.click(lambda: (gr.Dropdown(choices=bench_models()), gr.Dropdown(choices=results_files()),
                                     results_table()), None, [b_model, b_res, b_table])
            b_start.click(start_bench, [b_model, b_rag], b_msg)
            b_score.click(start_score, b_res, b_msg)
            b_res.change(show_results, b_res, b_detail)
            app.load(show_results, b_res, b_detail)  # та же история: первый прогон выбран без .change

        # 5. Сервер и урок
        with gr.Tab("5. ✨ Сервер и урок"):
            intro("проверить главный сценарий доски: учебник + параграф → задания и слайды.",
                  "слева запустите сервер (модель на процессоре, как на доске), справа выберите учебник, "
                  "параграф и нажмите «Сгенерировать».",
                  "задания с ответами (⚠️ — проверьте) и текст слайдов с формулами.",
                  "на ноутбуке 4–8 мин на урок (казахский дольше), на доске — см. калькулятор во вкладке «Обзор».")
            with gr.Row():
                with gr.Column(scale=1):
                    gr.Markdown("### Сервер модели\nЗапускает модель на процессоре, 4 потока — как на доске.")
                    s_model = gr.Dropdown(ggufs(), value="Qwen3.5-4B-Q4_K_M.gguf" if "Qwen3.5-4B-Q4_K_M.gguf" in ggufs()
                                          else None, label="Модель (GGUF)")
                    with gr.Row():
                        s_start = gr.Button("▶️ Запустить", variant="primary")
                        s_stop = gr.Button("⏹ Остановить", variant="stop")
                    s_msg, s_status = gr.Markdown(), gr.Markdown()
                with gr.Column(scale=2):
                    gr.Markdown("### Урок по параграфу\nЗадания и текст слайдов по выбранному параграфу учебника.")
                    # Gradio сам выбирает первый вариант, а .change при этом не срабатывает —
                    # поэтому параграфы первой книги заполняем сразу и ещё раз при загрузке страницы
                    first_book = (books() or [None])[0]
                    l_book = gr.Dropdown(books(), value=first_book, label="Учебник")
                    l_sec = sections_of(first_book) if first_book else gr.Dropdown([])
                    l_sec.label = "Параграф"
                    with gr.Row():
                        l_what = gr.Radio([("Задания и слайды", "both"), ("Только задания", "tasks"),
                                           ("Только слайды", "slides")], value="both", label="Что сделать")
                        l_nt = gr.Slider(3, 10, 6, step=1, label="Заданий")
                        l_ns = gr.Slider(3, 10, 6, step=1, label="Слайдов")
                    l_start = gr.Button("✨ Сгенерировать", variant="primary")
                    l_msg, l_status = gr.Markdown(), gr.Markdown()
            l_out = gr.Markdown(latex_delimiters=LATEX)
            s_start.click(start_server_env, s_model, s_msg)
            s_stop.click(stop_server, None, s_msg)
            l_book.change(sections_of, l_book, l_sec)
            app.load(sections_of, l_book, l_sec)
            l_start.click(start_lesson, [l_book, l_sec, l_what, l_nt, l_ns], l_msg)

        # периодическое обновление статусов
        timer = gr.Timer(3)
        timer.tick(training_status, None, [t_status, t_plot, t_log, gpu])
        timer.tick(export_status, None, [e_status, e_log])
        timer.tick(bench_status, None, [b_status, b_log])
        timer.tick(server_status, None, s_status)
        timer.tick(lesson_status, None, [l_status, l_out])
        slow = gr.Timer(15)  # таблица результатов меняется редко
        slow.tick(results_table, None, b_table)
    return app


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7860)
    a = ap.parse_args()
    build().launch(server_name=a.host, server_port=a.port, show_error=True)
