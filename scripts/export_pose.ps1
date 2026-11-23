param(
    [Parameter(Mandatory=$true)][string]$PosedBlend,
    [Parameter(Mandatory=$true)][string]$PoseId,
    [string]$Base,
    [ValidateSet('stand', 'sit')][string]$Action,
    [string]$Description = '',
    [string]$Out,
    [string]$Blender = $env:BLENDER_BIN
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $Blender) {
    $blenderCommand = Get-Command blender -ErrorAction SilentlyContinue
    if ($blenderCommand) { $Blender = $blenderCommand.Source }
    else { throw 'Set BLENDER_BIN or pass -Blender with the Blender executable path.' }
}
if (-not $Out) { $Out = Join-Path $repoRoot "poses/$PoseId.json" }
$arguments = @('--background', (Resolve-Path -LiteralPath $PosedBlend).Path, '--disable-autoexec',
    '--python-exit-code', '1', '--python', (Join-Path $repoRoot 'tools/export_pose.py'), '--',
    '--pose-id', $PoseId, '--out', [IO.Path]::GetFullPath($Out), '--description', $Description)
if ($Base) { $arguments += @('--base', (Resolve-Path -LiteralPath $Base).Path) }
if ($Action) { $arguments += @('--action', $Action) }
& $Blender @arguments
if ($LASTEXITCODE -ne 0) { throw "Pose export failed: exit $LASTEXITCODE" }
