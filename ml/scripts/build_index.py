"""Построение RAG-индекса: фрагменты ~300 токенов → эмбеддинги → data/index/<name>/.

Источники:
    --source wiki_test   data/wiki_test/*.json (временный корпус из fetch_wiki.py)
    --source raw         data/raw/*.jsonl (страницы учебников из extract_pdf.py)

    python scripts/build_index.py --source wiki_test --model e5-small
    python scripts/build_index.py --source wiki_test --compare     # сравнить модели на CPU → benchmark/embed_compare.md

Индекс: chunks.jsonl (текст + метаданные), emb.npy (float32, L2-нормированные), meta.json.
Поиск — полный перебор косинусной близости (для десятков тысяч фрагментов этого хватает).
"""
import argparse
import json
import re
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent

# короткое имя → (HF id, префикс запроса, префикс фрагмента)
MODELS = {
    "e5-small": ("intfloat/multilingual-e5-small", "query: ", "passage: "),
    "e5-base": ("intfloat/multilingual-e5-base", "query: ", "passage: "),
    "e5-large": ("intfloat/multilingual-e5-large", "query: ", "passage: "),
    "bge-m3": ("BAAI/bge-m3", "", ""),
}
CHUNK_TOKENS = 300
OVERLAP_TOKENS = 50
SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")


# ---------- загрузка документов ----------

def load_wiki_test():
    for fp in sorted((ROOT / "data" / "wiki_test").glob("*.json")):
        d = json.loads(fp.read_text(encoding="utf-8"))
        # заголовки разделов MediaWiki ("== История ==") оставляем как отдельные строки без "="
        text = re.sub(r"^=+\s*(.*?)\s*=+\s*$", r"\1.", d["text"], flags=re.M)
        yield {"doc_id": fp.stem, "title": d["title"], "lang": d["lang"], "text": text,
               "meta": {"url": d["url"], "revid": d["revid"], "license": d["license"], "bench_ids": d["bench_ids"]}}


def load_raw():
    """Страницы учебников: один документ = одна страница (номер страницы нужен для ссылки в ответе)."""
    for fp in sorted((ROOT / "data" / "raw").glob("*.jsonl")):
        for line in fp.open(encoding="utf-8"):
            p = json.loads(line)
            if not p["text"]:
                continue
            yield {"doc_id": f"{p['doc_id']}_p{p['page']}", "title": f"{p['doc_id']}, бет/стр. {p['page']}",
                   "lang": p.get("lang_guess"), "text": p["text"],
                   "meta": {"source": p["source"], "subject": p["subject"], "grade": p["grade"], "page": p["page"]}}


SOURCES = {"wiki_test": load_wiki_test, "raw": load_raw}


# ---------- нарезка ----------

def chunk_text(text, tokenizer, max_tokens=CHUNK_TOKENS, overlap=OVERLAP_TOKENS):
    """Жадно собирает предложения в фрагменты ≤ max_tokens, с перекрытием ~overlap токенов."""
    sents = [s.strip() for s in SENT_SPLIT.split(text) if s.strip()]
    units = []  # (текст, число токенов); слишком длинные предложения режем по токенам
    for s in sents:
        ids = tokenizer.encode(s, add_special_tokens=False)
        if len(ids) <= max_tokens:
            units.append((s, len(ids)))
        else:
            for i in range(0, len(ids), max_tokens - overlap):
                part = ids[i:i + max_tokens]
                units.append((tokenizer.decode(part), len(part)))

    chunks, cur, cur_len = [], [], 0
    for s, n in units:
        if cur and cur_len + n > max_tokens:
            chunks.append(" ".join(x for x, _ in cur))
            # перекрытие: хвост из последних предложений общим размером ≤ overlap
            tail, tail_len = [], 0
            for x, m in reversed(cur):
                if tail_len + m > overlap:
                    break
                tail.insert(0, (x, m))
                tail_len += m
            cur, cur_len = tail, tail_len
        cur.append((s, n))
        cur_len += n
    if cur:
        chunks.append(" ".join(x for x, _ in cur))
    return chunks


def make_chunks(docs, tokenizer):
    out = []
    for d in docs:
        for i, text in enumerate(chunk_text(d["text"], tokenizer)):
            out.append({"id": f"{d['doc_id']}#{i}", "doc_id": d["doc_id"], "title": d["title"],
                        "lang": d["lang"], "text": text, **d["meta"]})
    return out


# ---------- эмбеддинги ----------

def load_model(name, threads):
    import torch
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(threads)
    return SentenceTransformer(MODELS[name][0], device="cpu")


def embed_passages(model, name, chunks, batch_size=16):
    prefix = MODELS[name][2]
    texts = [f"{prefix}{c['title']}. {c['text']}" for c in chunks]
    return model.encode(texts, batch_size=batch_size, normalize_embeddings=True,
                        convert_to_numpy=True, show_progress_bar=False).astype(np.float32)


def embed_query(model, name, query):
    return model.encode([MODELS[name][1] + query], normalize_embeddings=True, convert_to_numpy=True)[0]


