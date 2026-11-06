@echo off
title ОБУЧЕНИЕ МОДЕЛИ - НЕ ЗАКРЫВАТЬ
echo Идет обучение модели. Окно НЕ закрывать. Лог: C:\Users\Admin\Matrix-smartboard\train.log
wsl -d Ubuntu-24.04 -u ker -- bash -lc "pkill -x python; sleep 8; export BASE=unsloth/Qwen3.5-2B; mkdir -p ~/smartboard/data && cp /mnt/c/Users/Admin/Matrix-smartboard/{train.py,test_model.py} ~/smartboard/ && cp /mnt/c/Users/Admin/Matrix-smartboard/data/{train,val,test}.jsonl ~/smartboard/data/ && cd ~/smartboard && source venv/bin/activate && python -u train.py && python -u test_model.py && cp data/finetuned.jsonl /mnt/c/Users/Admin/Matrix-smartboard/data/" > C:\Users\Admin\Matrix-smartboard\train.log 2>&1
echo ГОТОВО. Можно закрыть окно.
pause
