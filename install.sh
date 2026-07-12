#!/bin/bash
#
# Companion bootstrap — one command, from a factory-fresh machine to a wired install.
# Supports macOS (Homebrew cask) and Ubuntu/Debian (.deb from GitHub Releases).
#
#   curl -fsSL https://raw.githubusercontent.com/mrgyatso/claude-code-companion/master/install.sh | bash
#
# Checks for Node 18+, Claude Code and the Companion app (plus Homebrew on
# macOS); offers to install whatever is missing; then hands off to `companion
# setup`, which wires the plugin. Safe to re-run — every step it has already
# done is skipped.
#
# Flags:  -y, --yes    assume yes (required when there is no terminal to ask on)
#             --check  report what is missing and exit, changing nothing

set -euo pipefail

ASSUME_YES=false
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
    --check)  CHECK_ONLY=true ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'install.sh: unknown option %s\n' "$arg" >&2; exit 1 ;;
  esac
done

bold=""; dim=""; red=""; green=""; reset=""
if [ -t 1 ]; then
  bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; reset=$'\033[0m'
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
info() { printf '  %s·%s %s\n' "$dim" "$reset" "$*"; }
die()  { printf '\n%sinstall.sh: %s%s\n' "$red" "$*" "$reset" >&2; exit 1; }

# When run as `curl … | bash`, stdin is the script itself — a bare `read` would
# swallow the rest of it. Always ask on the controlling terminal instead.
ask() {
  $ASSUME_YES && return 0
  [ -r /dev/tty ] || die "no terminal to prompt on. Re-run with --yes to accept installs."
  local reply
  printf '  %s?%s %s [Y/n] ' "$bold" "$reset" "$1" > /dev/tty
  read -r reply < /dev/tty
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

OS=$(uname -s)
case "$OS" in
  Darwin) ;;
  Linux)
    command -v apt-get >/dev/null 2>&1 \
      || die "Linux support targets Ubuntu/Debian (.deb) — no apt-get found on this machine."
    ;;
  *) die "Companion supports macOS and Ubuntu/Debian Linux." ;;
esac

say ""
say "${bold}Companion${reset} — checking what this machine needs"
say ""

# --- Homebrew (macOS only) ------------------------------------------------------
# Each step must fix up PATH *in this running shell*, not merely append to a
# profile — otherwise the next step can't see what the previous one installed.
brew_shellenv() {
  local b
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$b" ] && { eval "$("$b" shellenv)"; return 0; }
  done
  return 1
}

if [ "$OS" = Darwin ]; then
  if command -v brew >/dev/null 2>&1 || brew_shellenv; then
    ok "Homebrew        $(command -v brew)"
  else
    info "Homebrew is missing (it also installs Apple's command line tools)"
    $CHECK_ONLY || ask "Install Homebrew? It will ask for your password." || die "Homebrew is required."
    if ! $CHECK_ONLY; then
      NONINTERACTIVE=1 /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      brew_shellenv || die "Homebrew installed but 'brew' is still not on PATH."
      # On Apple Silicon brew lives in /opt/homebrew, which no shell knows about yet.
      profile="$HOME/.zprofile"
      line="eval \"\$($(command -v brew) shellenv)\""
      grep -qsF "$line" "$profile" || printf '\n%s\n' "$line" >> "$profile"
      ok "Homebrew installed"
    fi
  fi
fi

# --- Node 18+ -----------------------------------------------------------------
# Claude Code ships as a native binary, so having `claude` does NOT imply node.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge 18 ] 2>/dev/null
}
if node_ok; then
  ok "Node            $(node -v)"
else
  if command -v node >/dev/null 2>&1; then
    info "Node $(node -v) is too old — the plugin's hooks need 18 or later"
  else
    info "Node is missing — the plugin's hooks are Node scripts"
  fi
  if [ "$OS" = Darwin ]; then
    $CHECK_ONLY || ask "Install Node via Homebrew?" || die "Node 18+ is required."
    $CHECK_ONLY || { brew install node; node_ok || die "Node installed but still not 18+."; ok "Node $(node -v)"; }
  else
    $CHECK_ONLY || ask "Install Node via apt? It will ask for your password." || die "Node 18+ is required."
    $CHECK_ONLY || {
      sudo apt-get update -qq && sudo apt-get install -y nodejs
      # The distro's own `nodejs` is 18+ on Ubuntu 24.04 and Debian 12, but Ubuntu
      # 22.04 — still the most common LTS — ships Node 12. Fall back to NodeSource's
      # current LTS rather than dying on a box where apt "succeeded".
      if ! node_ok; then
        info "apt gave us Node $(node -v 2>/dev/null || echo 'none') — too old; fetching a current LTS from NodeSource"
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
      node_ok || die "Node installed but still not 18+ — install one by hand (nvm, or deb.nodesource.com) and re-run."
      ok "Node $(node -v)"
    }
  fi
fi

# --- Claude Code --------------------------------------------------------------
claude_path() { command -v claude 2>/dev/null || { [ -x "$HOME/.local/bin/claude" ] && printf '%s\n' "$HOME/.local/bin/claude"; }; }
if [ -n "$(claude_path)" ]; then
  # It may exist but not be on PATH in this shell — the installer only edits rc files.
  command -v claude >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$PATH"
  ok "Claude Code     $(command -v claude)"
