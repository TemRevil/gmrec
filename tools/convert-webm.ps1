param(
  [Parameter(Mandatory = $true)]
  [string]$Folder,
  [string]$Filter = "gmrec-*.webm",
  [switch]$Overwrite
)

$ErrorActionPreference = "Stop"
$ffmpegCommand = Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue
if (-not $ffmpegCommand) { throw "FFmpeg is not on PATH. Install FFmpeg, reopen PowerShell, and try again." }
$resolvedFolder = (Resolve-Path -LiteralPath $Folder).Path
if (-not (Test-Path -LiteralPath $resolvedFolder -PathType Container)) { throw "Folder must be a directory." }
$files = Get-ChildItem -LiteralPath $resolvedFolder -Filter $Filter -File | Where-Object Extension -EQ ".webm"
if (-not $files) {
  throw "No GMRec WebM files found in $Folder"
}

foreach ($file in $files) {
  $output = [System.IO.Path]::ChangeExtension($file.FullName, ".mp4")
  if ((Test-Path -LiteralPath $output) -and -not $Overwrite) {
    Write-Host "Skipping existing MP4: $output (use -Overwrite to replace)"
    continue
  }
  $temporaryOutput = Join-Path $resolvedFolder (".gmrec-" + [guid]::NewGuid().ToString("N") + ".tmp.mp4")
  try {
    # Encode to a separate file so a failed conversion never damages an existing MP4.
    & $ffmpegCommand.Source -nostdin -n -i $file.FullName -c:v libx264 -preset medium -crf 18 -r 30 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:a aac -b:a 192k -movflags +faststart $temporaryOutput
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed for $($file.Name). The source WebM was preserved." }
    Move-Item -LiteralPath $temporaryOutput -Destination $output -Force:$Overwrite
    Write-Host "Created $output"
  } finally {
    if (Test-Path -LiteralPath $temporaryOutput) { Remove-Item -LiteralPath $temporaryOutput }
  }
}
