from unsloth import FastLanguageModel
model, tok = FastLanguageModel.from_pretrained(
    "unsloth/Qwen3.5-4B",
    max_seq_length=2048,
    load_in_4bit=True,
)
FastLanguageModel.for_inference(model)
msgs = [{"role": "user", "content": [{"type": "text", "text": "Абай Құнанбаев туралы 2 сөйлеммен айтып бер."}]}]
text = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)
inputs = tok(text=text, return_tensors="pt").to("cuda")
out = model.generate(**inputs, max_new_tokens=200)
print(tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True))
