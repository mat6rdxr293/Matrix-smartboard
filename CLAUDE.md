# Matrix Smartboard — ML

ИИ-ассистент учителя для школьной интерактивной доски (Казахстан). Здесь ведётся ML-часть проекта.

## Цель
- **Офлайн-модель на доске**: 8 ГБ ОЗУ, без GPU → инференс через llama.cpp / Ollama.
- **RAG по учебникам 9–11 классов** на трёх языках: казахский, русский, английский.
- Итоговый формат модели: **GGUF Q4** (конвертируем после дообучения).

## Обучение
- Машина: RTX 5050 Laptop, 8 ГБ VRAM (sm_120, Blackwell), WSL2.
- Фреймворк: **Unsloth**, venv в `~/matrix/venv` (`source venv/bin/activate`).
- Стек: Python 3.12, torch 2.11.0+cu128, transformers 5.5, triton 3.6, unsloth 2026.9.
- Базовая модель: `unsloth/Qwen3.5-4B` (загружается в 4-bit, `max_seq_length=2048`).
- Смоук-тест: `python test_gpu.py` — загружает модель и отвечает на казахском про Абая.
- Qwen3.5 — гибридная архитектура (Gated DeltaNet + attention). Быстрый путь для
  linear-attention слоёв требует `flash-linear-attention` и `causal-conv1d`; без них
  transformers пишет "fast path is not available" и падает в медленную torch-реализацию.
- Chat template: для Qwen3.5 передаём `enable_thinking=False`, если не нужен режим рассуждений.

### Заметки по окружению
- Системного CUDA toolkit (nvcc) нет, sudo без пароля нет.
- `flash-linear-attention` 0.5.2 — чистый Triton, ставится через pip.
- `causal-conv1d` 1.7.0 собран из исходников: готовых wheel под torch 2.11 нет.
  Для сборки nvcc 12.8 взят из redist-архивов NVIDIA
  (`https://developer.download.nvidia.com/compute/cuda/redist/`, пакеты cuda_nvcc,
  cuda_cudart, cuda_cccl 12.8.x) и распакован в отдельную папку, `CUDA_HOME` указывал на неё,
  gencode только `sm_120`, `CAUSAL_CONV1D_FORCE_BUILD=TRUE`, `pip install . --no-build-isolation`.
  Сборка занимает ~5 минут. Пакет `nvidia-cuda-nvcc-cu12` из pip НЕ подходит (там только ptxas).
- Предупреждения `torchao/_C_cutlass_90a` / `_C_mxfp8` при импорте безвредны.

## Структура
- `textbooks/` — исходные учебники 9–11 классов (kk/ru/en).
- `data/` — обработанные данные: чанки для RAG, датасеты для дообучения.
- `benchmark/` — наборы вопросов и оценка качества (по языкам и предметам).
- `scripts/` — скрипты: парсинг, подготовка данных, обучение, конвертация в GGUF.
- `models/` — чекпойнты, LoRA-адаптеры, GGUF-файлы.
- `unsloth_compiled_cache/` — служебный кэш Unsloth, не трогать.

## Инференс на CPU (симуляция доски)
- `llama.cpp/` — клон ggml-org/llama.cpp, CPU-сборка в `llama.cpp/build/bin/`
  (`cmake -B build -DGGML_CUDA=OFF -DGGML_NATIVE=ON -DLLAMA_CURL=OFF`; cmake стоит в venv через pip).
- Конвертация: `python llama.cpp/convert_hf_to_gguf.py <hf_dir> --outtype bf16 --outfile models/X-BF16.gguf`,
  затем `llama-quantize models/X-BF16.gguf models/X-Q4_K_M.gguf Q4_K_M`.
- Запуск на доске — **без mmap** (`-lm none`; флага `--no-mmap` в этой версии уже нет), иначе RSS почти вдвое больше.
- Замеры: `benchmark/board_speed.md`. Бенчмарк качества: `python benchmark/run_bench.py --model <hf_id|path>`.
- PDF → текст: `python scripts/extract_pdf.py [--ocr]`, вход `textbooks/<предмет>/<класс>/*.pdf`, выход `data/raw/`.
- Тесты: `python -m unittest discover tests -v` (pytest в venv нет). Язык текста — `extract_pdf.lang_guess`: доля казахских букв, латиница из формул не считается.
- Отчёт о состоянии и план: `docs/STATUS.md`, `docs/plan.json` (их показывает вкладка «Обзор и план» в ui.py).

## Конвейер (скрипты)
- Обучение: `scripts/make_test_sft.py` (временные 50 пар → `data/sft/train.jsonl`) →
  `scripts/finetune.py` (QLoRA, Unsloth; формат `{"messages": [...]}`, лосс только по ответу) →
  `scripts/export_gguf.py --adapter models/<lora> --name <имя>` (слияние → GGUF Q4_K_M в `models/`).
  В export_gguf.py есть обход бага Unsloth: шарды базы копируются из кэша HF с режимом 0444.
- RAG: `scripts/fetch_wiki.py` (тестовый корпус, CC BY-SA) → `scripts/build_index.py --source wiki_test|raw`
  (фрагменты ~300 токенов, эмбеддер по умолчанию e5-small, индекс в `data/index/<source>_<model>/`) →
  `scripts/rag.py` (`Retriever.search`, top-3). Сравнение эмбеддеров: `benchmark/embed_compare.md`.
- Промпты (системный + шаблон RAG) — единые в `scripts/prompts.py`: их используют обучение, бенчмарк и бэкенд.
- Бенчмарк: `benchmark/run_bench.py [--rag]` → `benchmark/score.py results_*.jsonl`
  (LLM-судья через OpenAI-совместимый API, оценки предварительные; ручная колонка `human_score` в `scores_*.csv`).
- Сервер для бэкенда: `scripts/serve.sh` (llama-server, без mmap, 4 потока) — `docs/API_FOR_BACKEND.md`.
- Не использовать `pkill -f llama-server` из Bash-инструмента: под шаблон попадает сама оболочка.
  Нужно `pkill -x llama-server`.
- Учебники (сценарий доски): `extract_pdf.py --ocr` (Tesseract; водяные знаки вырезаются) →
  `sections.py` (§ ↔ страницы, `data/sections/`) → `lesson.py <книга> --section N` (задания + слайды, JSON).
  Качественный текст для обучения: `vlm_ocr.py` (Qwen3.5-4B со зрением на GPU, `data/vlm/`).
- Журнал автономной работы — раздел «Апдейты» в `README.md` (пользователь просил вести его по времени).
- Веб-интерфейс: `python scripts/ui.py` (Gradio, :7860) — обёртка над скриптами, задачи в фоне с логами в `runs/`.
  Перезапуск: `pkill -f "^python scripts/ui.py"` (с `^`, иначе шаблон заденет саму оболочку).
