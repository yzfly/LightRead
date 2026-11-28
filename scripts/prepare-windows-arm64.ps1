# sherpa-onnx-sys 1.13.3 has ARM64 Windows libraries, but its download table only lists Windows x64.
$ErrorActionPreference = 'Stop'
$version = '1.13.3'
$sha256 = 'b198b3227e5b87018bc99584d0e8a7b5f895e07550b39c6b0db7f577d632a5b3'
$lock = Get-Content (Join-Path $PSScriptRoot '../src-tauri/Cargo.lock') -Raw
$lockedVersion = [regex]::Match($lock, '(?m)^name = "sherpa-onnx-sys"\r?\nversion = "([^"]+)"').Groups[1].Value
if ($lockedVersion -ne $version) {
    throw "Cargo.lock selects sherpa-onnx-sys $lockedVersion. Update the Windows ARM64 archive and checksum."
}

$stem = "sherpa-onnx-v$version-win-arm64-static-MT-Release-lib"
$cache = (New-Item -Force -ItemType Directory (Join-Path $PSScriptRoot '../src-tauri/target/sherpa-onnx-prebuilt')).FullName
$archive = Join-Path $cache "$stem.tar.bz2"
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash -ne $sha256) {
    $download = "$archive.$PID.tmp"
    try {
        Invoke-WebRequest "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$version/$stem.tar.bz2" -OutFile $download
        if ((Get-FileHash $download -Algorithm SHA256).Hash -ne $sha256) {
            throw "SHA-256 mismatch for $stem.tar.bz2"
        }
        Move-Item -Force $download $archive
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
    }
}
tar -xf $archive -C $cache
if ($LASTEXITCODE -ne 0) { throw "Failed to extract $archive" }
$lib = Join-Path $cache "$stem/lib"
if (!(Test-Path -LiteralPath (Join-Path $lib 'sherpa-onnx-c-api.lib'))) { throw "Missing ARM64 libraries in $lib" }
$env:SHERPA_ONNX_LIB_DIR = $lib
if ($env:GITHUB_ENV) { "SHERPA_ONNX_LIB_DIR=$lib" | Out-File -Encoding utf8 -Append $env:GITHUB_ENV }
