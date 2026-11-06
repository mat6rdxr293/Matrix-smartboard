"""QLoRA fine-tuning of Qwen3.5-4B on the smartboard algebra dataset (RTX 5050, 8 GB).

usage:  python train.py            # full run (2 epochs)
        python train.py --dry      # 5 steps to check memory/speed
"""
import json, os, sys, math, time, re, torch
from torch.utils.data import Dataset
from transformers import (AutoTokenizer, AutoModelForImageTextToText, AutoModelForCausalLM,
                          BitsAndBytesConfig, Trainer, TrainingArguments)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

BASE = os.environ.get("BASE", "unsloth/Qwen3.5-4B")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "lora-" + BASE.split("/")[-1].lower())
MAX_LEN = 1024
DRY = "--dry" in sys.argv

tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token

def encode(msgs):
    prompt = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    full = prompt + msgs[-1]["content"] + "<|im_end|>\n"
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    f_ids = tok(full, add_special_tokens=False)["input_ids"][:MAX_LEN]
    labels = [-100] * min(len(p_ids), len(f_ids)) + f_ids[len(p_ids):]   # loss only on the answer
    return {"input_ids": f_ids, "labels": labels[:len(f_ids)]}

class DS(Dataset):
    def __init__(self, path):
        self.rows = [encode(json.loads(l)["messages"]) for l in open(path, encoding="utf-8")]
        self.rows = [r for r in self.rows if any(x != -100 for x in r["labels"])]
    def __len__(self): return len(self.rows)
    def __getitem__(self, i): return self.rows[i]

def collate(batch):
    n = max(len(b["input_ids"]) for b in batch)
    ids = torch.full((len(batch), n), tok.pad_token_id)
    lab = torch.full((len(batch), n), -100)
    att = torch.zeros((len(batch), n), dtype=torch.long)
    for i, b in enumerate(batch):
        L = len(b["input_ids"])
        ids[i, :L] = torch.tensor(b["input_ids"]); lab[i, :L] = torch.tensor(b["labels"]); att[i, :L] = 1
    return {"input_ids": ids, "labels": lab, "attention_mask": att}

train = DS(os.path.join(HERE, "data", "train.jsonl"))
val = DS(os.path.join(HERE, "data", "val.jsonl"))
# sanity check: show what the model is trained to produce for one example
ex = train[0]
print("=== пример (только то, на чём считается loss) ===")
print(tok.decode([t for t, l in zip(ex["input_ids"], ex["labels"]) if l != -100])[:400])
print(f"train {len(train)} / val {len(val)}; max len {max(len(r['input_ids']) for r in train.rows)}")

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
try:
    model = AutoModelForImageTextToText.from_pretrained(BASE, quantization_config=bnb, device_map={"": 0}, dtype=torch.bfloat16)
except Exception as e:
    print("ImageTextToText не подошёл, пробую CausalLM:", e)
    model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map={"": 0}, dtype=torch.bfloat16)
model.config.use_cache = False
model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

# LoRA only on the text model's linear layers (skip vision tower and lm_head)
targets = set()
for name, mod in model.named_modules():
    if isinstance(mod, torch.nn.Linear) or mod.__class__.__name__ == "Linear4bit":
        if re.search(r"(visual|vision|lm_head|mlp\.gate$|router|shared_expert_gate)", name):
            continue
        targets.add(name.split(".")[-1])
print("LoRA модули:", sorted(targets))
lcfg = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=r"^(?!.*(visual|vision)).*\.(" + "|".join(sorted(targets)) + r")$")
model = get_peft_model(model, lcfg)
model.print_trainable_parameters()

import inspect
kw = dict(
    output_dir=OUT, num_train_epochs=1, per_device_train_batch_size=1, gradient_accumulation_steps=16,
    learning_rate=2e-4, lr_scheduler_type="cosine", warmup_steps=10, weight_decay=0.0,
    bf16=True, optim="paged_adamw_8bit", gradient_checkpointing=True,
    gradient_checkpointing_kwargs={"use_reentrant": False},
    logging_steps=5, eval_strategy="steps", eval_steps=40, save_strategy="steps", save_steps=40,
    save_total_limit=3, per_device_eval_batch_size=1, report_to="none",
    max_steps=5 if DRY else -1, remove_unused_columns=False, dataloader_num_workers=0,
)
allowed = set(inspect.signature(TrainingArguments.__init__).parameters)
dropped = [k for k in kw if k not in allowed]
if dropped: print("пропускаю неподдерживаемые параметры:", dropped, flush=True)
args = TrainingArguments(**{k: v for k, v in kw.items() if k in allowed})
tr = Trainer(model=model, args=args, train_dataset=train, eval_dataset=val, data_collator=collate)
t0 = time.time()
resume = any(d.startswith("checkpoint-") for d in os.listdir(OUT)) if os.path.isdir(OUT) and not DRY else False
tr.train(resume_from_checkpoint=resume if resume else None)
print(f"готово за {(time.time() - t0) / 60:.1f} мин, пик памяти {torch.cuda.max_memory_allocated() / 2**30:.1f} ГБ")
if not DRY:
    model.save_pretrained(os.path.join(OUT, "final"))
    tok.save_pretrained(os.path.join(OUT, "final"))
    with open(os.path.join(OUT, "log_history.json"), "w") as f:
        json.dump(tr.state.log_history, f, ensure_ascii=False, indent=1)
    print("адаптер сохранён в", os.path.join(OUT, "final"))
