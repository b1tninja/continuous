#Requires -Version 5.1
<#
.SYNOPSIS
    Continuous CLI Installer for Windows
.DESCRIPTION
    Installs Node.js 22 (if needed) and the Continuous CLI (@b1tninja/continuous-cli)
    globally from the GitHub release tarball. It provides the commands `continuous`
    and `cn`. Re-running upgrades in place. No telemetry.
.PARAMETER Version
    Install this release, e.g. 2.14.0 (default: the latest release).
    The environment variable CONTINUOUS_CLI_VERSION does the same.
.PARAMETER Url
    Install this exact tarball URL (overrides Version and the lookup).
    The environment variable CONTINUOUS_CLI_URL does the same.
.EXAMPLE
    # Read it before you run it:
    irm https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.ps1 -OutFile install.ps1
    notepad install.ps1
    .\install.ps1
.EXAMPLE
    # In one step, once you have inspected it:
    irm https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.ps1 | iex
.EXAMPLE
    # Pin a version when piping (a piped script cannot take parameters):
    $env:CONTINUOUS_CLI_VERSION = "2.14.0"; irm https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.ps1 | iex
.NOTES
    Supports Windows 10/11, Windows Server 2016+
    Hosts contacted: api.github.com and github.com (the release), the npm registry
    for dependencies, and, only if Node.js 22 is missing, winget or the fnm release.
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [int]$Timeout = 60,
    [string]$Version = $env:CONTINUOUS_CLI_VERSION,
    [string]$Url = $env:CONTINUOUS_CLI_URL
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Faster downloads

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$script:RequiredNodeVersion = [version]"22.0.0"
$script:NodeInstallVersion = "22"
$script:Repo = "b1tninja/continuous"
$script:PackageName = "@b1tninja/continuous-cli"
$script:CliCommands = @("continuous", "cn")
$script:FnmInstalled = $false
$script:FnmPath = "$env:LOCALAPPDATA\fnm"

