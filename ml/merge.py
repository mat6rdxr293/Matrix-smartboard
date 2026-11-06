"""Merge LoRA adapter into the base model (bf16) so it can be converted to GGUF."""
import os, torch
from transformers import AutoModelForImageTextToText, AutoProcessor, AutoTokenizer
from peft import PeftModel
BASE = os.environ.get("BASE", "unsloth/Qwen3.5-2B")
HERE = os.path.dirname(os.path.abspath(__file__))
tag = BASE.split("/")[-1].lower()
ADAPTER = os.path.join(HERE, "out", "lora-" + tag, "final")
OUT = os.path.join(HERE, "out", "merged-" + tag)
model = AutoModelForImageTextToText.from_pretrained(BASE, dtype=torch.bfloat16, device_map={"": "cpu"})
model = PeftModel.from_pretrained(model, ADAPTER).merge_and_unload()
model.save_pretrained(OUT, safe_serialization=True)
try:
    AutoProcessor.from_pretrained(BASE).save_pretrained(OUT)
except Exception as e:
    print("processor:", e)
AutoTokenizer.from_pretrained(BASE).save_pretrained(OUT)
print("merged ->", OUT)
