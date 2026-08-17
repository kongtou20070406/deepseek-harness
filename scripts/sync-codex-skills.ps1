[CmdletBinding()]
param(
  [string] $CodexSkillRoot = 'C:\Users\XU\.codex\skills',
  [string] $DshHome = (Join-Path (Split-Path -Parent $PSScriptRoot) '.dsh-dev'),
  [string] $DshEngineeringSkillRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.agents\skills')
)

$ErrorActionPreference = 'Stop'

$portableSkills = [ordered]@{
  'academic-paper' = 'academic-paper'
  'academic-paper-reviewer' = 'academic-paper-reviewer'
  'academic-research-suite' = 'academic-research-suite'
  'deep-research' = 'deep-research'
  'idea_spark' = 'idea-spark'
  'nn-svg-diagram' = 'nn-svg-diagram'
  'paper_search' = 'paper-search'
  'paper2assets' = 'paper2assets'
  'paper2blog' = 'paper2blog'
  'paper2poster' = 'paper2poster'
  'paper2reel' = 'paper2reel'
  'paper2video' = 'paper2video'
  'powershell-skill' = 'powershell-skill'
  'scoop_check' = 'scoop-check'
  'workflow-design' = 'workflow-design'
}

$excluded = [ordered]@{
  'codex-model-routing-team' = 'Requires Codex task-management APIs that DSH does not expose.'
  'gstack' = 'Already discovered from C:\Users\XU\.agents\skills; copying it would shadow the shared installation.'
  '.system' = 'Codex-owned product and plugin authoring Skills depend on Codex-only tools.'
}

$engineeringSkillNames = @(
  'dsh-archive-agent-notes',
  'dsh-code-review',
  'dsh-doc-site-sync',
  'dsh-doc-standards',
  'dsh-find-simplifications',
  'dsh-merging-stacked-prs',
  'dsh-pre-push-checks',
  'dsh-prose-standard',
  'dsh-translate-docs',
  'dsh-trim-cot-leakage',
  'record-browser-gif'
)

if (-not (Test-Path -LiteralPath $CodexSkillRoot -PathType Container)) {
  throw "Codex skill root is missing: $CodexSkillRoot"
}

$destinationRoot = Join-Path $DshHome 'skills'
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$installed = [System.Collections.Generic.List[object]]::new()
$engineeringInstalled = [System.Collections.Generic.List[object]]::new()

foreach ($entry in $portableSkills.GetEnumerator()) {
  $source = Join-Path $CodexSkillRoot $entry.Key
  $skillFile = Join-Path $source 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
    throw "Portable Codex skill is missing SKILL.md: $skillFile"
  }

  $destination = Join-Path $destinationRoot $entry.Value
  if (Test-Path -LiteralPath $destination) {
    $item = Get-Item -LiteralPath $destination -Force
    $target = @($item.Target) | Select-Object -First 1
    if ($item.LinkType -ne 'Junction' -or -not [string]::Equals(
      [System.IO.Path]::GetFullPath([string] $target),
      [System.IO.Path]::GetFullPath($source),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "DSH skill destination exists and is not the expected Junction: $destination"
    }
  }
  else {
    New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
  }
  $installed.Add([pscustomobject]@{
    name = $entry.Value
    source = $source
    destination = $destination
    mode = 'junction'
  })
}

foreach ($name in $engineeringSkillNames) {
  $source = Join-Path $DshEngineeringSkillRoot $name
  $skillFile = Join-Path $source 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
    throw "DSH engineering skill is missing SKILL.md: $skillFile"
  }

  $destination = Join-Path $destinationRoot $name
  if (Test-Path -LiteralPath $destination) {
    $item = Get-Item -LiteralPath $destination -Force
    $target = @($item.Target) | Select-Object -First 1
    if ($item.LinkType -ne 'Junction' -or -not [string]::Equals(
      [System.IO.Path]::GetFullPath([string] $target),
      [System.IO.Path]::GetFullPath($source),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "DSH engineering skill destination exists and is not the expected Junction: $destination"
    }
  }
  else {
    New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
  }
  $engineeringInstalled.Add([pscustomobject]@{
    name = $name
    source = $source
    destination = $destination
    mode = 'junction'
  })
}

$manifest = [ordered]@{
  generatedAt = [DateTimeOffset]::Now.ToString('o')
  dshHome = $DshHome
  installed = $installed
  dshEngineeringSkills = $engineeringInstalled
  inheritedFromAgentsHome = @('gstack', 'netease-uu-booster', 'obelisk')
  excluded = @($excluded.GetEnumerator() | ForEach-Object {
    [pscustomobject]@{ name = $_.Key; reason = $_.Value }
  })
}

$manifestPath = Join-Path $DshHome 'codex-skill-sync.json'
[System.IO.File]::WriteAllText(
  $manifestPath,
  (($manifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)

Write-Output ("Linked {0} portable Codex Skills into {1}" -f $installed.Count, $destinationRoot)
Write-Output ("Linked {0} DSH engineering Skills into {1}" -f $engineeringInstalled.Count, $destinationRoot)
Write-Output ("Manifest: {0}" -f $manifestPath)
Write-Output 'Codex-only Skills remain excluded instead of advertising unavailable tools to DSH.'