def save_index(out_dir, name, source, chunks, emb, build_s):
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / "emb.npy", emb)
    with open(out_dir / "chunks.jsonl", "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    meta = {"model": name, "hf_id": MODELS[name][0], "query_prefix": MODELS[name][1],
            "source": source, "n_chunks": len(chunks), "dim": int(emb.shape[1]),
            "chunk_tokens": CHUNK_TOKENS, "overlap_tokens": OVERLAP_TOKENS, "build_time_s": round(build_s, 1)}
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- сравнение моделей ----------

def hit_at_k(model, name, chunks, emb, k=3):
    """Доля вопросов бенчмарка, для которых в top-k есть фрагмент «своей» статьи (по bench_ids)."""
    qs = [json.loads(l) for l in open(ROOT / "benchmark" / "questions.jsonl", encoding="utf-8")]
    by_lang, lat = {}, []
    for q in qs:
        t0 = time.perf_counter()
        qe = embed_query(model, name, q["question"])
        top = np.argsort(-(emb @ qe))[:k]
        lat.append(time.perf_counter() - t0)
        hit = any(q["id"] in chunks[i].get("bench_ids", []) for i in top)
        by_lang.setdefault(q["lang"], []).append(hit)
    all_hits = [h for v in by_lang.values() for h in v]
    return ({l: sum(v) / len(v) for l, v in by_lang.items()}, sum(all_hits) / len(all_hits),
            1000 * float(np.median(lat)))


def compare(source, docs, threads):
    from transformers import AutoTokenizer

    # у всех моделей из списка токенизатор XLM-R → фрагменты одинаковые, сравнение честное
    tok = AutoTokenizer.from_pretrained(MODELS["e5-base"][0])
    chunks = make_chunks(docs, tok)
    rows = []
    for name in ["e5-small", "e5-base", "e5-large", "bge-m3"]:
        t0 = time.perf_counter()
        try:
            model = load_model(name, threads)
        except Exception as e:  # noqa: BLE001 — не скачалась одна модель → сравниваем остальные
            print(f"{name}: не загрузилась ({type(e).__name__}: {str(e)[:200]})")
            continue
        load_s = time.perf_counter() - t0
        t0 = time.perf_counter()
        emb = embed_passages(model, name, chunks)
        enc_s = time.perf_counter() - t0
        by_lang, hit, q_ms = hit_at_k(model, name, chunks, emb)
        n_params = sum(p.numel() for p in model.parameters()) / 1e6
        rows.append((name, n_params, load_s, enc_s, len(chunks) / enc_s, q_ms, by_lang, hit))
        print(f"{name}: {len(chunks)} фрагм. за {enc_s:.1f}s ({len(chunks) / enc_s:.1f}/s), "
              f"запрос {q_ms:.0f} мс, hit@3 {hit:.2f} {by_lang}")
        save_index(ROOT / "data" / "index" / f"{source}_{name}", name, source, chunks, emb, enc_s)
        del model

    md = [f"# Сравнение эмбеддеров на CPU ({threads} потока)\n",
          f"Корпус: `{source}`, {len(docs)} документов → {len(chunks)} фрагментов по ~{CHUNK_TOKENS} токенов "
          f"(перекрытие {OVERLAP_TOKENS}). hit@3 — доля из 30 вопросов бенчмарка, для которых в top-3 "
          f"попал фрагмент статьи, отвечающей на вопрос.\n",
          "| Модель | Параметры | Индексация, фрагм./с | Запрос, мс (медиана) | hit@3 kk | hit@3 ru | hit@3 en | hit@3 всего |",
          "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for name, n_params, load_s, enc_s, cps, q_ms, by_lang, hit in rows:
        md.append(f"| {name} | {n_params:.0f}M | {cps:.1f} | {q_ms:.0f} | {by_lang.get('kk', 0):.2f} | "
                  f"{by_lang.get('ru', 0):.2f} | {by_lang.get('en', 0):.2f} | **{hit:.2f}** |")
    (ROOT / "benchmark" / "embed_compare.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n→ benchmark/embed_compare.md")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=SOURCES, default="wiki_test")
    ap.add_argument("--model", choices=MODELS, default="e5-small")
    ap.add_argument("--out", default=None, help="по умолчанию data/index/<source>_<model>")
    ap.add_argument("--threads", type=int, default=4, help="потоков CPU (доска — 4)")
    ap.add_argument("--compare", action="store_true", help="сравнить все модели и сохранить все индексы")
    args = ap.parse_args()

    docs = list(SOURCES[args.source]())
    if not docs:
        raise SystemExit(f"Нет документов для источника {args.source}")
    if args.compare:
        return compare(args.source, docs, args.threads)

    model = load_model(args.model, args.threads)
    chunks = make_chunks(docs, model.tokenizer)
    t0 = time.perf_counter()
    emb = embed_passages(model, args.model, chunks)
    dt = time.perf_counter() - t0
    out = Path(args.out) if args.out else ROOT / "data" / "index" / f"{args.source}_{args.model}"
    save_index(out, args.model, args.source, chunks, emb, dt)
    print(f"{len(docs)} док. → {len(chunks)} фрагм., эмбеддинги {dt:.1f}s → {out}")


if __name__ == "__main__":
    main()
