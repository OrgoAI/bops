# Third-party notices

Bops includes code from other projects. That code stays under its own license, not Bops's (FSL-1.1-ALv2):

| Path | From | License |
|---|---|---|
| `components/message-ui/` | Adapted from [imessage-ui](https://github.com/theswerd/imessage-ui), Copyright (c) 2026 Ben Swerdlow and contributors | MIT, in [`components/message-ui/LICENSE`](components/message-ui/LICENSE) |
| `public/made-apps/react-19.2.8.js` | [React and ReactDOM](https://github.com/facebook/react) 19.2.8, bundled for apps bots make (`scripts/build-made-app-runtime.sh`), Copyright (c) Meta Platforms, Inc. and affiliates | MIT, in [`public/made-apps/LICENSE-react`](public/made-apps/LICENSE-react) |
| `public/made-apps/tailwind-browser-4.3.3.js` | [@tailwindcss/browser](https://github.com/tailwindlabs/tailwindcss) 4.3.3, as published, Copyright (c) Tailwind Labs, Inc. | MIT, in [`public/made-apps/LICENSE-tailwindcss`](public/made-apps/LICENSE-tailwindcss) |

The packages Bops depends on (npm packages, Electron) keep their own licenses, which come with each package in `node_modules/` after `npm install`.
