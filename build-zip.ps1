<#
.SYNOPSIS
  Rebuilds jester-extension.zip from the working tree.

.DESCRIPTION
  Validates the extension before packing it, so a broken build fails here rather
  than at "Load unpacked":

    - manifest.json parses, and every path it names exists
    - every local src=/href= in the HTML pages resolves
    - the runtime assets the offscreen document fetches by URL exist
    - .env parses, and CURSOR is a boolean
    - every first-party .js parses (needs node on PATH; skipped if absent)

  .env ships inside the zip — it's read at runtime, not compiled in — so a
  published build carries whatever AI key is in it. The script says so.

  Then writes the zip with forward-slash entry names. Windows' own zip tools
  write backslashes, which the Chrome Web Store rejects.

.PARAMETER Flat
  Put manifest.json at the root of the zip. This is what the Chrome Web Store
  requires. The default nests everything under jester-extension/, which is
  friendlier for "unzip, then Load unpacked".

.PARAMETER IncludeDevFiles
  Keep source maps and .d.ts files, which are excluded by default.

.PARAMETER Versioned
  Name the zip after the manifest version, e.g. jester-extension-0.1.0.zip.

.NOTES
  Windows ships PowerShell as Restricted, so calling this file directly fails
  with "running scripts is disabled on this system". build-zip.cmd beside it
  runs it with -ExecutionPolicy Bypass for that one process, without changing
  anything on the machine. Prefer the .cmd unless your policy already allows
  scripts.

.EXAMPLE
  .\build-zip.cmd
  Rebuilds jester-extension.zip in place.

.EXAMPLE
  .\build-zip.cmd -Flat -Versioned
  Builds jester-extension-0.1.0.zip laid out for a Web Store upload.
#>

