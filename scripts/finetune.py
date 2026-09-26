"""QLoRA-дообучение Qwen3.5 через Unsloth на чат-датасете.

Датасет: jsonl, в каждой строке {"messages": [{"role": "system"|"user"|"assistant", "content": str}, ...]}.
Лосс считается только по ответам ассистента. Формат совпадает с инференсом (enable_thinking=False).

    python scripts/finetune.py --data data/sft/train.jsonl --output models/lora_test --epochs 1

Результат: LoRA-адаптер в --output и train_metrics.json (время, сэмплов/с, пик VRAM).
Слить и экспортировать в GGUF: scripts/export_gguf.py.
"""
import argparse
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# маркер начала ответа при enable_thinking=False — всё после него идёт в лосс
RESPONSE_PART = "<|im_start|>assistant\n<think>\n\n</think>\n\n"
INSTRUCTION_PART = "<|im_start|>user\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="unsloth/Qwen3.5-4B")
    ap.add_argument("--data", default=str(ROOT / "data" / "sft" / "train.jsonl"))
    ap.add_argument("--output", default=str(ROOT / "models" / "lora"))
    ap.add_argument("--max-seq-length", type=int, default=2048)
    ap.add_argument("--epochs", type=float, default=1)
    ap.add_argument("--max-steps", type=int, default=-1, help="если > 0, переопределяет --epochs")
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--warmup-ratio", type=float, default=0.05)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=16)
    ap.add_argument("--lora-dropout", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=3407)
    ap.add_argument("--logging-steps", type=int, default=1)
    args = ap.parse_args()

    from unsloth import FastLanguageModel
    from unsloth.chat_templates import train_on_responses_only
    import torch
    from datasets import load_dataset
    from trl import SFTConfig, SFTTrainer

    model, tok = FastLanguageModel.from_pretrained(
        args.model, max_seq_length=args.max_seq_length, load_in_4bit=True
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
    )
    # Qwen3.5 грузится с процессором (VLM); для текста нужен сам токенизатор
    text_tok = getattr(tok, "tokenizer", tok)

    ds = load_dataset("json", data_files=args.data, split="train")
    ds = ds.map(
        lambda ex: {"text": text_tok.apply_chat_template(ex["messages"], tokenize=False, enable_thinking=False)},
        remove_columns=ds.column_names,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=text_tok,
        train_dataset=ds,
        args=SFTConfig(
            dataset_text_field="text",
            max_length=args.max_seq_length,
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=args.grad_accum,
            num_train_epochs=args.epochs,
            max_steps=args.max_steps,
            learning_rate=args.lr,
            warmup_ratio=args.warmup_ratio,
            lr_scheduler_type="linear",
            optim="adamw_8bit",
            weight_decay=0.01,
            logging_steps=args.logging_steps,
            seed=args.seed,
            output_dir=str(Path(args.output) / "checkpoints"),
            save_strategy="no",
            report_to="none",
        ),
    )
    trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)

    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    stats = trainer.train()
    dt = time.perf_counter() - t0

    model.save_pretrained(args.output)
    tok.save_pretrained(args.output)

    n_samples = len(ds) * (args.epochs if args.max_steps <= 0 else 1)
    metrics = {
        "model": args.model,
        "data": args.data,
        "n_examples": len(ds),
        "epochs": args.epochs,
        "steps": stats.global_step,
        "train_time_s": round(dt, 1),
        "samples_per_s": round(stats.metrics.get("train_samples_per_second", n_samples / dt), 3),
        "final_loss": round(stats.training_loss, 4),
        "peak_vram_gb": round(torch.cuda.max_memory_reserved() / 1024**3, 2),
        "peak_vram_allocated_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 2),
        "args": vars(args),
    }
    Path(args.output).mkdir(parents=True, exist_ok=True)
    with open(Path(args.output) / "train_metrics.json", "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in metrics.items() if k != "args"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
