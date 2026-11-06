# Matrix Smartboard — ML pipeline (алгебра 10 кл., ru/kk)

Дообучение Qwen3.5 (2B/4B, QLoRA) на учебнике «Алгебра и начала анализа 10» (Абылкасымова и др.).
Учебники, OCR-текст и датасеты в репозиторий не входят (авторские права).

| Шаг | Скрипт | Где |
|---|---|---|
| OCR сканов → Markdown (Qwen3.5-4B vision) | `ocr_book.py` | WSL, RTX 5050 |
| Разбор на упражнения и ответы | `parse.py`, `items.py` | любой Python |
| Отбор задач, тест-сет, «похожие задания» | `prep.py`, `fix_test.py` | любой Python |
| Генерация решений + проверка по ответам учебника | `gen.py` (Ollama) | WSL |
| Сборка train/val | `build_dataset.py` | любой Python |
| QLoRA обучение | `train.py` (`BASE=unsloth/Qwen3.5-2B`) / `smartboard_qlora_4b.ipynb` (Kaggle T4) | WSL / Kaggle |
| Тест на 44 отложенных вопросах | `test_model.py` | WSL |
| Слияние LoRA и экспорт GGUF | `merge.py`, `export.sh` | WSL |

Результаты (44 теста): база 4B 38/44, обученная 4B 37/44 (лучше формат и казахский), обученная 2B 28/44.