function Write-Info { param($Message) Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $Message }
function Write-Success { param($Message) Write-Host "==> " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Warn { param($Message) Write-Host "==> Warning: " -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Write-Err { param($Message) Write-Host "==> Error: " -ForegroundColor Red -NoNewline; Write-Host $Message }

function Test-InternetConnection {
    try {
        $request = [System.Net.WebRequest]::Create("https://api.github.com")
        $request.Timeout = 5000
        $request.Method = "HEAD"
        $request.UserAgent = "continuous-cli-installer"
        $response = $request.GetResponse()
        $response.Close()
        return $true
    } catch {
        return $false
    }
}

function Invoke-SafeWebRequest {
    param(
        [Parameter(Mandatory)]
        [string]$Uri,
        [string]$OutFile,
        [switch]$Quiet
    )

    $webClient = New-Object System.Net.WebClient
    $webClient.Headers.Add("User-Agent", "continuous-cli-installer")
    try {
        if ($OutFile) {
            $webClient.DownloadFile($Uri, $OutFile)
        } else {
            return $webClient.DownloadString($Uri)
        }
    } catch [System.Net.WebException] {
        if (-not $Quiet) { Write-Err "Failed to download from $Uri`: $($_.Exception.Message)" }
        throw
    } finally {
        $webClient.Dispose()
    }
}

function Remove-FnmInstallation {
    if ($script:FnmInstalled -and (Test-Path $script:FnmPath)) {
        Write-Warn "Cleaning up partial fnm installation..."
        Remove-Item -Path $script:FnmPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-NodeVersion {
    try {
        $nodeOutput = & node -v 2>$null
        if ($nodeOutput -match '^v?(\d+\.\d+\.\d+)') {
            return [version]$Matches[1]
        }
    } catch {}
    return $null
}

function Test-NodeInstalled {
    $currentVersion = Get-NodeVersion
    if ($null -eq $currentVersion) {
        Write-Warn "Node.js is not installed"
        return $false
    }

    Write-Info "Found Node.js v$currentVersion"
    if ($currentVersion -ge $RequiredNodeVersion) {
        Write-Success "Node.js meets requirements (>= v$RequiredNodeVersion)"
        return $true
    }

    Write-Warn "Node.js v$currentVersion is below required v$RequiredNodeVersion"
    return $false
}

function Install-Fnm {
    Write-Info "Installing fnm (Fast Node Manager)..."

    $fnmInstalled = $false

    # Method 1: Try winget (preferred - more reliable)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Using winget to install fnm..."
        try {
            $wingetResult = winget install Schniz.fnm --accept-package-agreements --accept-source-agreements -h 2>&1
            if ($LASTEXITCODE -eq 0 -or $wingetResult -match "already installed") {
                $fnmInstalled = $true
            } else {
                Write-Warn "winget installation returned non-zero exit code, trying alternative method..."
            }
        } catch {
            Write-Warn "winget failed: $($_.Exception.Message). Trying alternative method..."
        }
    }

    # Method 2: Direct binary download (safer than executing remote script)
    if (-not $fnmInstalled) {
        Write-Info "Downloading fnm binary directly..."
        try {
            $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
            $fnmZipUrl = "https://github.com/Schniz/fnm/releases/latest/download/fnm-windows.zip"
            $tempZip = Join-Path $env:TEMP "fnm-windows.zip"
            $extractPath = $script:FnmPath

            # Download the zip file
            Invoke-SafeWebRequest -Uri $fnmZipUrl -OutFile $tempZip

            # Create fnm directory if it doesn't exist
            if (-not (Test-Path $extractPath)) {
                New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
            }

            # Extract the zip
            Expand-Archive -Path $tempZip -DestinationPath $extractPath -Force

            # Clean up temp file
            Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue

            if (Test-Path "$extractPath\fnm.exe") {
                $fnmInstalled = $true
                $script:FnmInstalled = $true
            }
        } catch {
            Write-Warn "Direct download failed: $($_.Exception.Message)"
        }
    }

    if (-not $fnmInstalled) {
        Write-Err "Failed to install fnm using all available methods."
        Write-Err "Please install Node.js manually from https://nodejs.org or install fnm from https://github.com/Schniz/fnm"
        exit 1
    }

    # Add fnm to current session PATH and persist it
    $fnmPaths = @(
        $script:FnmPath,
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Schniz.fnm_*",
        "$env:USERPROFILE\.fnm",
        "$env:APPDATA\fnm"
    )

    foreach ($pathPattern in $fnmPaths) {
        $resolvedPaths = Resolve-Path -Path $pathPattern -ErrorAction SilentlyContinue
        foreach ($resolvedPath in $resolvedPaths) {
            if (Test-Path "$resolvedPath\fnm.exe") {
                $env:PATH = "$resolvedPath;$env:PATH"
                Write-Info "Found fnm at: $resolvedPath"
                
                # Persist fnm to user PATH if not already there
                $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
                if ($userPath -notlike "*$resolvedPath*") {
                    Write-Info "Adding fnm to user PATH for future sessions..."
                    [Environment]::SetEnvironmentVariable('PATH', "$resolvedPath;$userPath", 'User')
                }
                return
            }
        }
    }
}

function Install-Node {
    Install-Fnm

    if (-not (Get-Command fnm -ErrorAction SilentlyContinue)) {
        Remove-FnmInstallation
        Write-Err "Failed to install fnm. Please install Node.js manually from https://nodejs.org"
        exit 1
    }

    Write-Info "Installing Node.js v$($script:NodeInstallVersion)..."

    try {
        # Initialize fnm for current session
        $fnmEnvOutput = fnm env --use-on-cd 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "fnm env failed: $fnmEnvOutput"
        }
        $fnmEnvOutput | Out-String | Invoke-Expression

        # Install Node.js
        $installOutput = fnm install $script:NodeInstallVersion 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "fnm install failed: $installOutput"
        }

        fnm use $script:NodeInstallVersion
        if ($LASTEXITCODE -ne 0) {
            throw "fnm use failed"
        }

        fnm default $script:NodeInstallVersion

        # Re-initialize to pick up the new node
        fnm env --use-on-cd | Out-String | Invoke-Expression

        # Verify node is now available
        $nodeVersion = Get-NodeVersion
        if ($null -eq $nodeVersion) {
            throw "Node.js installation completed but node command not found"
        }

        Write-Success "Node.js v$nodeVersion installed"

        # Add fnm setup to PowerShell profile
        Add-ToProfile
    } catch {
        Remove-FnmInstallation
        Write-Err "Failed to install Node.js: $($_.Exception.Message)"
        exit 1
    }
}

function Add-ToProfile {
    $profileDir = Split-Path $PROFILE -Parent
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }

    if (-not (Test-Path $PROFILE)) {
        New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    }

    $fnmInit = 'fnm env --use-on-cd | Out-String | Invoke-Expression'
    $profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue

    if ($profileContent -notmatch 'fnm env') {
        Write-Info "Adding fnm to PowerShell profile..."
        Add-Content -Path $PROFILE -Value "`n# fnm (Node version manager)`n$fnmInit"
    }
}

