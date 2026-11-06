import sys, os, time, subprocess, torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

# usage: python ocr_book.py pdf/517.pdf 118 125 ocr/517
pdf, first, last, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
os.makedirs(out, exist_ok=True)

m = "unsloth/Qwen3.5-4B"
proc = AutoProcessor.from_pretrained(m)
model = AutoModelForImageTextToText.from_pretrained(
    m, device_map="cuda",
    quantization_config=BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16))

PROMPT = (
    "Перепиши страницу школьного учебника алгебры в Markdown. Без вступлений, без ```. "
    "Все формулы в LaTeX ($...$). Обозначения: tg, ctg, arcsin, arccos, arctg, arcctg. "
    "Формулы в рамках рядом с графиками тоже перепиши. Графики пропусти, подписи «Рис. N» оставь. "
    "Колонтитулы и номер страницы не пиши. "
    "Сохраняй язык оригинала: казахский текст оставь на казахском, не переводи. "
    "Если между числами или выражениями стоит странный знак «m», это знак ≤ ($\\le$)."
)

tmp = "/tmp/ocr_pg"
for p in range(first, last + 1):
    dst = f"{out}/p{p:03d}.md"
    if os.path.exists(dst):
        continue
    t = time.time()
    subprocess.run(["pdftoppm", "-r", "150", "-png", "-f", str(p), "-l", str(p),
                    "-singlefile", pdf, tmp], check=True)
    im = Image.open(tmp + ".png").convert("RGB")
    w, h = im.size
    im.crop((0, int(h * 0.03), w, int(h * 0.965))).save(tmp + "_c.png")  # cut OKULYK.KZ watermark

    msgs = [{"role": "user", "content": [
        {"type": "image", "path": tmp + "_c.png"},
        {"type": "text", "text": PROMPT}]}]
    inp = proc.apply_chat_template(
        msgs, add_generation_prompt=True, enable_thinking=False,
        tokenize=True, return_dict=True, return_tensors="pt").to("cuda")
    with torch.no_grad():
        o = model.generate(**inp, max_new_tokens=2500, do_sample=False)
    txt = proc.decode(o[0][inp["input_ids"].shape[1]:], skip_special_tokens=True)
    txt = txt.replace("arccctg", "arcctg")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(txt)
    print(f"p{p}: {time.time() - t:.0f} c, {len(txt)} симв.", flush=True)
