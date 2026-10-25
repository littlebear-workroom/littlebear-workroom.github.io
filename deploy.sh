#!/bin/sh
# Publish the site. Stamps a new version so phones (and the home-screen app) update themselves on next open.
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s/<meta name=\"bear-version\" content=\"[0-9]+\">/<meta name=\"bear-version\" content=\"$V\">/; s/cloud\.js\?v=[0-9]+/cloud.js?v=$V/; s/legal\.js\?v=[0-9]+/legal.js?v=$V/; s/features\.js\?v=[0-9]+/features.js?v=$V/" index.html office-c09910eabc41.html
echo "$V" > version.txt
git add -A
git commit -q -m "${1:-Update site}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q
echo "published version $V"
