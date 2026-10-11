$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$runtime = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$uv = Join-Path $runtime 'uv.exe'
if (!(Test-Path $uv)) {
    Write-Host 'Preparando o iniciador pela primeira vez...'
    $archive = Join-Path $runtime 'uv.zip'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/astral-sh/uv/releases/download/0.13.0/uv-x86_64-pc-windows-msvc.zip' -OutFile $archive
    $expected = '088962f9e7b7bd9ea740c04c650b2a21c8928c345bd99ac24350dc924dba656c'
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'O download do iniciador falhou na verificacao.' }
    Expand-Archive -Path $archive -DestinationPath $runtime -Force
    Remove-Item $archive
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtime 'python'
$env:UV_CACHE_DIR = Join-Path $runtime 'cache'
$env:UV_PYTHON_PREFERENCE = 'only-managed'
& $uv run --no-project --python 3.12 python launcher.py @args
exit $LASTEXITCODE
