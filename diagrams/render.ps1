param(
  [Parameter(Mandatory = $true)][string]$Svg,
  [Parameter(Mandatory = $true)][string]$Png,
  [int]$Scale = 1
)
# Rasterize an SVG with headless Edge. ASCII only: PS 5.1 reads .ps1 as ANSI and GBK-mojibake eats newlines.
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$full = (Resolve-Path -LiteralPath $Svg).Path
$xml = Get-Content -LiteralPath $full -Raw -Encoding UTF8
$w = [int][double]([regex]::Match($xml, 'width="([\d.]+)"').Groups[1].Value)
$h = [int][double]([regex]::Match($xml, 'height="([\d.]+)"').Groups[1].Value)
$out = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Png))
$uri = 'file:///' + ($full -replace '\\', '/')
$profile = Join-Path (Get-Location) 'out/.edge-profile'
& $edge --headless=new --disable-gpu --no-first-run --user-data-dir="$profile" `
  --hide-scrollbars --force-device-scale-factor=$Scale --window-size="$w,$h" `
  --screenshot="$out" "$uri" 2>$null | Out-Null
if (Test-Path $out) { "rendered $Png  ${w}x${h}" } else { "FAILED $Png"; exit 1 }
