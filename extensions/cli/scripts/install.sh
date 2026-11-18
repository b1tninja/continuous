#!/usr/bin/env bash
set -euo pipefail

# Continuous CLI Installer - Unix (macOS, Linux, WSL, Git Bash)
#
# Installs the Continuous CLI (@b1tninja/continuous-cli) from the GitHub release
# tarball. It provides the commands `continuous` and `cn`. Re-running upgrades in place.
#
# Read it before you run it:
#   curl -fsSL https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.sh -o install.sh
#   less install.sh
#   bash install.sh
#
# Or in one step, once you have inspected it:
#   curl -fsSL https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.sh | bash
#
# Environment:
#   CONTINUOUS_CLI_VERSION  install this release, e.g. 2.14.0 (default: the latest release)
#   CONTINUOUS_CLI_URL      install this exact tarball URL (overrides the version and the lookup)
#
# The only hosts contacted are api.github.com and github.com (the release), the npm
# registry for dependencies, and, only if Node.js 22 is missing, fnm's installer.
# No telemetry.

REQUIRED_NODE_VERSION="22.0.0"
NODE_INSTALL_VERSION="22"
REPO="b1tninja/continuous"
PACKAGE_NAME="@b1tninja/continuous-cli"
CLI_COMMANDS=("continuous" "cn")
NETWORK_TIMEOUT=60
WORK_DIR=""
FNM_INSTALL_DIR="$HOME/.local/share/fnm"

# Cleanup tracking
CLEANUP_FNM=false

# Colors
if [ -t 1 ] && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
    BLUE='\033[0;34m' BOLD='\033[1m' NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
fi

info()    { printf "${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
success() { printf "${GREEN}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
warn()    { printf "${YELLOW}==> Warning:${NC} %s\n" "$1"; }
error()   { printf "${RED}==> Error:${NC} %s\n" "$1" >&2; exit 1; }

cleanup() {
    local exit_code=$?
    [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR" 2>/dev/null
    if [ $exit_code -ne 0 ]; then
        warn "Installation failed. Cleaning up..."
        if [ "$CLEANUP_FNM" = true ] && [ -d "$FNM_INSTALL_DIR" ]; then
            rm -rf "$FNM_INSTALL_DIR" 2>/dev/null || true
        fi
    fi
    exit $exit_code
}
trap cleanup EXIT

PLATFORM=""
ARCH=""
SHELL_PROFILE=""
SHELL_TYPE=""

check_dependencies() {
    local missing_deps=()

    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        missing_deps+=("curl or wget")
    fi

    if ! command -v tar &>/dev/null; then
        missing_deps+=("tar")
    fi

    if ! command -v unzip &>/dev/null; then
        missing_deps+=("unzip")
    fi

    if [ ${#missing_deps[@]} -gt 0 ]; then
        error "Missing required dependencies: ${missing_deps[*]}. Please install them first."
    fi
}

download() {
    local url="$1"
    local output="${2:-}"

    if command -v curl &>/dev/null; then
        if [ -n "$output" ]; then
            curl -fsSL --connect-timeout "$NETWORK_TIMEOUT" --max-time $((NETWORK_TIMEOUT * 3)) -o "$output" "$url"
        else
            curl -fsSL --connect-timeout "$NETWORK_TIMEOUT" --max-time $((NETWORK_TIMEOUT * 3)) "$url"
        fi
    elif command -v wget &>/dev/null; then
        if [ -n "$output" ]; then
            wget -q --timeout="$NETWORK_TIMEOUT" -O "$output" "$url"
        else
            wget -q --timeout="$NETWORK_TIMEOUT" -O - "$url"
        fi
    else
        error "Neither curl nor wget found. Please install one of them."
    fi
}

detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux*)                          PLATFORM="linux" ;;
        Darwin*)                         PLATFORM="darwin" ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT) PLATFORM="windows" ;;
        *)                               error "Unsupported OS: $os. Use install.ps1 for Windows." ;;
    esac

    case "$arch" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        armv7l)        ARCH="armv7l" ;;
        i386|i686)     error "32-bit systems are not supported" ;;
        *)             error "Unsupported architecture: $arch" ;;
    esac

    info "Detected platform: $PLATFORM-$ARCH"
}

