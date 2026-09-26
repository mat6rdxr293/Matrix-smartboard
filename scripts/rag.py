"""Поиск по RAG-индексу (top-k фрагментов) — как CLI и как модуль.

    python scripts/rag.py "Аңырақай шайқасы қай жылы болды?"
    python scripts/rag.py --index data/index/wiki_test_bge-m3 -k 5 "Что такое мейоз?"

    from rag import Retriever
    hits = Retriever("data/index/wiki_test_e5-small").search("вопрос", k=3)
"""
import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = ROOT / "data" / "index" / "wiki_test_e5-small"


class Retriever:
    def __init__(self, index_dir=DEFAULT_INDEX, threads=4, device="cpu"):
        import torch
        from sentence_transformers import SentenceTransformer

        index_dir = Path(index_dir)
        self.meta = json.loads((index_dir / "meta.json").read_text(encoding="utf-8"))
        self.emb = np.load(index_dir / "emb.npy")
        with open(index_dir / "chunks.jsonl", encoding="utf-8") as f:
            self.chunks = [json.loads(line) for line in f]
        torch.set_num_threads(threads)
        self.model = SentenceTransformer(self.meta["hf_id"], device=device)

    def search(self, query, k=3):
        q = self.model.encode([self.meta["query_prefix"] + query], normalize_embeddings=True,
                              convert_to_numpy=True)[0]
        scores = self.emb @ q
        top = np.argsort(-scores)[:k]
        return [{**self.chunks[i], "score": float(scores[i])} for i in top]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--index", default=str(DEFAULT_INDEX))
    ap.add_argument("-k", type=int, default=3)
    args = ap.parse_args()

    for i, h in enumerate(Retriever(args.index).search(args.query, args.k), 1):
        print(f"[{i}] {h['score']:.3f}  {h['title']}  ({h['id']})")
        print("    " + h["text"][:300].replace("\n", " ") + ("…" if len(h["text"]) > 300 else ""))


if __name__ == "__main__":
    main()