[CmdletBinding()]
param(
  [string]$Output,
  [switch]$Flat,
  [switch]$IncludeDevFiles,
  [switch]$Versioned,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src = Join-Path $Root 'jester-extension'

if (-not (Test-Path $Src)) {
  Write-Error "Extension folder not found: $Src"
}

# Dev-only files. Dropping the source map costs nothing at runtime — Chrome only
# looks for it when DevTools is open on the vendor bundle.
# .env.example is the committed template; the real .env has to ship, because
# src/common/env.js fetches it at runtime.
$DevPatterns = @('*.map', '*.d.ts', '.env.example')
$JunkPatterns = @('.DS_Store', 'Thumbs.db', 'desktop.ini', '*.zip', '*.orig', '*.rej', '*~')

$problems = New-Object System.Collections.Generic.List[string]
$notes = New-Object System.Collections.Generic.List[string]

function Add-Problem([string]$message) { $problems.Add($message) | Out-Null }

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

$manifestPath = Join-Path $Src 'manifest.json'
if (-not (Test-Path $manifestPath)) { Write-Error "No manifest.json in $Src" }

try {
  $manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
} catch {
  Write-Error "manifest.json is not valid JSON: $($_.Exception.Message)"
}

$version = $manifest.version
Write-Host "Jester $version" -ForegroundColor Cyan
Write-Host "  source: $Src"

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

function Test-Asset([string]$relative, [string]$because) {
  if ([string]::IsNullOrWhiteSpace($relative)) { return }
  $full = Join-Path $Src $relative
  if (-not (Test-Path $full)) { Add-Problem "$because -> missing '$relative'" }
}

function Get-ManifestPaths {
  $paths = New-Object System.Collections.Generic.List[object]
  $add = { param($p, $why) if ($p) { $paths.Add([pscustomobject]@{ Path = $p; Why = $why }) | Out-Null } }

  if ($manifest.PSObject.Properties.Name -contains 'background') {
    & $add $manifest.background.service_worker 'background.service_worker'
  }
  if ($manifest.PSObject.Properties.Name -contains 'action') {
    & $add $manifest.action.default_popup 'action.default_popup'
    if ($manifest.action.PSObject.Properties.Name -contains 'default_icon') {
      foreach ($p in $manifest.action.default_icon.PSObject.Properties) {
        & $add $p.Value "action.default_icon[$($p.Name)]"
      }
    }
  }
  if ($manifest.PSObject.Properties.Name -contains 'options_ui') {
    & $add $manifest.options_ui.page 'options_ui.page'
  }
  if ($manifest.PSObject.Properties.Name -contains 'icons') {
    foreach ($p in $manifest.icons.PSObject.Properties) { & $add $p.Value "icons[$($p.Name)]" }
  }
  if ($manifest.PSObject.Properties.Name -contains 'content_scripts') {
    $i = 0
    foreach ($cs in $manifest.content_scripts) {
      if ($cs.PSObject.Properties.Name -contains 'js') {
        foreach ($f in $cs.js) { & $add $f "content_scripts[$i].js" }
      }
      if ($cs.PSObject.Properties.Name -contains 'css') {
        foreach ($f in $cs.css) { & $add $f "content_scripts[$i].css" }
      }
      $i++
    }
  }
  if ($manifest.PSObject.Properties.Name -contains 'web_accessible_resources') {
    foreach ($war in $manifest.web_accessible_resources) {
      foreach ($f in $war.resources) {
        # Resource entries may be globs; only check the literal ones.
        if ($f -notmatch '[*?]') { & $add $f 'web_accessible_resources' }
      }
    }
  }
  return $paths
}

function Test-HtmlReferences {
  foreach ($html in Get-ChildItem -Path $Src -Recurse -File -Filter *.html) {
    if ($html.FullName -like "*\vendor\*") { continue }
    $text = Get-Content -Raw -Encoding UTF8 $html.FullName
    foreach ($m in [regex]::Matches($text, '(?:src|href)\s*=\s*"([^"]+)"')) {
      $ref = $m.Groups[1].Value
      if ($ref -match '^(https?:|//|data:|blob:|chrome-extension:|#|mailto:)') { continue }
      $clean = ($ref -split '[?#]')[0]
      if ([string]::IsNullOrWhiteSpace($clean)) { continue }
      $resolved = Join-Path $html.DirectoryName $clean
      if (-not (Test-Path $resolved)) {
        $rel = $html.FullName.Substring($Src.Length + 1)
        Add-Problem "$rel references '$ref', which does not exist"
      }
    }
  }
}

# Assets fetched at runtime through chrome.runtime.getURL(), so nothing above
# would catch them going missing.
function Test-RuntimeAssets {
  Test-Asset 'vendor/tasks-vision/vision_bundle.mjs' 'MediaPipe bundle'
  Test-Asset 'vendor/tasks-vision/wasm/vision_wasm_internal.js' 'MediaPipe WASM loader'
  Test-Asset 'vendor/tasks-vision/wasm/vision_wasm_internal.wasm' 'MediaPipe WASM binary'
  Test-Asset 'models/gesture_recognizer.task' 'Gesture model'
}

# .env is read at runtime by src/common/env.js. A missing file isn't fatal —
# every flag falls back to "leave it as it is" — but a *malformed* one silently
# switches a feature off, which is worth catching here rather than in Chrome.
#
# It also mirrors .env to env.txt. env.js tries the dotfile first and falls back
# to the mirror, because it isn't settled whether Chrome serves a dotfile out of
# an extension folder and it can't be checked from a script (Chrome 137 dropped
# --load-extension). Mirroring here is what keeps the fallback from going stale.
function Test-EnvFile {
  $envPath = Join-Path $Src '.env'
  $mirrorPath = Join-Path $Src 'env.txt'

  if (-not (Test-Path $envPath)) {
    $notes.Add('.env not found - the extension will fall back to CURSOR=true and no AI key') | Out-Null
    return
  }

  # Byte-for-byte, so the two can never differ by a line ending.
  $envBytes = [System.IO.File]::ReadAllBytes($envPath)
  $mirrorBytes = if (Test-Path $mirrorPath) { [System.IO.File]::ReadAllBytes($mirrorPath) } else { $null }
  $inStep = $null -ne $mirrorBytes -and
            $mirrorBytes.Length -eq $envBytes.Length -and
            -not (Compare-Object $mirrorBytes $envBytes -SyncWindow 0)
  if (-not $inStep) {
    [System.IO.File]::WriteAllBytes($mirrorPath, $envBytes)
    $notes.Add('refreshed env.txt from .env (the fallback the extension reads if Chrome will not serve a dotfile)') | Out-Null
  }

  $values = @{}
  foreach ($line in Get-Content -Encoding UTF8 $envPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $trimmed.Substring(0, $eq).Trim()
    $value = $trimmed.Substring($eq + 1).Trim()
    $values[$key] = $value
  }

  $cursor = if ($values.ContainsKey('CURSOR')) { $values['CURSOR'].ToLower() } else { '' }
  if ($cursor -and $cursor -notin @('true', 'false', '1', '0', 'yes', 'no', 'on', 'off')) {
    Add-Problem ".env: CURSOR is '$($values['CURSOR'])' - expected true or false"
  }
  if (-not $values.ContainsKey('CURSOR')) {
    $notes.Add('.env has no CURSOR line - defaulting to true') | Out-Null
  } else {
    $notes.Add("cursor feature: $(if ($cursor -in @('false','0','no','off')) { 'off' } else { 'on' })") | Out-Null
  }

  if (-not $values.ContainsKey('AI') -or -not $values['AI']) {
    $notes.Add('.env has no AI key - Jester will say so in the popup and options page') | Out-Null
  } else {
    $notes.Add('AI key present (never validated here, and it ships inside the zip)') | Out-Null
  }
}

function Test-JavaScript {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    $notes.Add('node not on PATH - skipped the JavaScript syntax check') | Out-Null
    return
  }
  $checked = 0
  foreach ($js in Get-ChildItem -Path (Join-Path $Src 'src') -Recurse -File -Filter *.js) {
    & $node.Source --check $js.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $rel = $js.FullName.Substring($Src.Length + 1)
      $detail = (& $node.Source --check $js.FullName 2>&1 | Select-Object -First 4) -join ' '
      Add-Problem "$rel failed to parse: $detail"
    }
    $checked++
  }
  $notes.Add("checked $checked first-party JavaScript file(s)") | Out-Null
}

