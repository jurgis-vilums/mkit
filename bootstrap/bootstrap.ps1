# mkit bootstrap for Windows:
#   & ([scriptblock]::Create((irm <raw>/bootstrap.ps1))) -From <dashboard-url> -Code <pairing-code>
param(
  [Parameter(Mandatory)][string]$From,
  [Parameter(Mandatory)][string]$Code,
  [string]$KitDir = "$HOME\.mkit\kit",
  [switch]$SkipTailscale,
  [switch]$NoClone
)
$ErrorActionPreference = 'Stop'
function Need($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
if (-not (Need winget)) { throw 'winget is required (App Installer from the Microsoft Store)' }
$pk = @{ git = 'Git.Git'; node = 'OpenJS.NodeJS.LTS' }
if (-not $SkipTailscale) { $pk.tailscale = 'Tailscale.Tailscale' }
foreach ($k in $pk.Keys) {
  if (-not (Need $k)) {
    winget install --id $pk[$k] -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget install $($pk[$k]) failed ($LASTEXITCODE)" }
    Refresh-Path
  }
}
if (-not $SkipTailscale) {
  tailscale status *> $null
  if ($LASTEXITCODE -ne 0) { tailscale up; if ($LASTEXITCODE -ne 0) { throw 'tailscale up failed' } }
}
if (-not $NoClone) {
  if (Test-Path "$KitDir\.git") { git -C $KitDir pull --ff-only } else { git clone https://github.com/jurgis-vilums/mkit $KitDir }
  if ($LASTEXITCODE -ne 0) { throw 'cloning the kit failed' }
}
Push-Location $KitDir
npm ci --omit=dev; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
Pop-Location
node "$KitDir\bin\mkit.js" import --from $From --code $Code
exit $LASTEXITCODE
