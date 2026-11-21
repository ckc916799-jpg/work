$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $taskToken = (Get-Content -LiteralPath 'connection-token.txt' -Raw).Trim()
    Invoke-RestMethod -Uri 'http://127.0.0.1:18766/shutdown' -Method Post -Headers @{'X-Sheet-Token'=$taskToken} -TimeoutSec 5 | Out-Null
    Write-Host 'Video Sheet service stopped.'
} catch {
    Write-Host 'No running Video Sheet service found, or connection token does not match.'
}