if ($SkipChecks) {
  Write-Host "  checks: skipped (-SkipChecks)" -ForegroundColor Yellow
} else {
  Write-Host "  checks: " -NoNewline
  foreach ($entry in Get-ManifestPaths) { Test-Asset $entry.Path "manifest $($entry.Why)" }
  Test-HtmlReferences
  Test-RuntimeAssets
  Test-EnvFile
  Test-JavaScript

  if ($problems.Count -gt 0) {
    Write-Host "FAILED" -ForegroundColor Red
    Write-Host ""
    foreach ($p in $problems) { Write-Host "  x $p" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Nothing was written. Fix the above, or pass -SkipChecks to pack anyway." -ForegroundColor Yellow
    exit 1
  }
  Write-Host "passed" -ForegroundColor Green
  foreach ($n in $notes) { Write-Host "    - $n" -ForegroundColor DarkGray }
}

# ---------------------------------------------------------------------------
# Collect
# ---------------------------------------------------------------------------

$excluded = New-Object System.Collections.Generic.List[object]
$include = New-Object System.Collections.Generic.List[object]

$skipPatterns = $JunkPatterns
if (-not $IncludeDevFiles) { $skipPatterns = $skipPatterns + $DevPatterns }

foreach ($file in Get-ChildItem -Path $Src -Recurse -File -Force) {
  $rel = $file.FullName.Substring($Src.Length + 1).Replace('\', '/')
  if ($rel -match '(^|/)\.git(/|$)' -or $rel -match '(^|/)node_modules(/|$)') { continue }

  $skip = $false
  foreach ($pattern in $skipPatterns) {
    if ($file.Name -like $pattern) { $skip = $true; break }
  }
  if ($skip) {
    $excluded.Add([pscustomobject]@{ Path = $rel; Size = $file.Length }) | Out-Null
    continue
  }
  $include.Add([pscustomobject]@{ File = $file; Rel = $rel }) | Out-Null
}

if ($include.Count -eq 0) { Write-Error "Nothing to pack." }

# ---------------------------------------------------------------------------
# Pack
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Output)) {
  $name = if ($Versioned) { "jester-extension-$version.zip" } else { 'jester-extension.zip' }
  $Output = Join-Path $Root $name
}
if (-not [System.IO.Path]::IsPathRooted($Output)) { $Output = Join-Path $Root $Output }