function Get-TarballUrl {
    if ($Url) {
        Write-Info "Using CONTINUOUS_CLI_URL: $Url"
        return $Url
    }

    if ($Version) {
        $v = $Version -replace '^v', '' -replace '-vscode$', ''
        if ($v -notmatch '^[0-9A-Za-z.+-]+$') {
            Write-Err "Version must look like 2.14.0, got: $Version"
            exit 1
        }
        Write-Info "Using CONTINUOUS_CLI_VERSION $v"
        return "https://github.com/$($script:Repo)/releases/download/v$v-vscode/continuous-cli-$v.tgz"
    }

    Write-Info "Looking up the latest release of $($script:Repo)..."
    try {
        $json = Invoke-SafeWebRequest -Uri "https://api.github.com/repos/$($script:Repo)/releases/latest" -Quiet
        $release = $json | ConvertFrom-Json
    } catch {
        Write-Err "Could not reach api.github.com to find the latest release. Check your network and try again, or skip the lookup: `$env:CONTINUOUS_CLI_VERSION = '<x.y.z>' or `$env:CONTINUOUS_CLI_URL = '<tarball url>'."
        exit 1
    }
    $asset = $release.assets | Where-Object { $_.name -like 'continuous-cli-*.tgz' } | Select-Object -First 1
    if (-not $asset) {
        Write-Err "The latest release has no continuous-cli-*.tgz asset. Pick a release that has one: set CONTINUOUS_CLI_VERSION. See https://github.com/$($script:Repo)/releases"
        exit 1
    }
    return $asset.browser_download_url
}

