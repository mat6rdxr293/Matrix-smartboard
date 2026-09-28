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
        gr.Markdown("# 🧠 Matrix Smartboard — обучение и проверка модели\n"
                    "Порядок работы: **1. Данные → 2. Обучение → 3. Экспорт → 4. Проверка → 5. Урок**. "
                    "Задачи работают в фоне — страницу можно закрыть и открыть снова.")
        gpu = gr.Markdown(gpu_status())

        # 1. Данные
        with gr.Tab("1. Данные"):
            gr.Markdown("Данные для обучения — пары «вопрос → ответ». Удобнее всего готовить в Excel или "
                        "Google Таблицах: колонки **lang** (kk / ru / en), **question**, **answer**, "
                        "сохранить как CSV и загрузить сюда.")
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
        with gr.Tab("2. Обучение"):
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
        with gr.Tab("3. Экспорт"):
            gr.Markdown("Превращает обученный адаптер в один файл **GGUF** для доски (llama.cpp / Ollama). "
                        "Q4_K_M — основной вариант (~2.6 ГБ для 4B); Q5_K_M / Q8_0 — точнее, но больше и медленнее.")
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
        with gr.Tab("4. Проверка"):
            gr.Markdown("Бенчмарк — 30 вопросов по истории, биологии и физике (kk / ru / en). "
                        "Оценка судьёй — предварительная; окончательную ставит человек в колонке **human_score** "
                        "файла `benchmark/scores_*.csv`.")
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

        # 5. Сервер и урок
        with gr.Tab("5. Сервер и урок"):
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
                    l_book = gr.Dropdown(books(), label="Учебник")
                    l_sec = gr.Dropdown([], label="Параграф")
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
