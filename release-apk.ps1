param(
  [string]$Notes = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Repo = "LuisSG9915/XALLAPAN_ANDROID"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$gradle = Get-Content "android/app/build.gradle" -Raw
$vc = [regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value
$vn = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value
if (-not $vc -or -not $vn) {
  Write-Error "No se encontraron versionCode/versionName en android/app/build.gradle"
  exit 1
}

$tag = "v$vn+$vc"
$apk = "$env:USERPROFILE\.xallapan\android-build\outputs\apk\release\app-release.apk"
$manifest = Join-Path $env:TEMP "xallapan-update-$vc.json"

if (-not $SkipBuild) {
  Write-Host "[1/4] Compilando release $vn (versionCode $vc)..."
  Push-Location android
  & .\gradlew.bat assembleRelease
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Error "Fallo la compilacion"
    exit 1
  }
  Pop-Location
}

if (-not (Test-Path $apk)) {
  Write-Error "No se encontro el APK en $apk"
  exit 1
}

$cred = "protocol=https", "host=github.com", "" | git credential fill
$token = ($cred | Select-String '^password=' | Select-Object -First 1).Line -replace '^password=', ''
if (-not $token) {
  Write-Error "No hay credencial de GitHub almacenada. Ejecuta 'git fetch' una vez para guardarla."
  exit 1
}
$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

Write-Host "[2/4] Generando update.json..."
$sha = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $apk).Length
$json = @{
  versionCode = [int]$vc
  versionApp = $vn
  sha256 = $sha
  tamanoBytes = $size
  obligatoria = $true
  forzarInmediata = $false
  permitirPosponerDatos = $true
  plataforma = "android"
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($manifest, $json)

Write-Host "[3/4] Publicando release $tag en GitHub..."
$api = "https://api.github.com/repos/$Repo/releases"
$rel = $null
try { $rel = Invoke-RestMethod "$api/tags/$tag" -Headers $headers } catch {}
if ($rel) {
  Write-Host "    El release $tag ya existe, actualizando assets..."
} else {
  $body = @{
    tag_name = $tag
    name = "Xallapan $vn ($vc)"
    body = $Notes
    draft = $false
    prerelease = $false
  } | ConvertTo-Json
  $rel = Invoke-RestMethod $api -Method Post -Headers $headers -Body $body -ContentType "application/json; charset=utf-8"
}
$relId = $rel.id

function Upload-Asset($path, $name, $contentType) {
  $existing = (Invoke-RestMethod "$api/$relId/assets?per_page=100" -Headers $headers) | Where-Object { $_.name -eq $name }
  foreach ($asset in $existing) {
    Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/assets/$($asset.id)" -Method Delete -Headers $headers | Out-Null
  }
  $bytes = [IO.File]::ReadAllBytes($path)
  Invoke-RestMethod "https://uploads.github.com/repos/$Repo/releases/$relId/assets?name=$name" -Method Post -Headers $headers -Body $bytes -ContentType $contentType | Out-Null
  Write-Host "    Subido: $name"
}

Upload-Asset $apk "app-release.apk" "application/vnd.android.package-archive"
Upload-Asset $manifest "update.json" "application/json"

Write-Host "[4/4] Listo: https://github.com/$Repo/releases"
Write-Host "     La app detectara la version nueva al abrirla o en su sondeo de 15 min."
