@echo off
rem Double-click to start the bot in the background, controlled from a tray icon.
rem conhost --headless runs PowerShell with no console window (see autostart-on in scripts\villebot.ps1).
start "" "%windir%\System32\conhost.exe" --headless powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\villebot.ps1" tray
