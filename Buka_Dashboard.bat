@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Video Combinator Dashboard
cd /d "%~dp0"

echo ========================================================
echo        MEMULAI AUTOMATED VIDEO COMBINATOR v2
echo ========================================================
echo.

set "SERVER_ENTRY=dist\src\server.js"
set "EXISTING_PORTS="
set "SKIP_PORTS="
set "NEED_BUILD=0"

:: 1. Verifikasi Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js tidak ditemukan di komputer Anda!
    echo Silakan install Node.js versi 24 terlebih dahulu: https://nodejs.org/
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
for /f "tokens=1 delims=v." %%m in ("!NODE_VERSION!") do set "NODE_MAJOR=%%m"
if not defined NODE_MAJOR (
    echo [ERROR] Node.js terdeteksi tetapi tidak dapat dijalankan.
    echo Coba buka terminal baru, jalankan "node -v", lalu install ulang Node.js 24 jika perlu.
    pause
    exit /b 1
)
if !NODE_MAJOR! LSS 24 (
    echo [WARN] Node.js !NODE_VERSION! terdeteksi. Versi yang dianjurkan adalah Node.js 24.
    echo.
)

:: 2. Verifikasi FFmpeg bawaan
if not exist "bin\ffmpeg.exe" (
    echo [ERROR] bin\ffmpeg.exe tidak ditemukan!
    echo Pastikan folder bin berisi ffmpeg.exe dan ffprobe.exe.
    pause
    exit /b 1
)
if not exist "bin\ffprobe.exe" (
    echo [ERROR] bin\ffprobe.exe tidak ditemukan!
    echo Pastikan folder bin berisi ffmpeg.exe dan ffprobe.exe.
    pause
    exit /b 1
)

:: 3. Verifikasi dependencies
if not exist "node_modules" (
    echo [INFO] Folder node_modules belum ada. Menginstal dependensi...
    where npm >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] npm tidak ditemukan. Install Node.js versi 24 terlebih dahulu.
        pause
        exit /b 1
    )
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install gagal. Periksa pesan di atas lalu jalankan ulang file ini.
        pause
        exit /b 1
    )
    if not exist "node_modules" (
        echo [ERROR] node_modules masih belum ada setelah npm install.
        pause
        exit /b 1
    )
    echo [INFO] Dependensi selesai diinstal.
    echo.
)

:: 4. Build jika belum ada atau sudah usang
if not exist "%SERVER_ENTRY%" (
    set "NEED_BUILD=1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $d=(Get-Item 'dist\src\server.js').LastWriteTimeUtc; $l=(Get-ChildItem 'src' -Recurse -Filter *.ts | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc; if ($l -gt $d) { exit 1 } else { exit 0 } } catch { exit 1 }"
    if errorlevel 1 set "NEED_BUILD=1"
)

if "!NEED_BUILD!"=="1" (
    echo [INFO] Build belum ada atau sudah usang. Menjalankan npm run build...
    call npm run build
    if errorlevel 1 (
        echo.
        echo [ERROR] Build gagal. Perbaiki error di atas lalu jalankan ulang file ini.
        pause
        exit /b 1
    )
    if not exist "%SERVER_ENTRY%" (
        echo [ERROR] Build selesai tetapi %SERVER_ENTRY% tidak ditemukan.
        pause
        exit /b 1
    )
    echo [INFO] Build selesai.
    echo.
)

:: 5. Peringatan instance lain di port 3210-3219 (tanpa menghentikan proses user)
set "NETSTAT_FILE=%TEMP%\vc_netstat_%RANDOM%%RANDOM%.txt"
netstat -ano -p tcp > "!NETSTAT_FILE!" 2>nul
if exist "!NETSTAT_FILE!" (
    for /f "tokens=2,4" %%A in ('findstr /R /C:"127.0.0.1:321[0-9]" "!NETSTAT_FILE!"') do (
        if /i "%%B"=="LISTENING" (
            for /f "tokens=2 delims=:" %%C in ("%%A") do (
                if defined EXISTING_PORTS (
                    set "EXISTING_PORTS=!EXISTING_PORTS!,%%C"
                ) else (
                    set "EXISTING_PORTS=%%C"
                )
            )
        )
    )
    del /q "!NETSTAT_FILE!" >nul 2>nul
)

if defined EXISTING_PORTS (
    echo [WARN] Sudah ada proses yang mendengarkan port !EXISTING_PORTS!.
    echo        Aplikasi ini mungkin sudah berjalan. Tidak ada proses yang dihentikan.
    echo        Sebaiknya gunakan instance yang sudah terbuka dan tutup jendela ini.
    echo.
    set "LANJUT="
    set /p "LANJUT=Lanjutkan menyalakan instance baru? (y/N): "
    if /i not "!LANJUT!"=="y" (
        echo [INFO] Dibatalkan.
        echo.
        pause
        exit /b 0
    )
    set "SKIP_PORTS=!EXISTING_PORTS!"
    echo [INFO] Instance baru akan memakai port bebas berikutnya.
    echo.
)

:: 6. Buka browser ke port aktual setelah /api/health merespons
if defined SKIP_PORTS (
    set "SKIP_ARRAY=@(!SKIP_PORTS!)"
) else (
    set "SKIP_ARRAY=@()"
)
echo [INFO] Menunggu server siap. Browser akan terbuka otomatis.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$ProgressPreference='SilentlyContinue'; $skip=!SKIP_ARRAY!; $deadline=(Get-Date).AddSeconds(90); $url=$null; while ((Get-Date) -lt $deadline -and -not $url) { foreach ($p in 3210..3219) { if ($skip -contains $p) { continue }; try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ('http://127.0.0.1:' + $p + '/api/health'); if ($r.StatusCode -eq 200) { $url='http://127.0.0.1:' + $p; break } } catch {} }; if (-not $url) { Start-Sleep -Milliseconds 400 } }; if ($url) { Start-Process $url } else { Write-Host '[WARN] Browser tidak dapat dibuka otomatis: server tidak merespons dalam 90 detik. Buka manual http://127.0.0.1:3210 sampai 3219.' }"

:: 7. Jalankan server tanpa watch
echo.
echo [INFO] Menyalakan server lokal. Port dipilih otomatis dari 3210 sampai 3219.
echo [INFO] Tekan CTRL + C untuk menghentikan aplikasi.
echo.
node "%SERVER_ENTRY%"
set "EXIT_CODE=!errorlevel!"
echo.
if not "!EXIT_CODE!"=="0" (
    echo [ERROR] Server berhenti dengan kode !EXIT_CODE!. Periksa pesan error di atas.
) else (
    echo [INFO] Server berhenti.
)
echo.
pause
exit /b !EXIT_CODE!
