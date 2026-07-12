#!/bin/sh
# Put the `companion` CLI on PATH.
#
# Tauri only installs the app's own executable (/usr/bin/companion-overlay).
# Everything in bundle.resources — including the `companion` CLI that
# `companion setup` and the plugin hooks are driven through — lands under
# /usr/lib/Companion Overlay/scripts/ and is on nobody's PATH. Without this
# link, `apt install ./Companion*.deb && companion setup` fails at the second
# command with "companion: command not found", which is the first thing anyone
# installing the .deb by hand will type.
set -e

ln -sf "/usr/lib/Companion Overlay/scripts/companion" /usr/bin/companion
