[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet("off", "minimal", "low", "medium", "high", "xhigh", "max")]
  [string]$Thinking,
  [switch]$Offline,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PiArgs
)

$projectRoot = $PSScriptRoot
$piCommand = Join-Path $projectRoot "pi-idea-extension\node_modules\.bin\pi.CMD"
if (-not (Test-Path -LiteralPath $piCommand)) {
  throw "Pi 0.84.1 is not installed. Run 'pnpm install --frozen-lockfile' in pi-idea-extension first."
}

$arguments = @(
  "--provider", "openai-codex",
  "--model", "gpt-5.6-sol",
  "--approve"
)
if ($Thinking) { $arguments += @("--thinking", $Thinking) }
if ($Offline) { $arguments += "--offline" }
if ($PiArgs) { $arguments += $PiArgs }

Push-Location -LiteralPath $projectRoot
try {
  & $piCommand @arguments
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
