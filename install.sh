#!/bin/bash
#
# Companion bootstrap — one command, from a factory-fresh machine to a wired install.
# Supports macOS (Homebrew cask) and Ubuntu/Debian (.deb from GitHub Releases).
#
#   curl -fsSL https://raw.githubusercontent.com/mrgyatso/claude-code-companion/master/install.sh | bash
#
# Checks for Node 18+, Claude Code and the Companion app (plus Homebrew on
# macOS); offers to install whatever is missing; then hands off to `companion
# setup`, which wires the plugin.
#
# Safe to re-run, and re-running is how you upgrade: steps already done are
# skipped, but an app behind the latest release is offered an update (there is no
# auto-updater — this script is the only thing that moves an installed app
# forward), and `companion setup` refreshes the plugin.
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

# --- Agent CLIs (Claude Code / Codex) -------------------------------------------
# Companion needs AT LEAST ONE agent CLI and uses whichever you have — having one
# never triggers a pitch for the other. Only a machine with neither gets asked
# which to install (--yes takes the default, Claude Code). A Codex installed later
# unlocks by itself: the app wires it on its next launch, and `companion setup`
# picks it up too.
claude_path() { command -v claude 2>/dev/null || { [ -x "$HOME/.local/bin/claude" ] && printf '%s\n' "$HOME/.local/bin/claude"; }; }
codex_path()  { command -v codex  2>/dev/null || { [ -x "$HOME/.local/bin/codex" ] && printf '%s\n' "$HOME/.local/bin/codex"; }; }

install_claude() {
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  command -v claude >/dev/null 2>&1 || die "Claude Code installed but 'claude' is not on PATH."
  ok "Claude Code installed"
}

install_codex() {
  # Node 18+ is already ensured above. A system (apt) node has a root-owned global
  # prefix, so retry with sudo when the plain install can't write.
  npm install -g @openai/codex >/dev/null 2>&1 || sudo npm install -g @openai/codex \
    || die "could not install Codex — run it by hand: npm install -g @openai/codex"
  # npm's global bin dir may not be on PATH (a user-prefix node); make `codex`
  # reachable the same way Claude Code is, via ~/.local/bin.
  if ! command -v codex >/dev/null 2>&1; then
    npm_bin="$(npm prefix -g 2>/dev/null)/bin"
    [ -x "$npm_bin/codex" ] || die "Codex installed but its binary was not found under $npm_bin."
    mkdir -p "$HOME/.local/bin"
    ln -sf "$npm_bin/codex" "$HOME/.local/bin/codex"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v codex >/dev/null 2>&1 || die "Codex installed but 'codex' is not on PATH."
  ok "Codex installed  $(command -v codex)"
}

# Which CLI to install when the machine has neither. --yes (no terminal) takes
# Claude Code — the documented default.
choose_agent() {
  $ASSUME_YES && { printf 'claude'; return 0; }
  [ -r /dev/tty ] || die "no terminal to prompt on. Re-run with --yes to accept the default (Claude Code)."
  local reply
  printf '  %s?%s Which agent CLI should Companion set up? [1] Claude Code (default) · [2] Codex · [3] both: ' \
    "$bold" "$reset" > /dev/tty
  read -r reply < /dev/tty
  case "$reply" in
    2*) printf 'codex' ;;
    3*) printf 'both' ;;
    *) printf 'claude' ;;
  esac
}

if [ -n "$(claude_path)" ]; then
  # It may exist but not be on PATH in this shell — the installer only edits rc files.
  command -v claude >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$PATH"
  ok "Claude Code     $(command -v claude)"
fi
if [ -n "$(codex_path)" ]; then
  command -v codex >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$PATH"
  ok "Codex           $(command -v codex)"
fi
if [ -z "$(claude_path)" ] && [ -z "$(codex_path)" ]; then
  info "No agent CLI found — Companion needs Claude Code or Codex (or both)"
  if ! $CHECK_ONLY; then
    case "$(choose_agent)" in
      claude) install_claude ;;
      codex)  install_codex ;;
      both)   install_claude; install_codex ;;
    esac
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

# The version the latest release advertises, with the tag's leading v stripped so
# it can be compared against what dpkg reports.
latest_version() {
  curl -fsSL https://api.github.com/repos/mrgyatso/claude-code-companion/releases/latest \
    | grep -o '"tag_name": *"[^"]*"' | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/; s/^v//'
}

install_deb() {
  local deb_tmp
  deb_tmp=$(mktemp -t companion-overlay-XXXXXX.deb)
  curl -fsSL -o "$deb_tmp" "$1"
  # mktemp gives 0600, which the `_apt` user cannot read — apt then warns
  # ("Download is performed unsandboxed as root ... Permission denied") and
  # drops its sandbox to install anyway. Noisy on a first run, and a hard
  # failure where apt is configured not to fall back.
  chmod 644 "$deb_tmp"
  sudo apt-get install -y "$deb_tmp"
  rm -f "$deb_tmp"
}

# `companion` on PATH proves the app was installed once. It says nothing about
# WHICH version — and the app is fetched from a release asset, so a newer release
# never reaches an existing machine on its own. Without this check, anyone who ran
# the installer once stayed on that original build forever, however many times
# they re-ran it. (`companion setup` had the same bug with the plugin.)
refresh_app() {
  if [ "$OS" = Darwin ]; then
    $CHECK_ONLY && return 0
    # Homebrew knows what is current; `upgrade` is a no-op when the cask already is.
    if brew upgrade --cask mrgyatso/tap/claude-code-companion >/dev/null 2>&1; then
      ok "  the app is up to date"
    else
      info "  could not reach Homebrew to check for a newer app — carrying on"
    fi
    return 0
  fi

  local installed latest url
  installed=$(dpkg-query -W -f='${Version}' companion-overlay 2>/dev/null || true)
  if [ -z "$installed" ]; then
    # An AppImage or a source build is not dpkg-managed. There is no version to
    # read, and dropping a .deb on top would leave the machine with two apps.
    info "  not installed from a .deb — leaving it alone"
    return 0
  fi

  latest=$(latest_version || true)
  if [ -z "$latest" ]; then
    # Already wired and working; it just did not get to check for newer code.
    info "  could not reach GitHub to check for a newer app — carrying on"
    return 0
  fi

  if ! dpkg --compare-versions "$installed" lt "$latest"; then
    ok "  $installed is current"
    return 0
  fi

  info "  $installed is behind $latest"
  if $CHECK_ONLY; then
    APP_STALE="$installed to $latest"
    return 0
  fi

  url=$(latest_deb_url || true)
  if [ -z "$url" ]; then
    info "  the latest release carries no $(dpkg --print-architecture) .deb — keeping $installed"
    return 0
  fi
  ask "Upgrade the app from $installed to $latest? It will ask for your password." || return 0
  install_deb "$url"
  ok "Companion app upgraded to $latest"
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
  refresh_app
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
    install_deb "$deb_url"
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
  if [ -n "${APP_STALE:-}" ]; then
    say "The app can be upgraded ($APP_STALE)."
    say "Nothing was changed. Re-run without --check to upgrade it."
    exit 0
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
  say "  If you have not signed in to your agent CLI yet, do that now:"
  say ""
  say "      claude          ${dim}# finish the browser login, then quit with Ctrl-C${reset}"
  say "      codex login     ${dim}# if you use Codex${reset}"
  say ""
  say "  Then run this script again — it skips everything already done."
  exit 1
fi
