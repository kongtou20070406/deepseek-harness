[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet("off", "minimal", "low", "medium", "high", "xhigh", "max")]
  [string]$Thinking = "max",
  [ValidateRange(0, 65535)]
  [int]$Port = 43120,
  [switch]$Offline,
  [switch]$NoOpen
)

$server = Join-Path $PSScriptRoot "pi-idea-extension\web\server.js"
if (-not (Test-Path -LiteralPath $server)) {
  throw "Pi-Idea Web server is missing: $server"
}

$arguments = @($server, "--port", [string]$Port, "--thinking", $Thinking)
if ($Offline) { $arguments += "--offline" }
if (-not $NoOpen) { $arguments += "--open" }

Push-Location -LiteralPath $PSScriptRoot
try {
  & node @arguments
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
