$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

# Packaging uses the verified runtime below instead of Electron's install download.
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm ci

$cache = Join-Path (Get-Location).Path 'build/ci-electron'
$runtime = Join-Path $cache 'runtime'
$env:ELECTRON_BUILDER_CACHE = Join-Path $cache 'builder'
New-Item -ItemType Directory -Path $cache -Force | Out-Null

$version = node -p "require('./package-lock.json').packages['node_modules/electron'].version"
$archive = "electron-v$version-win32-x64.zip"
$electronZip = Join-Path $cache $archive
gh release download "v$version" --repo electron/electron --pattern $archive --pattern SHASUMS256.txt --dir $cache --clobber

$checksumPattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($archive) + '$'
$checksum = Select-String -LiteralPath (Join-Path $cache 'SHASUMS256.txt') -Pattern $checksumPattern
if ($null -eq $checksum -or (Get-FileHash -LiteralPath $electronZip).Hash -ne $checksum.Matches[0].Groups[1].Value) {
    throw "Electron checksum mismatch for $archive"
}
Expand-Archive -LiteralPath $electronZip -DestinationPath $runtime -Force

# These releases and SHA-512 checksums are the ones used by electron-builder 24.
$builderAssets = @(
    @{
        Tag = 'winCodeSign-2.6.0'
        CacheFolder = 'winCodeSign'
        Sha512 = '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA=='
    },
    @{
        Tag = 'nsis-3.0.4.1'
        CacheFolder = 'nsis'
        Sha512 = 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q=='
    },
    @{
        Tag = 'nsis-resources-3.4.1'
        CacheFolder = 'nsis'
        Sha512 = 'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q=='
    }
)
$sevenZip = node -p "require('7zip-bin').path7za"
foreach ($tool in $builderAssets) {
    $archive = "$($tool.Tag).7z"
    $asset = Join-Path $cache $archive
    gh release download $tool.Tag --repo electron-userland/electron-builder-binaries --pattern $archive --dir $cache --clobber
    $expected = [Convert]::ToHexString([Convert]::FromBase64String($tool.Sha512))
    if ((Get-FileHash -LiteralPath $asset -Algorithm SHA512).Hash -ne $expected) {
        throw "electron-builder checksum mismatch for $archive"
    }
    $destination = Join-Path (Join-Path $env:ELECTRON_BUILDER_CACHE $tool.CacheFolder) $tool.Tag
    & $sevenZip x $asset "-o$destination" -bd -y
}

npm exec -- electron-builder --win --x64 --publish never "--config.electronDist=$runtime"
