"""Слить LoRA-адаптер с базой и экспортировать в GGUF (по умолчанию Q4_K_M) для llama.cpp/Ollama.

    python scripts/export_gguf.py --adapter models/lora_test --name qwen35-4b-test

Шаги: адаптер + база → HF 16-bit (models/<name>-merged/) → GGUF BF16 → квантование.
Промежуточный BF16 GGUF удаляется, merged-папка — только с --rm-merged.
"""
import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LLAMA = ROOT / "llama.cpp"


def run(cmd):
    print("$", " ".join(map(str, cmd)))
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True, help="папка с LoRA из finetune.py")
    ap.add_argument("--name", required=True, help="имя выходной модели")
    ap.add_argument("--quant", default="Q4_K_M")
    ap.add_argument("--max-seq-length", type=int, default=2048)
    ap.add_argument("--rm-merged", action="store_true", help="удалить HF-папку после конвертации")
    args = ap.parse_args()

    models = ROOT / "models"
    merged = models / f"{args.name}-merged"
    bf16 = models / f"{args.name}-BF16.gguf"
    out = models / f"{args.name}-{args.quant}.gguf"

    t0 = time.perf_counter()
    from unsloth import FastLanguageModel
    import unsloth_zoo.saving_utils as su

    # Unsloth копирует шарды базы из кэша HF через copy2 и сохраняет режим 0444 блобов кэша,
    # а потом пишет в них слитые веса → PermissionError. Делаем копии записываемыми.
    _orig_copy = su._copy_file_from_source

    def _copy_writable(src, target_dir, filename):
        res = _orig_copy(src, target_dir, filename)
        p = Path(target_dir) / filename
        p.chmod(p.stat().st_mode | 0o200)
        return res

    su._copy_file_from_source = _copy_writable
    shutil.rmtree(merged, ignore_errors=True)

    model, tok = FastLanguageModel.from_pretrained(
        args.adapter, max_seq_length=args.max_seq_length, load_in_4bit=True
    )
    # Unsloth сливает с оригинальными 16-bit весами базы (а не с 4-bit), послойно, без полной загрузки в VRAM
    model.save_pretrained_merged(str(merged), tok, save_method="merged_16bit")
    del model
    t_merge = time.perf_counter() - t0

    run([sys.executable, LLAMA / "convert_hf_to_gguf.py", merged, "--outtype", "bf16", "--outfile", bf16])
    run([LLAMA / "build" / "bin" / "llama-quantize", bf16, out, args.quant])
    bf16.unlink()
    if args.rm_merged:
        shutil.rmtree(merged)

    print(f"\nГотово: {out} ({out.stat().st_size / 1024**3:.2f} GiB); "
          f"слияние {t_merge:.0f}s, всего {time.perf_counter() - t0:.0f}s")


if __name__ == "__main__":
    main()
