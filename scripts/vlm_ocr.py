"""Качественное распознавание страниц учебника моделью со зрением (Qwen3.5-4B на GPU).

Для подготовки данных на нашей стороне: текст с формулами в LaTeX и таблицами в Markdown.
На доске не используется (на CPU слишком медленно) — там Tesseract (extract_pdf.py --ocr).

    python scripts/vlm_ocr.py textbooks/physics/11/fizika_emn_kk_11_part1.pdf --lang kk
    python scripts/vlm_ocr.py <pdf> --lang ru --pages 50-60 --batch 4

Выход: data/vlm/<предмет>_<класс>_<имя>.jsonl, строка на страницу:
    {page, text, new_tokens, truncated, time_s}
Уже распознанные страницы пропускаются — можно прерывать и запускать снова.

ВНИМАНИЕ: модель может молча пропустить или исказить число (в тесте из 10 чисел выпало одно).
Сверять с Tesseract: scripts/compare_ocr.py.
"""
import argparse
import json
import time
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent

LANG_NAME = {"kk": "Kazakh", "ru": "Russian", "en": "English"}
PROMPT = (
    "Transcribe this textbook page verbatim in its original language ({lang}). Do not translate, "
    "do not summarize, do not add comments. Keep paragraph breaks and headings (e.g. § numbers). "
    "Write formulas in LaTeX between $...$ (or $$...$$ for display formulas), tables in Markdown. "
    "For figures write only the caption. Skip the website watermark lines about OKULYK."
)


def parse_pages(spec, n):
    if not spec:
        return list(range(1, n + 1))
    pages = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        pages += list(range(int(a), int(b or a) + 1))
    return [p for p in pages if 1 <= p <= n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--lang", choices=LANG_NAME, required=True)
    ap.add_argument("--pages", default=None, help="например 1-20,35")
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--max-new-tokens", type=int, default=1800)
    ap.add_argument("--model", default="unsloth/Qwen3.5-4B")
    args = ap.parse_args()

    pdf = Path(args.pdf).resolve()
    subject, grade = pdf.parent.parent.name, pdf.parent.name
    out = ROOT / "data" / "vlm" / f"{subject}_{grade}_{pdf.stem}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        done = {json.loads(line)["page"] for line in out.open(encoding="utf-8")}

    doc = pymupdf.open(pdf)
    todo = [p for p in parse_pages(args.pages, len(doc)) if p not in done]
    print(f"{pdf.name}: {len(todo)} стр. к распознаванию (уже готово {len(done)})", flush=True)
    if not todo:
        return

    import torch
    from PIL import Image
    from unsloth import FastVisionModel

    model, proc = FastVisionModel.from_pretrained(args.model, load_in_4bit=True, max_seq_length=4096)
    FastVisionModel.for_inference(model)
    proc.tokenizer.padding_side = "left"  # для пакетной генерации
    prompt = PROMPT.format(lang=LANG_NAME[args.lang])
    msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}]
    chat = proc.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)

    eos = model.generation_config.eos_token_id
    stop_ids = set(eos if isinstance(eos, list) else [eos]) | {proc.tokenizer.pad_token_id}
    t_start = time.perf_counter()
    with open(out, "a", encoding="utf-8") as f:
        for i in range(0, len(todo), args.batch):
            pages = todo[i:i + args.batch]
            imgs = []
            for p in pages:
                pix = doc[p - 1].get_pixmap(dpi=args.dpi)
                imgs.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
            inp = proc(images=imgs, text=[chat] * len(imgs), return_tensors="pt", padding=True).to("cuda")
            t0 = time.perf_counter()
            with torch.no_grad():
                gen = model.generate(**inp, max_new_tokens=args.max_new_tokens, do_sample=False,
                                     repetition_penalty=1.05)
            dt = time.perf_counter() - t0
            n_in = inp["input_ids"].shape[1]
            for p, ids in zip(pages, gen[:, n_in:]):
                # в пакете короткие ответы добиваются pad/eos до длины самого длинного
                ends = [j for j, t in enumerate(ids.tolist()) if t in stop_ids]
                n_new = ends[0] if ends else len(ids)
                text = proc.decode(ids[:n_new], skip_special_tokens=True).strip()
                text = "\n".join(l for l in text.splitlines() if "OKULYK" not in l.upper()).strip()
                rec = {"page": p, "text": text, "new_tokens": n_new,
                       "truncated": n_new >= args.max_new_tokens, "time_s": round(dt / len(pages), 1)}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            elapsed = time.perf_counter() - t_start
            left = len(todo) - i - len(pages)
            print(f"стр. {pages[0]}–{pages[-1]}: {dt:.0f} с на пакет ({dt / len(pages):.0f} с/стр.), "
                  f"пик VRAM {torch.cuda.max_memory_reserved() / 2**30:.1f} ГБ, "
                  f"осталось {left} стр. ≈ {elapsed / (i + len(pages)) * left / 60:.0f} мин", flush=True)


if __name__ == "__main__":
    main()
