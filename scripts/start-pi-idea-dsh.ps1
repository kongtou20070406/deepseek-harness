[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int] $Port = 3080
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dshHome = Join-Path $repositoryRoot '.dsh-dev'
$builtCliEntry = Join-Path $repositoryRoot 'apps\cli\lib\bin.js'
$sourceCliEntry = Join-Path $repositoryRoot 'apps\cli\src\bin.ts'
$node = 'C:\Program Files\nodejs\node.exe'

foreach ($requiredPath in @($dshHome, $sourceCliEntry, $node)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Pi-Idea DSH startup path is missing: $requiredPath"
  }
}

$env:DSH_HOME = $dshHome
$env:DSH_BUNDLED_SKILL_DIR = Join-Path $repositoryRoot 'packages\bundle\pi-idea-context\skills'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = '127.0.0.1,localhost'
$env:NODE_USE_ENV_PROXY = '1'

Push-Location -LiteralPath $repositoryRoot
try {
  $nodeArguments = if (Test-Path -LiteralPath $builtCliEntry) {
    @('--use-env-proxy', $builtCliEntry, 'web', '--port', [string] $Port)
  }
  else {
    @('--use-env-proxy', '--import', 'tsx/esm', $sourceCliEntry, 'web', '--port', [string] $Port)
  }
  & $node $nodeArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Pi-Idea DSH exited with code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}
