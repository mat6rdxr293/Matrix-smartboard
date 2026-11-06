#!/bin/bash
# waits for training+test to finish, then merges LoRA and exports GGUF (q8_0) + registers it in Ollama
W=/mnt/c/Users/Admin/Matrix-smartboard
cd ~/smartboard && source venv/bin/activate
echo "$(date +%H:%M) жду окончания обучения и теста..."
while [ ! -f "$W/data/finetuned.jsonl" ]; do sleep 60; done
sleep 30
echo "$(date +%H:%M) тест готов, начинаю экспорт"
export BASE=unsloth/Qwen3.5-2B
cp "$W/merge.py" . && python -u merge.py || { echo "MERGE FAILED"; exit 1; }
[ -d llama.cpp ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp || { echo "CLONE FAILED"; exit 1; }
pip install -q ./llama.cpp/gguf-py sentencepiece protobuf
python -u llama.cpp/convert_hf_to_gguf.py out/merged-qwen3.5-2b --outtype q8_0 --outfile out/smartboard-2b-q8_0.gguf || { echo "CONVERT FAILED"; exit 1; }
cp out/smartboard-2b-q8_0.gguf "$W/" && echo "$(date +%H:%M) GGUF скопирован в $W"
printf 'FROM %s\nPARAMETER temperature 0.2\nSYSTEM """Ты — помощник по алгебре и началам анализа для 10 класса (Казахстан). Отвечай на языке вопроса: на русском или на казахском. Решай по шагам, формулы пиши в LaTeX."""\n' "$HOME/smartboard/out/smartboard-2b-q8_0.gguf" > Modelfile
(ollama serve >/dev/null 2>&1 &) ; sleep 5
ollama create smartboard-2b -f Modelfile && echo "$(date +%H:%M) модель в Ollama: ollama run smartboard-2b" || echo "OLLAMA CREATE FAILED (не критично)"
echo "$(date +%H:%M) ЭКСПОРТ ГОТОВ"
