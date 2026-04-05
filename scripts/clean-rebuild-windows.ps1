# Synorix: MSVC + vcpkg, headless Release (no Qt). Run in Windows PowerShell or pwsh.
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\Synorix_Kopya\scripts\clean-rebuild-windows.ps1"
# Only compile (configure already done):
#   .\clean-rebuild-windows.ps1 -BuildOnly

#requires -Version 5.1
param(
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$cmakeExe = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'

if (-not (Test-Path -LiteralPath $cmakeExe)) {
    Write-Error "cmake.exe not found at:`n  $cmakeExe`nInstall the CMake component for Visual Studio or edit cmakeExe in this script."
}

if (-not $env:VCPKG_ROOT) {
    $env:VCPKG_ROOT = Join-Path $env:USERPROFILE 'vcpkg'
}
$vcpkgToolchain = Join-Path $env:VCPKG_ROOT 'scripts\buildsystems\vcpkg.cmake'
if (-not (Test-Path -LiteralPath $vcpkgToolchain)) {
    Write-Error "vcpkg not found. Clone a full (not shallow) tree, then bootstrap:`n  git clone https://github.com/microsoft/vcpkg.git `"$($env:VCPKG_ROOT)`"`n  & `"$($env:VCPKG_ROOT)\bootstrap-vcpkg.bat`" -disableMetrics`nOr set VCPKG_ROOT to your existing vcpkg path."
}

Set-Location -LiteralPath $repoRoot

if (-not $BuildOnly) {
    $buildDir = Join-Path $repoRoot 'build'
    if (Test-Path -LiteralPath $buildDir) {
        Remove-Item -LiteralPath $buildDir -Recurse -Force
    }
    & $cmakeExe @(
        '-B', 'build',
        '--preset', 'vs2026',
        '-DVCPKG_MANIFEST_NO_DEFAULT_FEATURES=ON',
        '-DVCPKG_MANIFEST_FEATURES=wallet',
        '-DBUILD_GUI=OFF',
        '-DWITH_ZMQ=OFF',
        '-DBUILD_TESTS=OFF',
        '-DBUILD_BENCH=OFF'
    )
}

& $cmakeExe @('--build', 'build', '--config', 'Release', '--parallel')

Write-Host ""
Write-Host "OK: $repoRoot\build\bin\Release\synorixd.exe"
Write-Host "    $repoRoot\build\bin\Release\synorix-cli.exe"
