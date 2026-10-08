@echo off
rem Double-click to start the bot in the background, controlled from a tray icon.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\villebot.ps1" tray
