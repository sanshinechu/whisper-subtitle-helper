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
  } else {
    $CodexPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $CodexPython) {
      $PythonExe = $CodexPython
    }
  }

  if (-not $PythonExe) {
    throw "Python was not found. Please install Python 3.11 or later: https://www.python.org/downloads/"
  }

  $VenvDir = Join-Path $ScriptDir ".venv"
  $VenvPython = Join-Path $VenvDir "Scripts\python.exe"

  function Test-VenvPython {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
      return $false
    }

    try {
      & $Path --version *> $null
      return $LASTEXITCODE -eq 0
    } catch {
      return $false
    }
  }

  if (-not (Test-Path -LiteralPath ".\.venv")) {
    Write-Host "Creating local Python environment..."
    & $PythonExe @PythonArgs -m venv .venv
  }

  if (-not (Test-VenvPython -Path $VenvPython)) {
    Write-Host "Existing local Python environment is not usable. Recreating it..."

    $ResolvedScriptDir = (Resolve-Path -LiteralPath $ScriptDir).Path.TrimEnd('\')
    $ResolvedVenvDir = if (Test-Path -LiteralPath $VenvDir) {
      (Resolve-Path -LiteralPath $VenvDir).Path.TrimEnd('\')
    } else {
      $VenvDir.TrimEnd('\')
    }

    if (-not $ResolvedVenvDir.StartsWith($ResolvedScriptDir, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a virtual environment outside the helper folder: $ResolvedVenvDir"
    }

    if (Test-Path -LiteralPath $VenvDir) {
      Remove-Item -LiteralPath $VenvDir -Recurse -Force
    }

    & $PythonExe @PythonArgs -m venv .venv
  }

  if (-not (Test-VenvPython -Path $VenvPython)) {
    throw "Cannot start the virtual environment Python: $VenvPython"
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