function Install-Cli {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Err "npm not found. Please restart PowerShell and try again."
        exit 1
    }

    $tarballUrl = Get-TarballUrl
    Write-Info "Release tarball: $tarballUrl"

    # Check npm global directory permissions
    $npmPrefix = npm config get prefix 2>$null
    if ($npmPrefix -and (Test-Path $npmPrefix)) {
        try {
            $testFile = Join-Path $npmPrefix "_continuous_test_write"
            [IO.File]::WriteAllText($testFile, "test")
            Remove-Item $testFile -Force
        } catch {
            Write-Warn "Cannot write to npm global directory. Configuring user-local prefix..."
            $userNpmDir = "$env:USERPROFILE\.npm-global"
            if (-not (Test-Path $userNpmDir)) {
                New-Item -ItemType Directory -Path $userNpmDir -Force | Out-Null
            }
            npm config set prefix $userNpmDir
            $env:PATH = "$userNpmDir;$env:PATH"

            # Persist npm global bin to user PATH
            $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
            if ($userPath -notlike "*$userNpmDir*") {
                Write-Info "Adding npm global directory to user PATH for future sessions..."
                [Environment]::SetEnvironmentVariable('PATH', "$userNpmDir;$userPath", 'User')
            }
        }
    }

    $workDir = Join-Path ([IO.Path]::GetTempPath()) ("continuous-cli-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    try {
        $fileName = ([Uri]$tarballUrl).Segments[-1]
        $tgz = Join-Path $workDir $fileName
        try {
            Invoke-SafeWebRequest -Uri $tarballUrl -OutFile $tgz
        } catch {
            Write-Err "Could not download $tarballUrl. Check the version and your network."
            exit 1
        }

        # The release publishes SHA256SUMS.txt next to the tarball. It comes from the same
        # place as the tarball, so it detects a corrupt download but is not a signature.
        $releaseDir = $tarballUrl.Substring(0, $tarballUrl.LastIndexOf('/'))
        $actual = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLowerInvariant()
        $expected = $null
        try {
            $sums = Invoke-SafeWebRequest -Uri "$releaseDir/SHA256SUMS.txt" -Quiet
            foreach ($line in ($sums -split "`n")) {
                $parts = $line.Trim() -split '\s+', 2
                if ($parts.Count -eq 2 -and ($parts[1].TrimStart('*') -eq $fileName)) { $expected = $parts[0].ToLowerInvariant(); break }
            }
        } catch {}
        if ($expected) {
            if ($actual -ne $expected) {
                Write-Err "Checksum mismatch for ${fileName}: expected $expected, got $actual. Not installing."
                exit 1
            }
            Write-Success "SHA-256 matches the release's SHA256SUMS.txt: $actual"
        } else {
            Write-Warn "No SHA256SUMS.txt entry found for this tarball; compare the checksum yourself"
            Write-Info "SHA-256 of ${fileName}: $actual"
            Write-Info "Release: $releaseDir"
        }

        Write-Info "Installing $PackageName (npm install -g)..."
        $npmOutput = npm install -g $tgz 2>&1
        $npmExitCode = $LASTEXITCODE
        if ($npmExitCode -ne 0) {
            Write-Host $npmOutput -ForegroundColor Red
            Write-Err "Failed to install $PackageName (exit code: $npmExitCode)"
            exit 1
        }
    } finally {
        Remove-Item -Path $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Verify the CLI was installed
    $npmBinPath = npm config get prefix 2>$null
    if ($npmBinPath) {
        $env:PATH = "$npmBinPath;$env:PATH"
    }

    $missing = @($CliCommands | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -gt 0) {
        Write-Warn "Not found in PATH after installation: $($missing -join ', ')"
        Write-Warn "You may need to restart PowerShell"
    } else {
        foreach ($c in $CliCommands) {
            Write-Info "$c --version: $(& $c --version 2>&1 | Select-Object -First 1)"
        }
    }

    Write-Success "$PackageName installed!"
}

function Show-Complete {
    Write-Host ""
    Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
    Write-Success "Continuous CLI installation complete!"
    Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host ""

    if (Get-Command continuous -ErrorAction SilentlyContinue) {
        Write-Success "Ready! Run: continuous --help   (or the short alias: cn --help)"
    } else {
        Write-Host "Restart PowerShell, then run: " -NoNewline
        Write-Host "continuous --help" -ForegroundColor White
    }
    Write-Host "Uninstall with: npm uninstall -g $PackageName"
    Write-Host ""
}

function Main {
    Write-Host ""
    Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host "           Continuous CLI Installer" -ForegroundColor White
    Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host ""

    # Detect architecture properly
    $arch = if ([Environment]::Is64BitOperatingSystem) {
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    } else {
        "x86"
    }
    Write-Info "Detected platform: Windows-$arch"

    # Check internet connectivity
    Write-Info "Checking internet connectivity..."
    if (-not (Test-InternetConnection)) {
        Write-Err "Cannot reach api.github.com. Please check your internet connection and try again."
        exit 1
    }

    # Check Windows version
    $osVersion = [Environment]::OSVersion.Version
    if ($osVersion.Major -lt 10) {
        Write-Warn "Windows version $osVersion may not be fully supported. Windows 10 or later is recommended."
    }

    if (-not (Test-NodeInstalled)) {
        Install-Node
    }

    Install-Cli
    Show-Complete
}

# Run main function
try {
    Main
} catch {
    Remove-FnmInstallation
    Write-Err "Installation failed: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
}
