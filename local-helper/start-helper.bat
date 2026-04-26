@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"

if not exist "helper_server.py" (
  echo 找不到 helper_server.py。
  echo 目前位置：%CD%
  echo 請確認這個檔案是從 local-helper 資料夾中執行。
  echo.
  echo 如果你的路徑包含中文或雲端硬碟同步資料夾，請改用 start-helper.ps1。
  pause
  exit /b 1
)

echo Whisper 字幕助手正在準備環境...

where py >nul 2>nul
if %errorlevel%==0 (
  set PYTHON_CMD=py -3
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    set PYTHON_CMD=python
  ) else (
    echo 找不到 Python。請先安裝 Python 3.11 以上版本。
    echo 下載網址：https://www.python.org/downloads/
    pause
    exit /b 1
  )
)

if not exist ".venv" (
  echo 建立本機環境...
  %PYTHON_CMD% -m venv .venv
)

call ".venv\Scripts\activate.bat"

echo 安裝或更新必要套件...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo.
echo 本機字幕助手啟動中，請不要關閉這個視窗。
echo 網頁會連線到 http://127.0.0.1:8765
echo.
python helper_server.py

pause
popd
