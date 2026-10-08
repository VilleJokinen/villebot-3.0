@echo off
rem Stops the bot, whether it was started with start.cmd or by autostart.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\villebot.ps1" stop
pause
