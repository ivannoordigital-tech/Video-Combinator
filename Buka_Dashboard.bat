@echo off
chcp 65001 >nul
title Video Combinator Dashboard
cd /d "%~dp0"

echo ========================================================
echo        MEMULAI AUTOMATED VIDEO COMBINATOR v2
echo ========================================================
echo.

:: 1. Verifikasi Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js tidak ditemukan di komputer Anda!
    echo Silakan install Node.js versi 20 atau 24 terlebih dahulu: https://nodejs.org/
    pause
    exit /b 1
)

:: 2. Verifikasi Bundled FFmpeg
if not exist "bin\ffmpeg.exe" (
    echo [ERROR] bin\ffmpeg.exe tidak ditemukan!
    pause
    exit /b 1
)
if not exist "bin\ffprobe.exe" (
    echo [ERROR] bin\ffprobe.exe tidak ditemukan!
    pause
    exit /b 1
)

:: 3. Verifikasi Dependencies
if not exist "node_modules" (
    echo [INFO] Menginstal dependensi awal...
    call npm install
)

:: 4. Buka Browser Otomatis setelah 2 detik
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:3210"

:: 5. Nyalakan Server
echo [INFO] Menyalakan server lokal di http://127.0.0.1:3210...
echo Tekan CTRL + C untuk menghentikan aplikasi.
echo.
call npx tsx src/server.ts

pause
