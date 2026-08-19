@echo off
setlocal
cd /d "%~dp0"

title Amigos Unidos

set "RUNTIME_DIR=%~dp0.runtime"
set "APP_EXE=%RUNTIME_DIR%\AmigosUnidos-portable.exe"
set "DOWNLOAD_TEMP=%RUNTIME_DIR%\AmigosUnidos-portable.download"
set "DOWNLOAD_URL=https://github.com/Richardalmeida21/amigosunidos/releases/download/windows-latest/AmigosUnidos-portable.exe"

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul 2>nul

if not exist "%APP_EXE%" (
  echo Preparando o Painel de Ferramentas na primeira execucao...
  echo Baixando a versao pronta. Nenhuma dependencia sera instalada neste computador.
  echo.

  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; try {" ^
    "Invoke-WebRequest -UseBasicParsing -Uri $env:DOWNLOAD_URL -OutFile $env:DOWNLOAD_TEMP;" ^
    "$file = Get-Item $env:DOWNLOAD_TEMP -ErrorAction Stop;" ^
    "if ($file.Length -lt 1MB) { throw 'O arquivo baixado parece invalido.' };" ^
    "Move-Item -Force $env:DOWNLOAD_TEMP $env:APP_EXE;" ^
    "exit 0" ^
    "} catch {" ^
    "Remove-Item -Force $env:DOWNLOAD_TEMP -ErrorAction SilentlyContinue;" ^
    "Write-Host ('Falha ao baixar o aplicativo: ' + $_.Exception.Message) -ForegroundColor Red;" ^
    "exit 1" ^
    "}"

  if errorlevel 1 (
    echo.
    echo Nao foi possivel obter o executavel pronto do GitHub Releases.
    echo Confirme se o workflow "Build Windows Portable" terminou com sucesso no GitHub e tente novamente.
    echo.
    pause
    exit /b 1
  )
)

if not exist "%APP_EXE%" (
  echo O executavel do Painel nao foi encontrado.
  pause
  exit /b 1
)

start "" "%APP_EXE%"
if errorlevel 1 (
  echo Nao foi possivel iniciar o Painel de Ferramentas.
  pause
  exit /b 1
)

endlocal