else
  info "Claude Code is missing"
  $CHECK_ONLY || ask "Install Claude Code?" || die "Claude Code is required."
  if ! $CHECK_ONLY; then
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    command -v claude >/dev/null 2>&1 || die "Claude Code installed but 'claude' is not on PATH."
    ok "Claude Code installed"
  fi
fi

# --- The app ------------------------------------------------------------------
# The Linux branch can only install if the latest release actually carries a .deb
# for this architecture — the Linux bundles are built by a separate CI job, so a
# release can exist with macOS assets only. Resolve the URL up front so `--check`
# can say so instead of promising a re-run that is guaranteed to fail.
latest_deb_url() {
  local arch
  arch=$(dpkg --print-architecture)
  curl -fsSL https://api.github.com/repos/mrgyatso/claude-code-companion/releases/latest \
    | grep -o "\"browser_download_url\": *\"[^\"]*_${arch}\.deb\"" \
    | head -1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

# Linux: the .deb ships the CLI scripts as bundle resources; link `companion`
# onto PATH from wherever the package put them (the exact libdir depends on the
# bundler version, so probe the known layouts).
link_linux_cli() {
  local s
  for s in "/usr/lib/companion-overlay/scripts/companion" \
           "/usr/lib/Companion Overlay/scripts/companion" \
           "/usr/lib/companion-overlay/resources/scripts/companion"; do
    if [ -x "$s" ]; then
      sudo ln -sf "$s" /usr/local/bin/companion
      return 0
    fi
  done
  return 1
}

if command -v companion >/dev/null 2>&1; then
  ok "Companion app   $(command -v companion)"
elif [ "$OS" = Darwin ]; then
  info "The Companion app is missing"
  $CHECK_ONLY || ask "Install it via Homebrew?" || die "The app is required."
  if ! $CHECK_ONLY; then
    # Homebrew 6 refuses to load a cask from a non-official tap until it is
    # trusted once. Older Homebrew has no `trust` subcommand and needs none.
    if brew trust --help >/dev/null 2>&1; then
      brew trust mrgyatso/tap
    fi
    brew install --cask mrgyatso/tap/claude-code-companion
    command -v companion >/dev/null 2>&1 || die "Cask installed but 'companion' is not on PATH."
    ok "Companion app installed"
  fi
else
  info "The Companion app is missing"
  deb_url=$(latest_deb_url || true)
  if [ -z "$deb_url" ]; then
    NO_LINUX_ASSET=true
    info "  ...and the latest release has no $(dpkg --print-architecture) .deb to install"
  fi
  $CHECK_ONLY || [ -n "$deb_url" ] \
    || die "no $(dpkg --print-architecture) .deb in the latest release — the Linux bundles have not shipped yet. Grab an AppImage or build from source: https://github.com/mrgyatso/claude-code-companion/releases/latest"
  $CHECK_ONLY || ask "Download the latest .deb from GitHub Releases and install it? It will ask for your password." \
    || die "The app is required."
  if ! $CHECK_ONLY; then
    deb_tmp=$(mktemp -t companion-overlay-XXXXXX.deb)
    curl -fsSL -o "$deb_tmp" "$deb_url"
    # mktemp gives 0600, which the `_apt` user cannot read — apt then warns
    # ("Download is performed unsandboxed as root ... Permission denied") and
    # drops its sandbox to install anyway. Noisy on a first run, and a hard
    # failure where apt is configured not to fall back.
    chmod 644 "$deb_tmp"
    sudo apt-get install -y "$deb_tmp"
    rm -f "$deb_tmp"
    command -v companion >/dev/null 2>&1 || link_linux_cli \
      || die "Package installed but the 'companion' CLI was not found in it."
    command -v companion >/dev/null 2>&1 || export PATH="/usr/local/bin:$PATH"
    ok "Companion app installed"
  fi
fi

if $CHECK_ONLY; then
  say ""
  if ${NO_LINUX_ASSET:-false}; then
    say "${red}Re-running without --check will not fix this.${reset} The latest release carries no"
    say "$(dpkg --print-architecture) .deb, so the installer has nothing to download. Use the AppImage"
    say "from the Releases page, or build from source:"
    say ""
    say "      https://github.com/mrgyatso/claude-code-companion/releases/latest"
    say ""
    exit 1
  fi
  say "Nothing was changed. Re-run without --check to install what's missing."
  exit 0
fi

# --- Wire it up ---------------------------------------------------------------
# `companion setup` adds the plugin marketplace, installs the plugin, creates the
# watched folder and runs `companion doctor`. It is the only thing that touches
# Claude Code's config, and it skips whatever it has already done.
say ""
say "${bold}Wiring the plugin${reset}"
say ""
if companion setup; then
  say ""
  say "${green}Done.${reset} Open the app whenever you like:"
  say ""
  say "      ${bold}companion board${reset}      ${dim}# or launch Companion Overlay from your apps${reset}"
  say ""
  say "  It also surfaces on its own: start a ${bold}claude${reset} session in any repo and the"
  say "  Board comes forward the moment the agent writes its first page."
else
  # The likeliest cause on a brand-new machine: Claude Code has never been
  # signed in, so its plugin commands have nothing to act on. Nothing here can
  # automate a browser login, so hand the user the one manual step and stop.
  say ""
  say "${bold}Almost there.${reset} ${dim}companion setup${reset} could not finish."
  say ""
  say "  If you have not signed in to Claude Code yet, do that now:"
  say ""
  say "      claude          ${dim}# finish the browser login, then quit with Ctrl-C${reset}"
  say ""
  say "  Then run this script again — it skips everything already done."
  exit 1
fi
