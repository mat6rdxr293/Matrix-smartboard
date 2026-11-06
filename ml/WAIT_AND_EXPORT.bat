@echo off
title EXPORT - wait for training, do not close
wsl -d Ubuntu-24.04 -u ker -- bash /mnt/c/Users/Admin/Matrix-smartboard/export.sh > C:\Users\Admin\Matrix-smartboard\export.log 2>&1
echo DONE
pause
