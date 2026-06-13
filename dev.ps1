# dev.ps1 - start the sofa server with the worker tokens loaded.
#
# Tokens are read from a gitignored file (.tokens.local, next to this script).
# First run: if the file is missing, you're prompted once and it's created.
# Every run after that loads silently - you never think about tokens again.
#
# The tokens are exported into THIS process only and inherited by the npm/server
# child. They are not added to your user/global environment.
#
# Usage:
#   .\dev.ps1            # load tokens (prompting only if needed) and start server
#   .\dev.ps1 -Reset     # re-prompt and overwrite the saved tokens

param(
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$TokenFile = Join-Path $PSScriptRoot '.tokens.local'

function Read-SecretLine {
    param([string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )
}

# --- Obtain tokens: from file if present, otherwise prompt once and save. ------
if ((Test-Path $TokenFile) -and -not $Reset) {
    # File format: NAME=value, one per line.
    foreach ($line in Get-Content $TokenFile) {
        if ($line -match '^\s*([^=#]+?)\s*=\s*(.+)$') {
            Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
        }
    }
    Write-Host "Loaded tokens from .tokens.local" -ForegroundColor DarkGray
}
else {
    Write-Host "== first-time token setup ==" -ForegroundColor Cyan
    $claude = Read-SecretLine -Prompt 'Claude OAuth token (sk-ant-oat01-...)'
    $github = Read-SecretLine -Prompt 'GitHub fine-grained PAT (github_pat_...)'
    if (-not $claude -or -not $github) { throw "Both tokens are required." }

    Set-Content -Path $TokenFile -Encoding utf8 -Value @(
        "CLAUDE_CODE_OAUTH_TOKEN=$claude",
        "GITHUB_TOKEN=$github"
    )
    $env:CLAUDE_CODE_OAUTH_TOKEN = $claude
    $env:GITHUB_TOKEN = $github
    Write-Host "Saved to .tokens.local (gitignored). Future startups won't prompt." -ForegroundColor Green
}

# --- Sanity check, then launch. ------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found on PATH - is Docker Desktop installed and running?"
}

Write-Host "Starting server (npm run dev)..." -ForegroundColor Green
npm run dev
