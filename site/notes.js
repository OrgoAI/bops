// The hero's Boppy is listening to music: small notes drift out of its headphones now and then, and
// clicking (or tapping) it makes a burst of them while it bops. It sings along (its mouth, shut as it
// listens, opens with the notes), its eyes follow the pointer and blink, and it squints happily in a
// burst. Notes live in the scene's stage, so they scale with it, and move with the Web Animations API
// (transform and opacity only). Nothing runs while the hero is off screen or the tab is hidden, and
// nothing at all with reduced motion.
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

  // Its mouth rests shut, a flat line (styles.css), and opens with a note: one "la" at a time, now and
  // then while it listens, quicker and wider in a burst.
  const mouth = boppy.querySelector(".hero-mouth"), SHUT = "scale(1.4, .28)";
  let singing = 0;
  function sing(strong) {
    const t = performance.now();
    if (!mouth || t < singing || (!strong && Math.random() < 0.3)) return;
    const dur = strong ? 300 : 620, open = (strong ? 0.95 : 0.75) + Math.random() * 0.3;
    singing = t + dur * 0.85;
    mouth.animate(
      [{ transform: SHUT }, { transform: `scale(1.05, ${open.toFixed(2)})`, offset: 0.3 }, { transform: `scale(1.1, ${(open * 0.8).toFixed(2)})`, offset: 0.7 }, { transform: SHUT }],
      { duration: dur, easing: "ease-in-out" },
    );
  }

  // Its eyes look toward the pointer (a little, easing there in styles.css), blink every few seconds
  // (twice, now and then), and squint happily through a burst.
  const eyes = boppy.querySelector(".hero-eyes"), lids = eyes ? [...eyes.querySelectorAll("ellipse")] : [];
  let happy = 0;
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
  const close = (to, ms) =>
    lids.forEach((l) => l.animate([{ transform: "scaleY(1)" }, { transform: `scaleY(${to})`, offset: 0.5 }, { transform: "scaleY(1)" }], { duration: ms, easing: "ease-in-out" }));
  function blink() {
    if (onscreen && !document.hidden && performance.now() > happy) {
      close(0.1, 170);
      if (Math.random() < 0.25) setTimeout(() => close(0.1, 170), 230);
    }
    setTimeout(blink, 2400 + Math.random() * 3200);
  }
  if (lids.length) setTimeout(blink, 1800);
  function squint() {
    happy = performance.now() + 900;
    lids.forEach((l) =>
      l.animate(
        [{ transform: "scaleY(1)" }, { transform: "translateY(.5px) scaleY(.4)", offset: 0.2 }, { transform: "translateY(.5px) scaleY(.4)", offset: 0.8 }, { transform: "scaleY(1)" }],
        { duration: 900, easing: "ease-in-out" },
      ),
    );
  }

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
    sing(strong);
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

  // Click or tap Boppy (or Enter / Space on it): a burst of notes, and it bops. Each burst has its own
  // number of notes (8 to 15) and pace (up to 10% faster or slower); the notes in it vary only a little.
  function burst() {
    const count = 8 + Math.floor(Math.random() * 8), pace = 0.9 + Math.random() * 0.2, first = Math.random() < 0.5 ? 0 : 1;
    for (let n = 0, at = 0; n < count; n++, at += (38 + Math.random() * 16) * pace) setTimeout(() => note((n + first) % 2, true, pace), at);
    boppy.animate([{ scale: "1" }, { scale: "1.08" }, { scale: "0.97" }, { scale: "1" }], { duration: 450, easing: "ease-out" });
    squint();
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