detect_shell_profile() {
    local current_shell
    current_shell="$(basename "${SHELL:-/bin/bash}")"
    SHELL_TYPE="$current_shell"

    case "$current_shell" in
        zsh)  SHELL_PROFILE="$HOME/.zshrc" ;;
        bash)
            if [ "$PLATFORM" = "darwin" ]; then
                SHELL_PROFILE="$HOME/.bash_profile"
            else
                SHELL_PROFILE="$HOME/.bashrc"
            fi
            ;;
        fish)
            SHELL_PROFILE="$HOME/.config/fish/config.fish"
            mkdir -p "$HOME/.config/fish"
            ;;
        *)
            for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
                [ -f "$f" ] && SHELL_PROFILE="$f" && break
            done
            [ -z "$SHELL_PROFILE" ] && SHELL_PROFILE="$HOME/.bashrc"
            ;;
    esac
    touch "$SHELL_PROFILE"
    info "Using shell profile: $SHELL_PROFILE"
}

version_gte() {
    [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

source_nvm() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
}

source_fnm() {
    for fnm_path in "$HOME/.local/share/fnm" "$HOME/.fnm" "${FNM_DIR:-}"; do
        if [ -n "$fnm_path" ] && [ -d "$fnm_path" ]; then
            export PATH="$fnm_path:$PATH"
            break
        fi
    done
    command -v fnm &>/dev/null && eval "$(fnm env --shell bash 2>/dev/null || true)"
}

check_node() {
    source_nvm
    source_fnm

    if command -v node &>/dev/null; then
        local current_version
        current_version=$(node -v 2>/dev/null | sed 's/^v//')

        if [ -n "$current_version" ]; then
            info "Found Node.js v$current_version"
            if version_gte "$current_version" "$REQUIRED_NODE_VERSION"; then
                success "Node.js meets requirements (>= v$REQUIRED_NODE_VERSION)"
                return 0
            fi
            warn "Node.js v$current_version is below required v$REQUIRED_NODE_VERSION"
            return 1
        fi
    fi

    warn "Node.js is not installed"
    return 1
}

install_node() {
    # Only mark for cleanup if fnm directory doesn't already exist
    if [ ! -d "$FNM_INSTALL_DIR" ]; then
        CLEANUP_FNM=true
    fi
    info "Installing fnm (Fast Node Manager)..."

    mkdir -p "$FNM_INSTALL_DIR"

    if ! download "https://fnm.vercel.app/install" | bash -s -- --install-dir "$FNM_INSTALL_DIR" --skip-shell; then
        error "Failed to install fnm. Check your network connection and try again."
    fi

    if [ ! -x "$FNM_INSTALL_DIR/fnm" ]; then
        error "fnm installation failed - binary not found at $FNM_INSTALL_DIR/fnm"
    fi

    export PATH="$FNM_INSTALL_DIR:$PATH"

    # Initialize fnm for current session
    if ! eval "$(fnm env --shell bash 2>/dev/null)"; then
        error "Failed to initialize fnm environment"
    fi

    info "Installing Node.js v$NODE_INSTALL_VERSION..."
    if ! fnm install "$NODE_INSTALL_VERSION"; then
        error "Failed to install Node.js v$NODE_INSTALL_VERSION"
    fi

    fnm use "$NODE_INSTALL_VERSION"
    fnm default "$NODE_INSTALL_VERSION"

    # Verify node is working
    if ! command -v node &>/dev/null; then
        error "Node.js installation succeeded but 'node' command not found in PATH"
    fi

    # Add to shell profile with shell-specific syntax
    add_fnm_to_profile

    CLEANUP_FNM=false
    success "Node.js v$NODE_INSTALL_VERSION installed"
}

add_fnm_to_profile() {
    case "$SHELL_TYPE" in
        fish)
            add_to_profile "set -gx PATH \"$FNM_INSTALL_DIR\" \$PATH" "$FNM_INSTALL_DIR"
            add_to_profile 'fnm env --use-on-cd --shell fish | source' 'fnm env'
            ;;
        zsh|bash|*)
            add_to_profile "export PATH=\"$FNM_INSTALL_DIR:\$PATH\"" "$FNM_INSTALL_DIR"
            add_to_profile "eval \"\$(fnm env --use-on-cd --shell $SHELL_TYPE)\"" 'fnm env'
            ;;
    esac
}

