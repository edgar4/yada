$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "edgar4/yada"
$Version = if ($env:YADA_VERSION) { $env:YADA_VERSION } else { "latest" }
$Dir = if ($env:YADA_INSTALL_DIR) { $env:YADA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\yada" }
if (-not [Environment]::Is64BitOperatingSystem) { throw "yada needs 64-bit Windows." }

$Asset = "yada-windows-x64.zip"
$Base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))" }
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory $Tmp | Out-Null
try {
  Invoke-WebRequest "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset) -UseBasicParsing
  Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS") -UseBasicParsing
  $Line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match " $([regex]::Escape($Asset))$" }
  $Expected = if ($Line) { ($Line -split " ")[0] } else { "" }
  $Actual = (Get-FileHash (Join-Path $Tmp $Asset) -Algorithm SHA256).Hash.ToLower()
  if (-not $Expected -or $Expected -ne $Actual) { throw "Checksum mismatch for $Asset" }
  New-Item -ItemType Directory -Force $Dir | Out-Null
  Expand-Archive (Join-Path $Tmp $Asset) -DestinationPath $Dir -Force
} finally {
  Remove-Item -Recurse -Force $Tmp
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $Dir) {
  [Environment]::SetEnvironmentVariable("Path", (($UserPath, $Dir) | Where-Object { $_ }) -join ";", "User")
  $env:Path = "$env:Path;$Dir"
  Write-Host "Added $Dir to your PATH. Open a new terminal to use yada everywhere."
}
Write-Host "Installed yada $(& (Join-Path $Dir 'yada.exe') --version) to $Dir"
