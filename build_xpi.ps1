param(
    [switch]$ShowVersion
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-RelativePathNormalized {
    param(
        [string]$RootPath,
        [string]$FullPath
    )

    $rootResolved = [System.IO.Path]::GetFullPath((Resolve-Path -Path $RootPath).Path).TrimEnd('\\')
    $fullResolved = [System.IO.Path]::GetFullPath((Resolve-Path -Path $FullPath).Path)

    $prefix = $rootResolved + '\'
    if (-not $fullResolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path '$fullResolved' is outside root '$rootResolved'"
    }

    $relative = $fullResolved.Substring($prefix.Length)
    return $relative -replace '\\', '/'
}

function New-XpiArchive {
    param(
        [string]$RootPath,
        [string[]]$Items,
        [string]$DestinationPath
    )

    if (Test-Path $DestinationPath) {
        Remove-Item -Path $DestinationPath -Force
    }

    $fileStream = [System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::CreateNew)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            foreach ($item in $Items) {
                $fullItemPath = Join-Path $RootPath $item
                if (-not (Test-Path $fullItemPath)) {
                    throw "Build item not found: $item"
                }

                if ((Get-Item $fullItemPath) -is [System.IO.DirectoryInfo]) {
                    $files = Get-ChildItem -Path $fullItemPath -Recurse -File
                    foreach ($file in $files) {
                        $entryName = Get-RelativePathNormalized -RootPath $RootPath -FullPath $file.FullName
                        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::NoCompression) | Out-Null
                    }
                }
                else {
                    $entryName = Get-RelativePathNormalized -RootPath $RootPath -FullPath $fullItemPath
                    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $fullItemPath, $entryName, [System.IO.Compression.CompressionLevel]::NoCompression) | Out-Null
                }
            }
        }
        finally {
            $zip.Dispose()
        }
    }
    finally {
        $fileStream.Dispose()
    }
}

$manifestPath = Join-Path $PSScriptRoot 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "manifest.json not found at $manifestPath"
}

$manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
$currentVersion = [string]$manifest.version

if ($ShowVersion) {
    Write-Output $currentVersion
    exit 0
}

$newVersion = $null
if ($currentVersion -match '^(\d+)\.(\d+)\.(\d+)$') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3] + 1
    $newVersion = "$major.$minor.$patch"
}
else {
    $newVersion = '0.0.1'
}

$manifest.version = $newVersion
$manifest.author = 'Khodami Aaron'
$manifestJson = $manifest | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)

$definitionBuilderPath = Join-Path $PSScriptRoot 'script_definition_builder.py'
if (Test-Path $definitionBuilderPath) {
    $builderRan = $false

    if (Get-Command python -ErrorAction SilentlyContinue) {
        python $definitionBuilderPath
        if ($LASTEXITCODE -eq 0) {
            $builderRan = $true
        }
    }

    if (-not $builderRan -and (Get-Command py -ErrorAction SilentlyContinue)) {
        py -3 $definitionBuilderPath
        if ($LASTEXITCODE -eq 0) {
            $builderRan = $true
        }
    }

    if (-not $builderRan) {
        Write-Warning 'Could not run script_definition_builder.py automatically. Using existing init/00-script-definitions.js.'
    }
}

$buildItems = @(
    'bootstrap.js',
    'locale',
    'manifest.json',
    'prefs.js',
    'chrome',
    'preferences',
    'src',
    'lib',
    'init'
)

$outputXpi = Join-Path $PSScriptRoot ("zotgit-$newVersion-fx.xpi")

if (Test-Path $outputXpi) {
    Remove-Item -Path $outputXpi -Force
}

New-XpiArchive -RootPath $PSScriptRoot -Items $buildItems -DestinationPath $outputXpi

Write-Output "Version updated: $currentVersion -> $newVersion"
Write-Output "XPI created: $outputXpi"