add_to_profile() {
    local line="$1" check="$2"
    grep -q "$check" "$SHELL_PROFILE" 2>/dev/null || echo "$line" >> "$SHELL_PROFILE"
}

setup_npm_path() {
    local npm_prefix
    npm_prefix="$(npm config get prefix 2>/dev/null)"
    # Unix puts global bins in <prefix>/bin; Windows (Git Bash) puts them in <prefix>.
    # The `|| true` keeps `set -e` from exiting when a directory is absent.
    [ -d "$npm_prefix/bin" ] && export PATH="$npm_prefix/bin:$PATH" || true
    if [ "$PLATFORM" = "windows" ] && [ -d "$npm_prefix" ]; then
        export PATH="$(cd "$npm_prefix" && pwd):$PATH"
    fi
}

check_npm_permissions() {
    local npm_prefix
    npm_prefix="$(npm config get prefix 2>/dev/null)"

    # Check if we can write to npm global directory
    if [ -d "$npm_prefix/lib" ] && [ ! -w "$npm_prefix/lib" ]; then
        warn "Cannot write to npm global directory: $npm_prefix/lib"
        info "Attempting to fix npm permissions..."

        # Try to use npm prefix in user directory
        local user_npm_dir="$HOME/.npm-global"
        mkdir -p "$user_npm_dir"
        npm config set prefix "$user_npm_dir"
        export PATH="$user_npm_dir/bin:$PATH"

        add_to_profile "export PATH=\"$user_npm_dir/bin:\$PATH\"" ".npm-global/bin"
        info "Configured npm to use $user_npm_dir"
    fi
}

http_get() {
    # GitHub's API rejects requests without a User-Agent; no token is sent.
    if command -v curl &>/dev/null; then
        curl -fsSL --connect-timeout "$NETWORK_TIMEOUT" --max-time $((NETWORK_TIMEOUT * 3)) \
            -H "Accept: application/vnd.github+json" -A "continuous-cli-installer" "$1"
    else
        wget -q --timeout="$NETWORK_TIMEOUT" --user-agent="continuous-cli-installer" \
            --header="Accept: application/vnd.github+json" -O - "$1"
    fi
}

sha256_of() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v openssl &>/dev/null; then
        openssl dgst -sha256 "$1" | sed 's/^.*= //'
    else
        echo ""
    fi
}

# Sets TARBALL_URL and RELEASE_TAG_NOTE.
resolve_tarball() {
    TARBALL_URL=""
    if [ -n "${CONTINUOUS_CLI_URL:-}" ]; then
        TARBALL_URL="$CONTINUOUS_CLI_URL"
        info "Using CONTINUOUS_CLI_URL: $TARBALL_URL"
        return 0
    fi

    if [ -n "${CONTINUOUS_CLI_VERSION:-}" ]; then
        local v="${CONTINUOUS_CLI_VERSION#v}"
        v="${v%-vscode}"
        case "$v" in
            *[!0-9A-Za-z.+-]*|"") error "CONTINUOUS_CLI_VERSION must look like 2.14.0, got: $CONTINUOUS_CLI_VERSION" ;;
        esac
        TARBALL_URL="https://github.com/$REPO/releases/download/v$v-vscode/continuous-cli-$v.tgz"
        info "Using CONTINUOUS_CLI_VERSION $v"
        return 0
    fi

    info "Looking up the latest release of $REPO..."
    local json
    if ! json="$(http_get "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null)"; then
        error "Could not reach api.github.com to find the latest release. Check your network and try again, or skip the lookup: CONTINUOUS_CLI_VERSION=<x.y.z> or CONTINUOUS_CLI_URL=<tarball url>."
    fi
    TARBALL_URL="$(printf '%s' "$json" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*continuous-cli-[^"/]*\.tgz"' | head -n1 | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/')"
    if [ -z "$TARBALL_URL" ]; then
        error "The latest release has no continuous-cli-*.tgz asset. Pick a release that has one: CONTINUOUS_CLI_VERSION=<x.y.z>. See https://github.com/$REPO/releases"
    fi
}

