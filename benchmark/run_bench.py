"""Прогон бенчмарка: все вопросы из questions.jsonl через модель (Unsloth, 4-bit, без thinking).

Пример:
    python benchmark/run_bench.py --model unsloth/Qwen3.5-4B
    python benchmark/run_bench.py --model models/my_lora --max-new-tokens 512
    python benchmark/run_bench.py --rag --index data/index/wiki_test_e5-small   # с поиском top-3

Результат: benchmark/results_<model>[_rag]_<YYYY-MM-DD>.jsonl — по строке на вопрос
(поля вопроса + answer, gen_time_s, new_tokens, tok_per_s, prompt_tokens; с --rag ещё rag_hits, rag_time_s).
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH_DIR.parent / "scripts"))
from prompts import RAG_TEMPLATE, SYSTEM_PROMPT, format_context  # noqa: E402


def load_questions(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="unsloth/Qwen3.5-4B")
    ap.add_argument("--questions", default=str(BENCH_DIR / "questions.jsonl"))
    ap.add_argument("--max-seq-length", type=int, default=2048)
    ap.add_argument("--max-new-tokens", type=int, default=256)
    ap.add_argument("--no-system", action="store_true", help="не добавлять системный промпт")
    ap.add_argument("--rag", action="store_true", help="добавлять в вопрос top-k фрагментов из индекса")
    ap.add_argument("--index", default=str(BENCH_DIR.parent / "data" / "index" / "wiki_test_e5-small"))
    ap.add_argument("-k", type=int, default=3)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    retriever = None
    if args.rag:
        from rag import Retriever
        retriever = Retriever(args.index)  # эмбеддер на CPU, как на доске

    from unsloth import FastLanguageModel
    import torch

    model, tok = FastLanguageModel.from_pretrained(
        args.model, max_seq_length=args.max_seq_length, load_in_4bit=True
    )
    FastLanguageModel.for_inference(model)

    questions = load_questions(args.questions)
    model_tag = args.model.rstrip("/").split("/")[-1]
    date = datetime.date.today().isoformat()
    rag_tag = "_rag" if args.rag else ""
    out_path = Path(args.out) if args.out else BENCH_DIR / f"results_{model_tag}{rag_tag}_{date}.jsonl"

    # прогрев: первый generate компилирует ядра и искажает замер времени
    warm = tok.apply_chat_template(
        [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
        add_generation_prompt=True, tokenize=False, enable_thinking=False,
    )
    model.generate(**tok(text=warm, return_tensors="pt").to("cuda"), max_new_tokens=8)

    total_time = total_tokens = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for i, q in enumerate(questions, 1):
            msgs = []
            if not args.no_system:
                msgs.append({"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT[q["lang"]]}]})
            user_text, rag_info = q["question"], {}
            if retriever:
                t0 = time.perf_counter()
                hits = retriever.search(q["question"], k=args.k)
                rag_info = {"rag_index": args.index, "rag_time_s": round(time.perf_counter() - t0, 3),
                            "rag_hits": [{"id": h["id"], "title": h["title"], "score": round(h["score"], 4)} for h in hits]}
                user_text = RAG_TEMPLATE[q["lang"]].format(context=format_context(hits), question=q["question"])
            msgs.append({"role": "user", "content": [{"type": "text", "text": user_text}]})
            text = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)
            inputs = tok(text=text, return_tensors="pt").to("cuda")

            torch.cuda.synchronize()
            t0 = time.perf_counter()
            out = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
            torch.cuda.synchronize()
            dt = time.perf_counter() - t0

            new_ids = out[0][inputs["input_ids"].shape[1]:]
            answer = tok.decode(new_ids, skip_special_tokens=True).strip()
            n = len(new_ids)
            total_time += dt
            total_tokens += n
            rec = {**q, "model": args.model, "answer": answer,
                   "gen_time_s": round(dt, 3), "new_tokens": n, "tok_per_s": round(n / dt, 2),
                   "prompt_tokens": inputs["input_ids"].shape[1], **rag_info}
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            print(f"[{i}/{len(questions)}] {q['id']} {dt:.1f}s {n} tok | {answer[:80]!r}", flush=True)

    print(f"\nГотово: {out_path}")
    print(f"Всего {total_tokens} токенов за {total_time:.1f}s, в среднем {total_tokens / total_time:.1f} tok/s")


if __name__ == "__main__":
    main()
