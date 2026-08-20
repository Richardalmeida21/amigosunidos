@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title Ferramentas Amigos do Rich

set "BUILD_ID=rich-20260820-1"
set "RUNTIME_ROOT=%~dp0.runtime"
set "RUNTIME_DIR=%RUNTIME_ROOT%\%BUILD_ID%"
set "APP_DIR=%RUNTIME_DIR%\app"
set "APP_EXE=%APP_DIR%\Ferramentas Amigos do Rich.exe"
set "ZIP_TEMP=%RUNTIME_DIR%\FerramentasAmigosDoRich.download"
set "DOWNLOAD_URL=https://github.com/Richardalmeida21/amigosunidos/releases/download/windows-latest/FerramentasAmigosDoRich-win-x64.zip"

if /I "%~1"=="--update" (
  if exist "%RUNTIME_DIR%" rmdir /s /q "%RUNTIME_DIR%" >nul 2>nul
)

if exist "%APP_EXE%" goto :launch

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul 2>nul

echo Preparando Ferramentas Amigos do Rich na primeira execucao...
echo O aplicativo sera baixado e extraido apenas uma vez.
echo Nas proximas aberturas ele inicia direto.
echo.

where curl.exe >nul 2>nul
if errorlevel 1 goto :powershell_download

echo Baixando com curl...
curl.exe -fL --retry 3 --retry-delay 2 --connect-timeout 15 --output "%ZIP_TEMP%" "%DOWNLOAD_URL%"
if not errorlevel 1 goto :verify_download

del /q "%ZIP_TEMP%" >nul 2>nul

echo curl nao concluiu o download. Tentando metodo alternativo...

:powershell_download
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try { Invoke-WebRequest -UseBasicParsing -Uri $env:DOWNLOAD_URL -OutFile $env:ZIP_TEMP; exit 0 }" ^
  "catch { Write-Host ('Falha ao baixar: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 goto :download_error

:verify_download
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $f=Get-Item $env:ZIP_TEMP -ErrorAction Stop; if($f.Length -lt 1MB){exit 1}; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :download_error

echo Extraindo aplicativo...
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%" >nul 2>nul
mkdir "%APP_DIR%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Expand-Archive -LiteralPath $env:ZIP_TEMP -DestinationPath $env:APP_DIR -Force; exit 0 }" ^
  "catch { Write-Host ('Falha ao extrair: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 goto :extract_error

del /q "%ZIP_TEMP%" >nul 2>nul

if not exist "%APP_EXE%" (
  echo.
  echo O pacote foi extraido, mas o executavel nao foi encontrado.
  echo Aguarde o workflow "Build Windows Fast" terminar com sucesso e tente novamente.
  pause
  exit /b 1
)

goto :launch

:download_error
del /q "%ZIP_TEMP%" >nul 2>nul
echo.
echo Nao foi possivel obter o aplicativo do GitHub Releases.
echo Aguarde o workflow "Build Windows Fast" terminar com sucesso e tente novamente.
echo.
pause
exit /b 1

:extract_error
del /q "%ZIP_TEMP%" >nul 2>nul
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%" >nul 2>nul
echo.
echo Nao foi possivel preparar o aplicativo neste computador.
echo.
pause
exit /b 1

:launch
start "" "%APP_EXE%"
if errorlevel 1 (
  echo Nao foi possivel iniciar Ferramentas Amigos do Rich.
  pause
  exit /b 1
)

endlocal
exit /b 0