# ZipArchiveMode lives in System.IO.Compression, CreateEntryFromFile in
# System.IO.Compression.FileSystem. PowerShell 5.1 preloads neither.
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

# Build beside the target and swap in at the end, so a failure halfway through
# leaves the previous zip intact.
$temp = "$Output.building"
if (Test-Path $temp) { Remove-Item $temp -Force }

$prefix = if ($Flat) { '' } else { 'jester-extension/' }
$archive = [System.IO.Compression.ZipFile]::Open($temp, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in ($include | Sort-Object { $_.Rel })) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $item.File.FullName,
      "$prefix$($item.Rel)",
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$replaced = Test-Path $Output
if ($replaced) { Remove-Item $Output -Force }
Move-Item $temp $Output

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

$zipSize = (Get-Item $Output).Length
# PowerShell 5.1's Measure-Object takes a property name, not a script block.
$rawSize = 0
foreach ($item in $include) { $rawSize += $item.File.Length }
$mb = { param($b) '{0:N1} MB' -f ($b / 1MB) }

Write-Host ""
Write-Host "Wrote $Output" -ForegroundColor Green
Write-Host "  layout:  $(if ($Flat) { 'manifest.json at root (Web Store)' } else { 'nested under jester-extension/' })"
Write-Host "  files:   $($include.Count)  ($(& $mb $rawSize) -> $(& $mb $zipSize) compressed)"
if ($replaced) { Write-Host "  replaced the previous zip" -ForegroundColor DarkGray }

if ($excluded.Count -gt 0) {
  $saved = ($excluded | Measure-Object -Property Size -Sum).Sum
  Write-Host "  excluded $($excluded.Count) dev file(s), $(& $mb $saved):" -ForegroundColor DarkGray
  foreach ($e in $excluded) { Write-Host "    - $($e.Path)" -ForegroundColor DarkGray }
  Write-Host "    (pass -IncludeDevFiles to keep them)" -ForegroundColor DarkGray
}

if (-not $Flat) {
  Write-Host ""
  Write-Host "Note: the Chrome Web Store needs manifest.json at the zip root." -ForegroundColor DarkGray
  Write-Host "      Build with -Flat when you are ready to publish." -ForegroundColor DarkGray
}

# The key ships inside the zip either way — .env is fetched at runtime, so it has
# to be in there. Warned about on every build rather than only on -Flat, because
# publishing is not the only way this gets out: .gitignore covers .env itself,
# and a zip built around it is the hole that leaves.
if ((Test-Path (Join-Path $Src '.env')) -and
    (Select-String -Path (Join-Path $Src '.env') -Pattern '^\s*AI\s*=\s*[^#\s]' -Quiet)) {
  Write-Host ""
  Write-Host "Warning: this zip contains .env, and .env contains an AI key." -ForegroundColor Yellow
  Write-Host "         Anyone who reads the zip can read the key. Do not commit or publish" -ForegroundColor Yellow
  Write-Host "         it as it stands - blank AI= first, or move the key behind a server" -ForegroundColor Yellow
  Write-Host "         you control." -ForegroundColor Yellow

  Push-Location $PSScriptRoot
  $tracked = (& git ls-files --error-unmatch $Output 2>$null)
  $isTracked = ($LASTEXITCODE -eq 0 -and $tracked)
  Pop-Location
  if ($isTracked) {
    Write-Host ""
    Write-Host "         git is tracking this zip, so committing would publish that key." -ForegroundColor Red
    Write-Host "         .gitignore cannot help - it does not apply to tracked files. Run:" -ForegroundColor Red
    Write-Host "           git rm --cached `"$(Split-Path -Leaf $Output)`"" -ForegroundColor Red
  }
}
