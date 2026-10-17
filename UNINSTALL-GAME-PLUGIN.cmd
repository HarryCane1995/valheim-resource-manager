@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-plugin.ps1"
if errorlevel 1 pause
