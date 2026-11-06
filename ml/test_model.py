"""Run the fine-tuned model (base + LoRA) on the 44 held-out test questions, or chat with it.

usage:  python test_model.py            # -> data/finetuned.jsonl (compare with data/baseline.jsonl)
        python test_model.py chat       # ask your own questions
"""
import json, os, sys, time, torch
from transformers import AutoTokenizer, AutoModelForImageTextToText, BitsAndBytesConfig
from peft import PeftModel

BASE = os.environ.get("BASE", "unsloth/Qwen3.5-4B")
HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, "out", "lora-" + BASE.split("/")[-1].lower(), "final")
SYSTEM = ("Ты — помощник по алгебре и началам анализа для 10 класса (Казахстан). "
          "Отвечай на языке вопроса: на русском или на казахском. Решай по шагам, формулы пиши в LaTeX.")

tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForImageTextToText.from_pretrained(
    BASE, device_map={"": 0}, dtype=torch.bfloat16,
    quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16))
model = PeftModel.from_pretrained(model, ADAPTER).eval()

def ask(q, max_new=900):
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to(0)
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.05)
    return tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

if len(sys.argv) > 1 and sys.argv[1] == "chat":
    print("Пиши вопрос (пустая строка — выход)")
    while True:
        q = input("\n> ").strip()
        if not q: break
        t = time.time(); print(ask(q)); print(f"({time.time() - t:.0f} c)")
else:
    rows = [json.loads(l) for l in open(os.path.join(HERE, "data", "test.jsonl"), encoding="utf-8")]
    with open(os.path.join(HERE, "data", "finetuned.jsonl"), "w", encoding="utf-8") as f:
        for i, r in enumerate(rows, 1):
            t = time.time()
            r["model_output"] = ask(r["q"])
            f.write(json.dumps(r, ensure_ascii=False) + "\n"); f.flush()
            print(f"[{i}/{len(rows)}] {r['id']} ({time.time() - t:.0f} c)", flush=True)
    print("готово: data/finetuned.jsonl")
