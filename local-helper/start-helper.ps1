$ErrorActionPreference = "Stop"

try {
  $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  Set-Location -LiteralPath $ScriptDir

  if (-not (Test-Path -LiteralPath ".\helper_server.py")) {
    throw "Cannot find helper_server.py. Current folder: $(Get-Location). Please run this from the local-helper folder."
  }

  Write-Host "Preparing Whisper local helper..."

  $PythonExe = $null
  $PythonArgs = @()
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonExe = "py"
    $PythonArgs = @("-3")
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonExe = "python"
  }

  if (-not $PythonExe) {
    throw "Python was not found. Please install Python 3.11 or later: https://www.python.org/downloads/"
  }

  if (-not (Test-Path -LiteralPath ".\.venv")) {
    Write-Host "Creating local Python environment..."
    & $PythonExe @PythonArgs -m venv .venv
  }

  $VenvPython = Join-Path $ScriptDir ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $VenvPython)) {
    throw "Cannot find virtual environment Python: $VenvPython"
  }

  Write-Host "Installing or updating packages..."
  & $VenvPython -m pip install --upgrade pip
  & $VenvPython -m pip install -r requirements.txt

  Write-Host ""
  Write-Host "Whisper local helper is starting. Do not close this window."
  Write-Host "Web page will connect to http://127.0.0.1:8765"
  Write-Host ""
  & $VenvPython helper_server.py
} catch {
  Write-Host ""
  Write-Host "Startup failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  Write-Host "Please take a screenshot of this error message."
} finally {
  Write-Host ""
  Read-Host "Press Enter to exit"
}
