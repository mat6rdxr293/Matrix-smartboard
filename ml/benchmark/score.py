"""Автооценка ответов бенчмарка: LLM-судья (локальная модель через OpenAI-совместимый API) + ручная колонка.

    scripts/serve.sh &                                       # llama-server на :8080 (или любой другой)
    python benchmark/score.py benchmark/results_Qwen3.5-4B_2026-09-26.jsonl
    python benchmark/score.py results_A.jsonl results_B.jsonl --summary-only   # только сводка

Выход: рядом с results_*.jsonl пишется scores_*.csv (открывается в Excel/LibreOffice/Google Sheets):
    id, lang, subject, grade, question, reference_answer, answer,
    judge_score (0 неверно / 1 частично / 2 верно), judge_reason, judge_model, judge_status="preliminary",
    human_score, human_comment   ← заполняются вручную; при повторном запуске сохраняются.

Оценки судьи ПРЕДВАРИТЕЛЬНЫЕ: судья — маленькая локальная модель, часто та же, что отвечала
(завышает свои ответы), а эталоны ещё не вычитаны. В сводке human_score, если заполнен,
имеет приоритет над judge_score.
"""
import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

import requests

FIELDS = ["id", "lang", "subject", "grade", "question", "reference_answer", "answer",
          "judge_score", "judge_reason", "judge_model", "judge_status", "human_score", "human_comment"]

JUDGE_SYSTEM = (
    "You are a strict school exam grader. You compare a student's answer with the reference answer. "
    "Questions and answers may be in Kazakh, Russian or English. Judge only factual correctness against "
    "the reference, not style or length. Extra correct details are fine; any contradicting fact "
    "(wrong date, name, number, formula) makes the answer wrong or partial."
)
JUDGE_USER = """Question: {question}

Reference answer: {reference}

Student answer: {answer}

Score the student answer:
2 = correct: contains the key facts of the reference and nothing that contradicts it;
1 = partially correct: some key facts right, but something is missing or wrong;
0 = wrong, off-topic or no answer.
Reply with JSON: {{"reason": "<one short sentence in English>", "score": 0|1|2}}"""

SCHEMA = {
    "type": "object",
    "properties": {"reason": {"type": "string"}, "score": {"type": "integer", "enum": [0, 1, 2]}},
    "required": ["reason", "score"],
}


def judge(api, model, q, timeout):
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": JUDGE_SYSTEM},
            {"role": "user", "content": JUDGE_USER.format(
                question=q["question"], reference=q["reference_answer"], answer=q["answer"][:2000])},
        ],
        "temperature": 0,
        "max_tokens": 200,
        "response_format": {"type": "json_schema", "json_schema": {"name": "grade", "schema": SCHEMA}},
        "chat_template_kwargs": {"enable_thinking": False},  # llama-server; другие серверы игнорируют
    }
    r = requests.post(f"{api}/chat/completions", json=body, timeout=timeout)
    r.raise_for_status()
    content = r.json()["choices"][0]["message"]["content"]
    res = json.loads(content)
    return int(res["score"]), res["reason"].strip()


def csv_path_for(results_path):
    p = Path(results_path)
    return p.with_name(p.name.replace("results_", "scores_", 1)).with_suffix(".csv")


def load_existing(path):
    if not path.exists():
        return {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {row["id"]: row for row in csv.DictReader(f)}


def score_file(results_path, api, model, timeout, rejudge):
    out = csv_path_for(results_path)
    old = load_existing(out)
    rows = []
    with open(results_path, encoding="utf-8") as f:
        results = [json.loads(line) for line in f if line.strip()]
    for i, q in enumerate(results, 1):
        prev = old.get(q["id"], {})
        row = {k: q.get(k, "") for k in FIELDS[:7]}
        row["human_score"] = prev.get("human_score", "")
        row["human_comment"] = prev.get("human_comment", "")
        # не гоняем судью повторно, если ответ тот же и оценка уже есть
        if not rejudge and prev.get("judge_score", "") != "" and prev.get("answer") == q["answer"]:
            row.update({k: prev[k] for k in ("judge_score", "judge_reason", "judge_model", "judge_status")})
        else:
            try:
                s, reason = judge(api, model, q, timeout)
            except Exception as e:  # noqa: BLE001 — один сбой не должен ронять весь файл
                s, reason = "", f"JUDGE ERROR: {e}"
            row.update({"judge_score": s, "judge_reason": reason, "judge_model": model,
                        "judge_status": "preliminary"})
        rows.append(row)
        print(f"  [{i}/{len(results)}] {q['id']}: judge={row['judge_score']} {row['judge_reason'][:70]}", flush=True)

    # utf-8-sig — чтобы Excel сразу открыл казахский/русский текст
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    return out, rows


def summarize(name, rows):
    """Средний балл в % от максимума (2), по языкам. human_score важнее judge_score."""
    agg = defaultdict(list)
    n_human = 0
    for r in rows:
        s = r["human_score"] if str(r["human_score"]).strip() != "" else r["judge_score"]
        n_human += str(r["human_score"]).strip() != ""
        if str(s).strip() == "":
            continue
        agg[r["lang"]].append(float(s))
        agg["all"].append(float(s))
    cells = {k: f"{100 * sum(v) / (2 * len(v)):.0f}% (n={len(v)})" for k, v in agg.items()}
    return (f"| {name} | {cells.get('kk', '-')} | {cells.get('ru', '-')} | {cells.get('en', '-')} | "
            f"**{cells.get('all', '-')}** | {n_human}/{len(rows)} |")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results", nargs="+", help="benchmark/results_*.jsonl")
    ap.add_argument("--api", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--judge-model", default="qwen3.5-4b-q4km", help="имя модели для API (llama-server его не проверяет)")
    ap.add_argument("--timeout", type=float, default=300)
    ap.add_argument("--rejudge", action="store_true", help="переоценить всё, даже если оценка уже есть")
    ap.add_argument("--summary-only", action="store_true", help="не звать судью, только сводка по готовым csv")
    args = ap.parse_args()

    table = ["| Прогон | kk | ru | en | всего | проверено вручную |", "|---|---:|---:|---:|---:|---:|"]
    for rp in args.results:
        if args.summary_only:
            out = csv_path_for(rp)
            rows = list(load_existing(out).values())
            if not rows:
                sys.exit(f"нет {out}")
        else:
            print(f"{rp}:")
            out, rows = score_file(rp, args.api, args.judge_model, args.timeout, args.rejudge)
            print(f"  → {out}")
        table.append(summarize(Path(rp).stem.replace("results_", ""), rows))
    print("\nСредний балл, % от максимума (оценки судьи предварительные):")
    print("\n".join(table))


if __name__ == "__main__":
    main()
