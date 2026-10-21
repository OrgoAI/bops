// The hero's Boppy is listening to music: small notes drift out of its headphones now and then, with a
// "la" now and again. Point at it and it smiles, blushing a little; click (or tap) it and it sings, a
// song of its own length each time, bopping along with notes flying, and ends with a big smile. Its eyes
// follow the pointer and blink. Notes live in the scene's stage, so they scale with it, and move with
// the Web Animations API (transform and opacity only). Nothing runs while the hero is off screen or the
// tab is hidden, and nothing at all with reduced motion.
(() => {
  const boppy = document.querySelector(".hero .boppy-float");
  const stage = boppy && boppy.closest(".stage");
  if (!stage || !boppy.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // ♪ and ♫, in the page's ink.
  const SHAPES = [
    '<ellipse cx="7" cy="17.5" rx="3.3" ry="2.5" transform="rotate(-20 7 17.5)"/><rect x="9.4" y="4" width="1.8" height="13.6" rx=".9"/><path d="M11.2 4c0 3.2 4.8 3.8 4.8 7.6-.9-1.7-2.7-2.4-4.8-2.7z"/>',
    '<ellipse cx="6" cy="18.3" rx="3" ry="2.3" transform="rotate(-20 6 18.3)"/><ellipse cx="17.6" cy="16.3" rx="3" ry="2.3" transform="rotate(-20 17.6 16.3)"/><rect x="8.1" y="6.2" width="1.7" height="12" rx=".85"/><rect x="19.7" y="4.2" width="1.7" height="12" rx=".85"/><path d="M8.1 6.2 21.4 3.6v2.9L8.1 9.1z"/>',
  ];
  const CUPS = [[0.23, 0.6], [0.78, 0.51]]; // the ear cups, as fractions of Boppy's box (its head tilts)
  let side = 0, live = 0, onscreen = false, timer = 0;

  // Where a cup is now, in stage px (Boppy bobs, and is smaller on phones).
  function cup(i) {
    const b = boppy.getBoundingClientRect(), r = stage.getBoundingClientRect(), k = r.width / stage.offsetWidth || 1;
    return [(b.left - r.left + b.width * CUPS[i][0]) / k, (b.top - r.top + b.height * CUPS[i][1]) / k, b.width / k];
  }

  // Its mouth: one shape, redrawn each frame while it moves, easing toward a pose. A pose is its width,
  // how far its corners lift, how far its top and bottom edges bow (down is +), and how far in from the
  // corners they bend (0 gives round ends, as an "o" has). Drawn with a round stroke of its own white,
  // so a mouth with no height is a flat line with round ends, as index.html draws it at rest.
  const mouth = boppy.querySelector(".hero-mouth"), cheeks = boppy.querySelector(".hero-cheeks");
  const MX = 20.78, MY = 26.9, f = (n) => n.toFixed(2);
  const SHUT = { w: 3, lift: 0, top: 0, bot: 0, inset: 0 };
  const SMILE = { w: 3.9, lift: 0.75, top: 0.75, bot: 1.25, inset: 0.22 };
  const SOFT = { w: 3.4, lift: 0.4, top: 0.4, bot: 0.62, inset: 0.2 }; // a small smile, mouth closed
  const GRIN = { w: 4, lift: 0.7, top: 0.55, bot: 1.9, inset: 0.18 }; // a big one, mouth open, at a song's end
  const mix = (a, b, k) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + (b[key] - a[key]) * k]));
  // A sung syllable: an "o" (wide and low to tall and round, by how open), or, happy, an open smile.
  const sung = (o, happy) =>
    mix({ w: 3 - 0.8 * o, lift: 0, top: -1.4 * o, bot: 1.4 * o, inset: 0 }, { w: 3.4, lift: 0.4, top: 0.3, bot: 0.6 + 1.6 * o, inset: 0.12 }, happy);
  function draw(p) {
    const x0 = MX - p.w / 2, x1 = MX + p.w / 2, y = MY - p.lift, i = p.inset * p.w, t = y + (p.top * 4) / 3, b = y + (p.bot * 4) / 3;
    mouth.setAttribute("d", `M${f(x0)} ${f(y)}C${f(x0 + i)} ${f(t)} ${f(x1 - i)} ${f(t)} ${f(x1)} ${f(y)}C${f(x1 - i)} ${f(b)} ${f(x0 + i)} ${f(b)} ${f(x0)} ${f(y)}Z`);
  }
  let pose = { ...SHUT }, want = SHUT, raf = 0, last = 0;
  function frame(now) {
    const k = 1 - Math.exp(-Math.min(0.05, (now - (last || now)) / 1000) * 26);
    let moving = false;
    for (const key in pose) {
      const d = want[key] - pose[key];
      pose[key] += d * k;
      if (Math.abs(d) > 0.004) moving = true;
    }
    draw(pose);
    last = moving ? now : 0;
    raf = moving ? requestAnimationFrame(frame) : 0;
  }
  const aim = (p) => {
    want = p;
    if (mouth && !raf) raf = requestAnimationFrame(frame);
  };
  // Its cheeks: pink or not (in between, pink on black looks muddy).
  const blush = (on) => cheeks && (cheeks.style.opacity = on ? "1" : "0");

  // What it's doing: just listening, smiling at the pointer over it, or singing or humming (song is the
  // one going, so a tap starts a new one and the old one's steps stop).
  let over = false, song = 0;
  const rest = () => (aim(over ? SMILE : SHUT), blush(over));
  boppy.addEventListener("pointerenter", () => ((over = true), !song && rest()));
  boppy.addEventListener("pointerleave", () => ((over = false), !song && rest()));

  // A phrase, sung or hummed: n syllables, each opening its mouth by between lo and hi (some of them an
  // open smile, by `happy`), now and then a held note that wavers (`held`), with a note off a cup and a
  // bop of the head on some (`notes`, `bops`), blushing if `flush`; then a big smile for `smile` ms.
  function phrase(n, { lo, hi, held = 0, happy = 0, notes = 0, bops = 0, flush = false, smile = 0 }) {
    const id = ++song, later = (ms, step) => setTimeout(() => id === song && step(), ms);
    if (flush) blush(flush);
    let at = 120;
    for (let s = 0; s < n; s++) {
      const long = Math.random() < held, dur = long ? 520 + Math.random() * 380 : 150 + Math.random() * 260;
      const o = long ? Math.max(hi - 0.2, lo) + Math.random() * 0.2 : lo + Math.random() * (hi - lo), smiling = Math.random() < happy ? 1 : 0;
      later(at, () => {
        aim(sung(o, smiling));
        if (Math.random() < notes) note((side ^= 1), true);
        if (Math.random() < bops) bop(0.03, (s % 2 ? 1 : -1) * 2);
      });
      for (let w = 1; long && w * 130 < dur * 0.62; w++) later(at + w * 130, () => aim(sung(o - (w % 2) * 0.12, smiling)));
      later(at + dur * 0.62, () => aim(Math.random() < 0.3 ? sung(lo * 0.4, 0) : SHUT));
      at += dur + (Math.random() < 0.2 ? 120 + Math.random() * 160 : 20 + Math.random() * 60);
    }
    if (smile) later(at, () => (aim(GRIN), bop(0.05, 0)));
    later(at + smile, () => ((song = 0), rest()));
  }
  const hum = () => phrase(2 + Math.floor(Math.random() * 4), { lo: 0.12, hi: 0.4 });

  // Its eyes look toward the pointer (a little, easing there in styles.css) and blink every few seconds
  // (twice, now and then): shut quickly, open a little slower. Getting into the music, it shuts them for
  // a moment, the white ovals giving way to two soft closed lids.
  const eyes = boppy.querySelector(".hero-eyes"), lids = eyes ? [...eyes.querySelectorAll("ellipse")] : [];
  const closed = boppy.querySelector(".hero-closed");
  let dreaming = 0;
  function dream(ms) {
    dreaming = performance.now() + ms;
    const a = 200 / ms, b = 1 - 280 / ms, o = { duration: ms, easing: "ease-in-out" };
    lids.forEach((l) =>
      l.animate([{ transform: "scaleY(1)", opacity: 1 }, { transform: "scaleY(.15)", opacity: 0, offset: a }, { transform: "scaleY(.15)", opacity: 0, offset: b }, { transform: "scaleY(1)", opacity: 1 }], o),
    );
    if (closed) closed.animate([{ opacity: 0 }, { opacity: 1, offset: a }, { opacity: 1, offset: b }, { opacity: 0 }], o);
  }

  // On its own now and then, as someone listening does: it shuts its eyes for a moment (with a small
  // smile and a little blush, or humming along), hums a few soft syllables, or sings a short phrase.
  function daydream() {
    setTimeout(daydream, 2600 + Math.random() * 3200);
    if (!onscreen || document.hidden || song || over) return;
    const r = Math.random();
    if (r < 0.35) {
      const ms = 1400 + Math.random() * 1600;
      dream(ms);
      if (Math.random() < 0.5) hum();
      else {
        aim(SOFT);
        blush(true);
        const id = ++song;
        setTimeout(() => id === song && ((song = 0), rest()), ms - 200);
      }
    } else if (r < 0.65) hum();
    else if (r < 0.82) phrase(3 + Math.floor(Math.random() * 5), { lo: 0.3, hi: 0.8, happy: 0.3, notes: 0.5, bops: 0.4, flush: true, smile: 800 + Math.random() * 400 });
  }
  setTimeout(daydream, 2200);
  addEventListener(
    "pointermove",
    (e) => {
      if (!eyes || !onscreen) return;
      const b = boppy.getBoundingClientRect(), dx = e.clientX - (b.left + b.width * 0.52), dy = e.clientY - (b.top + b.height * 0.45);
      const d = Math.hypot(dx, dy) || 1, k = (0.9 * Math.min(1, d / b.width)) / d;
      // Not as far right: the right eye, already glancing that way, would slip under its cup's outline.
      eyes.style.transform = `translate(${Math.min(0.5, dx * k).toFixed(2)}px, ${(dy * k).toFixed(2)}px)`;
    },
    { passive: true },
  );
  const shut = () =>
    lids.forEach((l) =>
      l.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(.1)", offset: 0.35 }, { transform: "scaleY(.1)", offset: 0.5 }, { transform: "scaleY(1)" }], {
        duration: 150 + Math.random() * 60,
        easing: "ease-out",
      }),
    );
  function blink() {
    if (onscreen && !document.hidden && performance.now() > dreaming) {
      shut();
      if (Math.random() < 0.2) setTimeout(shut, 260);
    }
    setTimeout(blink, 2600 + Math.random() * 3800);
  }
  if (lids.length) setTimeout(blink, 1800);

  function note(i, strong, pace = 1) {
    if (live > (strong ? 24 : 6)) return;
    const [x, y, size] = cup(i), dir = i ? 1 : -1, px = Math.round(size * (strong ? 0.1 : 0.08) * (0.8 + Math.random() * 0.5));
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("width", px);
    el.setAttribute("height", px);
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("class", "music-note");
    el.style.left = `${Math.round(x - px / 2)}px`;
    el.style.top = `${Math.round(y - px / 2)}px`;
    el.innerHTML = `<g fill="#0A0A0A">${SHAPES[Math.random() < 0.6 ? 0 : 1]}</g>`;
    boppy.after(el);
    live++;
    // Out and up with a gentle sway; a burst goes further and faster.
    const out = dir * size * (strong ? 0.28 + Math.random() * 0.3 : 0.18 + Math.random() * 0.14);
    const up = -size * (strong ? 0.55 + Math.random() * 0.4 : 0.5 + Math.random() * 0.2);
    const sway = size * 0.04 * (Math.random() < 0.5 ? -1 : 1), turn = dir * (8 + Math.random() * 18);
    const at = (f, s) => `translate(${(out * f + sway * Math.sin(f * 6)).toFixed(1)}px, ${(up * f).toFixed(1)}px) rotate(${(turn * f).toFixed(1)}deg) scale(${s})`;
    el.animate(
      [
        { transform: at(0, 0.5), opacity: 0 },
        { transform: at(0.2, 1), opacity: 1, offset: 0.2 },
        { transform: at(0.7, 1), opacity: 0.9, offset: 0.7 },
        { transform: at(1, 0.85), opacity: 0 },
      ],
      // A burst's notes all move at its pace, each within a few percent of it; ambient ones drift slower.
      { duration: strong ? 1800 * pace * (0.94 + Math.random() * 0.12) : 2600 + Math.random() * 900, easing: "cubic-bezier(.2,.6,.35,1)" },
    ).onfinish = () => {
      el.remove();
      live--;
    };
  }

  // Now and then, from alternating ears.
  function ambient() {
    timer = 0;
    if (!onscreen || document.hidden) return;
    note((side ^= 1), false);
    timer = setTimeout(ambient, 1100 + Math.random() * 700);
  }
  const resume = () => !timer && onscreen && !document.hidden && (timer = setTimeout(ambient, 600));
  new IntersectionObserver((e) => {
    onscreen = e[e.length - 1].isIntersecting;
    resume();
  }).observe(boppy);
  document.addEventListener("visibilitychange", resume);

  // A bop of the head on a beat, tipping one way or the other. None while one (or a tap's squash) is
  // still going: the new one would cut it off with a jump.
  let bopping = 0;
  function bop(by, tip) {
    const t = performance.now();
    if (t < bopping) return;
    bopping = t + 280;
    boppy.animate([{ scale: "1", rotate: "0deg" }, { scale: String(1 + by), rotate: `${tip}deg` }, { scale: "1", rotate: "0deg" }], { duration: 280, easing: "ease-out" });
  }

  // Click or tap Boppy (or Enter / Space on it): a burst of notes, and it sings, blushing. Each song is
  // its own: 4 to 9 syllables (about 1.5 to 4.5 s), each a quick "la" or now and then a held note
  // that wavers, more or less open, some of them an open smile, with a note and a bop on most. It
  // ends with a big smile for a moment before going back to listening.
  function burst() {
    const count = 5 + Math.floor(Math.random() * 5), pace = 0.9 + Math.random() * 0.2, first = Math.random() < 0.5 ? 0 : 1;
    for (let n = 0, at = 0; n < count; n++, at += (38 + Math.random() * 16) * pace) setTimeout(() => note((n + first) % 2, true, pace), at);
    boppy.animate([{ scale: "1" }, { scale: "1.08" }, { scale: "0.97" }, { scale: "1" }], { duration: 450, easing: "ease-out" });
    bopping = performance.now() + 450;
    phrase(4 + Math.floor(Math.random() * 6), { lo: 0.35, hi: 1, held: 0.15, happy: 0.35, notes: 0.75, bops: 0.6, flush: true, smile: 1400 + Math.random() * 900 });
  }
  boppy.classList.add("is-playing");
  boppy.setAttribute("tabindex", "0");
  boppy.setAttribute("role", "button");
  boppy.setAttribute("aria-label", "Boppy, listening to music. Press for more notes.");
  boppy.addEventListener("click", burst);
  boppy.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    burst();
  });
})();