install_cli() {
    resolve_tarball
    info "Release tarball: $TARBALL_URL"

    check_npm_permissions

    WORK_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t continuous-cli)"
    local tgz="$WORK_DIR/$(basename "$TARBALL_URL")"
    if ! download "$TARBALL_URL" "$tgz"; then
        error "Could not download $TARBALL_URL. Check the version and your network."
    fi

    # The release publishes SHA256SUMS.txt next to the tarball. It comes from the same
    # place as the tarball, so it detects a corrupt download but is not a signature.
    local actual expected sums
    actual="$(sha256_of "$tgz")"
    expected=""
    sums="$(download "${TARBALL_URL%/*}/SHA256SUMS.txt" 2>/dev/null || true)"
    if [ -n "$sums" ]; then
        expected="$(printf '%s\n' "$sums" | awk -v f="$(basename "$tgz")" '$2 == f || $2 == "*" f {print $1; exit}')"
    fi
    if [ -z "$actual" ]; then
        warn "No sha256 tool found (sha256sum, shasum, openssl); cannot compute the checksum"
    elif [ -n "$expected" ]; then
        if [ "$actual" != "$expected" ]; then
            error "Checksum mismatch for $(basename "$tgz"): expected $expected, got $actual. Not installing."
        fi
        success "SHA-256 matches the release's SHA256SUMS.txt: $actual"
    else
        warn "No SHA256SUMS.txt entry found for this tarball; compare the checksum yourself"
        info "SHA-256 of $(basename "$tgz"): $actual"
        info "Release: ${TARBALL_URL%/*}"
    fi

    info "Installing $PACKAGE_NAME (npm install -g)..."
    local npm_output npm_exit_code=0
    npm_output=$(npm install -g "$tgz" 2>&1) || npm_exit_code=$?
    if [ $npm_exit_code -ne 0 ]; then
        echo "$npm_output" >&2
        error "Failed to install $PACKAGE_NAME (exit code: $npm_exit_code)"
    fi

    # Verify installation
    setup_npm_path
    local missing=()
    for c in "${CLI_COMMANDS[@]}"; do
        command -v "$c" &>/dev/null || missing+=("$c")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        warn "Not found in PATH after installation: ${missing[*]}"
        warn "You may need to restart your shell or source your profile"
    else
        local c
        for c in "${CLI_COMMANDS[@]}"; do
            info "$c --version: $("$c" --version 2>&1 | head -n1)"
        done
    fi

    success "$PACKAGE_NAME installed!"
}

finalize() {
    echo ""
    echo "----------------------------------------------------------------------"
    success "Continuous CLI installation complete!"
    echo "----------------------------------------------------------------------"
    echo ""

    if command -v continuous &>/dev/null; then
        success "Ready! Run: continuous --help   (or the short alias: cn --help)"
    else
        printf "Run ${BOLD}source %s${NC} or open a new terminal\n" "$SHELL_PROFILE"
        printf "Then: ${BOLD}continuous --help${NC}\n"
    fi
    echo "Uninstall with: npm uninstall -g $PACKAGE_NAME"
    echo ""
}

main() {
    echo ""
    echo "----------------------------------------------------------------------"
    printf "${BOLD}           Continuous CLI Installer${NC}\n"
    echo "----------------------------------------------------------------------"
    echo ""

    check_dependencies
    detect_platform
    detect_shell_profile
    check_node || install_node
    setup_npm_path
    install_cli
    finalize
}

# Allow sourcing without running
if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]] || [ -z "${BASH_SOURCE[0]:-}" ]; then
    main "$@"
fi
