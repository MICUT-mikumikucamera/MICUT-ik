param(
    [Parameter(Mandatory=$true)][string]$Model,
    [Parameter(Mandatory=$true)][string]$Spatial,
    [string]$Placement,
    [string]$Profile,
    [string]$Out,
    [string]$Blender = $env:BLENDER_BIN,
    [int]$Samples = 16,
    [switch]$InspectOnly,
    [switch]$SaveScene
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $Blender) {
    $blenderCommand = Get-Command blender -ErrorAction SilentlyContinue
    if ($blenderCommand) { $Blender = $blenderCommand.Source }
    else { throw 'Set BLENDER_BIN or pass -Blender with the Blender executable path.' }
}
if (-not $Placement) { $Placement = Join-Path $repoRoot 'examples/placement.stand.json' }
if (-not $Profile) { $Profile = Join-Path $repoRoot 'examples/model_profile.json' }
if (-not $Out) { $Out = Join-Path $repoRoot 'outputs/stand' }
$arguments = @('--background', (Resolve-Path -LiteralPath $Model).Path, '--disable-autoexec',
    '--python-exit-code', '1', '--python', (Join-Path $repoRoot 'tools/render_stand.py'), '--',
    '--spatial', (Resolve-Path -LiteralPath $Spatial).Path,
    '--placement', (Resolve-Path -LiteralPath $Placement).Path,
    '--profile', (Resolve-Path -LiteralPath $Profile).Path,
    '--out', [IO.Path]::GetFullPath($Out), '--samples', [string]$Samples)
if ($InspectOnly) { $arguments += '--inspect-only' }
if ($SaveScene) { $arguments += '--save-scene' }
& $Blender @arguments
if ($LASTEXITCODE -ne 0) { throw "Render failed: exit $LASTEXITCODE. See error.json in $Out" }
