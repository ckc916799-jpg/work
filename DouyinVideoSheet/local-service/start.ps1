$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:18766/health' -TimeoutSec 2
    if ($taskHealth.app -eq 'douyin-video-sheet' -and $taskHealth.version -eq '1.2.0') { Write-Host 'Video Sheet service is already running.'; exit 0 }
    if ($taskHealth.app -eq 'douyin-video-sheet') { throw 'An older Video Sheet service is running. Run Stop-Service.bat from the old folder, then Start-Service.bat from this version.' }
    throw 'Port 18766 is used by another application.'
} catch {
    if ($_.Exception.Message -eq 'Port 18766 is used by another application.' -or $_.Exception.Message -like 'An older Video Sheet service*') { throw }
}
$taskPython = Join-Path $PSScriptRoot '.venv\Scripts\pythonw.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Run Setup-Excel.bat first.' }
$taskRuntime = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force -Path $taskRuntime | Out-Null
$taskScript = Join-Path $PSScriptRoot 'server.py'
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList @("`"$taskScript`"") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $taskRuntime 'server-error.log') -RedirectStandardOutput (Join-Path $taskRuntime 'server.log')
for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:18766/health' -TimeoutSec 1
        if ($taskHealth.app -eq 'douyin-video-sheet' -and $taskHealth.version -eq '1.2.0') { Write-Host 'Video Sheet service started. To stop it, run Stop-Service.bat.'; exit 0 }
    } catch {}
    if ($taskProcess.HasExited) { break }
}
throw 'Service could not start. Check .runtime\server-error.log.'
