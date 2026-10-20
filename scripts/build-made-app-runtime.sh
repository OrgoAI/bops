#!/bin/sh
# Rebuilds what apps bots make run on (public/made-apps, used by lib/made-app-page.ts): React and
# ReactDOM as one browser script that sets window.React, window.ReactDOM and the modules apps may
# import, and Tailwind's browser build as it ships. The versions are in the file names; change both
# here and in lib/server/made-apps.ts (viewPage) when updating. Usage: sh scripts/build-made-app-runtime.sh
set -e
REACT=19.2.8
TAILWIND=4.3.3
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/made-apps"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --silent "react@$REACT" "react-dom@$REACT" esbuild@0.25 "@tailwindcss/browser@$TAILWIND"
cat > entry.js <<'JS'
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JSXRuntime from "react/jsx-runtime";
window.React = React;
window.ReactDOM = { ...ReactDOM, ...ReactDOMClient };
window.__bopsModules = { react: React, "react-dom": window.ReactDOM, "react-dom/client": window.ReactDOM, "react/jsx-runtime": JSXRuntime };
JS
npx esbuild entry.js --bundle --minify --format=iife --define:process.env.NODE_ENV='"production"' --legal-comments=none --outfile="$OUT/react-$REACT.js"
cp node_modules/@tailwindcss/browser/dist/index.global.js "$OUT/tailwind-browser-$TAILWIND.js"
cp node_modules/react/LICENSE "$OUT/LICENSE-react"
cp node_modules/@tailwindcss/browser/LICENSE "$OUT/LICENSE-tailwindcss"
echo "Wrote $OUT"
