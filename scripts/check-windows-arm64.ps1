$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$bundle = "src-tauri/target/aarch64-pc-windows-msvc/release/bundle/nsis/LightRead_${version}_arm64-setup.exe"
$installer = (Resolve-Path $bundle).Path
$installDir = Join-Path $env:RUNNER_TEMP 'LightRead-ARM64'

$setup = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "NSIS installer exited with $($setup.ExitCode)" }
$exe = Join-Path $installDir 'lightread.exe'
$stream = [IO.BinaryReader]::new([IO.File]::OpenRead($exe))
try {
    $stream.BaseStream.Position = 0x3c
    $stream.BaseStream.Position = $stream.ReadInt32()
    if ($stream.ReadUInt32() -ne 0x4550 -or $stream.ReadUInt16() -ne 0xaa64) {
        throw 'The installed LightRead executable must be an ARM64 PE image.'
    }
} finally {
    $stream.Dispose()
}

$app = Start-Process -FilePath $exe -PassThru
try {
    $until = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 500
        $app.Refresh()
        if ($app.HasExited) { throw "LightRead exited during startup with $($app.ExitCode)" }
    } until ($app.MainWindowHandle -ne 0 -or (Get-Date) -gt $until)
    if ($app.MainWindowHandle -eq 0) { throw 'LightRead did not open a window.' }
    Write-Host "Installed ARM64 LightRead $version and opened its window."
} finally {
    if (!$app.HasExited) { Stop-Process -Id $app.Id }
}

# Older x64 updaters accept any *setup.exe. Give ARM64 a distinct public suffix.
New-Item -ItemType Directory -Force dist-installer | Out-Null
Copy-Item $installer "dist-installer/LightRead_${version}_arm64-installer.exe"
