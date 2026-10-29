@echo off
REM Uso: release-apk.bat ["notas del release"]
REM Usa la credencial de GitHub que ya tiene git guardada (sin setup extra).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release-apk.ps1" -Notes "%*"
