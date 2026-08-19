@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale o Node.js 22.12 ou mais recente.
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo Instalando dependencias na primeira execucao...
  call npm install --include=dev
  if errorlevel 1 (
    echo Nao foi possivel instalar as dependencias.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 (
  echo O Painel de Contas foi encerrado com erro.
  pause
)

endlocal
