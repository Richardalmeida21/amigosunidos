@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title Ferramentas Amigos do Rich

set "INSTALLED_EXE=%LOCALAPPDATA%\Programs\Ferramentas Amigos do Rich\Ferramentas Amigos do Rich.exe"
set "RUNTIME_DIR=%~dp0.runtime"
set "SETUP_EXE=%RUNTIME_DIR%\FerramentasAmigosDoRich-Setup.exe"
set "DOWNLOAD_URL=https://github.com/Richardalmeida21/amigosunidos/releases/download/windows-latest/FerramentasAmigosDoRich-Setup.exe"

if exist "%INSTALLED_EXE%" goto :launch
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul 2>nul

echo Preparando Ferramentas Amigos do Rich...
echo O instalador sera baixado uma unica vez.
echo Depois de instalado, o aplicativo abre direto e rapido.
echo.

where curl.exe >nul 2>nul
if errorlevel 1 goto :powershell_download

echo Baixando instalador...
curl.exe -fL --retry 3 --retry-delay 2 --connect-timeout 15 --output "%SETUP_EXE%" "%DOWNLOAD_URL%"
if not errorlevel 1 goto :verify_download

del /q "%SETUP_EXE%" >nul 2>nul

echo curl nao concluiu o download. Tentando metodo alternativo...

:powershell_download
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try { Invoke-WebRequest -UseBasicParsing -Uri $env:DOWNLOAD_URL -OutFile $env:SETUP_EXE; exit 0 }" ^
  "catch { Write-Host ('Falha ao baixar: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 goto :download_error

:verify_download
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $f=Get-Item $env:SETUP_EXE -ErrorAction Stop; if($f.Length -lt 1MB){exit 1}; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :download_error

echo Iniciando instalacao...
start "" /wait "%SETUP_EXE%"
if errorlevel 1 (
  echo.
  echo O instalador nao foi concluido corretamente.
  pause
  exit /b 1
)

if exist "%INSTALLED_EXE%" goto :launch

echo.
echo A instalacao terminou, mas o aplicativo nao foi localizado.
echo Tente abri-lo pelo menu Iniciar do Windows.
pause
exit /b 1

:download_error
del /q "%SETUP_EXE%" >nul 2>nul
echo.
echo Nao foi possivel obter o instalador do GitHub Releases.
echo Aguarde o workflow "Build Windows Setup" terminar com sucesso e tente novamente.
echo.
pause
exit /b 1

:launch
start "" "%INSTALLED_EXE%"
if errorlevel 1 (
  echo Nao foi possivel iniciar Ferramentas Amigos do Rich.
  pause
  exit /b 1
)

endlocal
exit /b 0
