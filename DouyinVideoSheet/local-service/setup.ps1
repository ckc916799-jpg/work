param([string]$PythonExe = '', [string]$PackageIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskCandidates = @()
if ($PythonExe) { $taskCandidates += $PythonExe }
$taskCandidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
)
$taskPython = $null
foreach ($taskCandidate in $taskCandidates) {
    if (Test-Path -LiteralPath $taskCandidate) {
        & $taskCandidate -c 'import sys; assert (3, 9) <= sys.version_info < (3, 14)' 2>$null
        if ($LASTEXITCODE -eq 0) { $taskPython = $taskCandidate; break }
    }
}
if (-not $taskPython) {
    $taskPythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($taskPythonCommand -and $taskPythonCommand.Source -notmatch 'WindowsApps') { $taskPython = $taskPythonCommand.Source }
}
if (-not $taskPython) { throw 'Python 3.9-3.13 is required. Install Python from python.org, then run this script again.' }
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    & $taskPython -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python environment.' }
}
& '.\.venv\Scripts\python.exe' -m pip install -r requirements.txt --index-url $PackageIndex --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Dependency download failed. Check network, then run setup again.' }
& '.\.venv\Scripts\python.exe' -c 'from server import read_token; read_token()'
if ($LASTEXITCODE -ne 0) { throw 'Could not create connection token.' }
Write-Host 'Setup complete. Run Start-Service.bat. Copy connection-token.txt into this extension once.'
