#!/bin/sh
# Put the `shelly` CLI on PATH.
#
# Tauri only installs the app's own executable (/usr/bin/shelly).
# Everything in bundle.resources — including the `shelly` CLI that
# `shelly setup` and the plugin hooks are driven through — lands under
# /usr/lib/Shelly/scripts/ and is on nobody's PATH. Without this
# link, `apt install ./Shelly*.deb && shelly setup` fails at the second
# command with "shelly: command not found", which is the first thing anyone
# installing the .deb by hand will type.
set -e

ln -sf "/usr/lib/Shelly/scripts/shelly" /usr/bin/shelly
