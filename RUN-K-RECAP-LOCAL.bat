@echo off
rem K RECAP - run on this computer only (no internet link needed).
title K RECAP - keep this window open
cd /d "%~dp0recap-v3\server"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing K RECAP packages, please wait...
  call npm.cmd install
)
start "" http://localhost:5002
npm.cmd start
pause
