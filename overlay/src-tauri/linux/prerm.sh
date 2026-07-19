#!/bin/sh
# Drop the symlink postinst.sh created. dpkg does not track it, so nothing else
# will. Only on a real removal — on an upgrade the new package's postinst
# re-creates it, and removing it here would just churn.
set -e

case "$1" in
  remove|purge) rm -f /usr/bin/shelly ;;
esac
