@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-last-backup.ps1"
pause
