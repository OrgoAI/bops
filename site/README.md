# Bops landing page

The marketing page for Bops: plain HTML and CSS (no build step), from the Paper design "E — Converged (full page)" on the Landing page of the Bops Paper file.

```bash
python3 -m http.server 4321 --directory site   # then open http://localhost:4321
```

- `index.html`: the page. Mascots and icons are SVG symbols defined once at the top.
- `styles.css`: everything visual. Colors are the app's: ink `#0A0A0A`, highlighter `#E9FF3B`, paper white.
- `main.js`: the illustrated scenes (hero cards, badge, thread) keep their designed size and scale down to fit smaller screens. Below 1180 px the fit is content-aware (it crops a scene's empty margins, so the scene draws larger), and on phones `styles.css` recomposes the hero and the thread into a narrower layout of the same parts. From 1180 px up the page renders exactly as before.
- `lanyard.js`: the badge in "Hire a bot" drops onto its lanyard (with a little wind) the first time it scrolls into view, then swings when you hover, drag or tap it (a few springs and a CSS 3D transform). At rest, with reduced motion or without JavaScript it is exactly the static design.
- `notes.js`: music notes drift out of the hero Boppy's headphones; clicking or tapping it makes a burst of them. Off with reduced motion.
- `download.js`: the three Download for Mac buttons go to `/download/Bops.dmg`. On a Mac they download it; anywhere else (iPhone, iPad, Android, Windows, Linux) they open a short note to get Bops on a Mac instead, with Send to my Mac (the share sheet, so AirDrop or Messages) and Copy link. An Intel Mac in Chrome gets the note's Apple silicon version.
- `styles.css` and the scripts are cached for a day on bops.bot and the HTML isn't: when one changes, bump its `?v=` in `index.html`.
- Fonts: Geist and Geist Mono from Google Fonts.

Before launch, fill in every link marked `data-todo` (the launch video, the GitHub repo once it's public). The numbers in the cards (Acme, $4,800, 214 emails) are illustrative.
