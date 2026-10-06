// The ID badge in "Hire a bot, not a chatbot." gets dropped onto its lanyard the first time the scene
// scrolls into view, then swings when you hover, drag or tap it. It is the same badge, straps and clip
// as the 2D design, moved by a few damped springs: the badge turns in 3D with a CSS transform
// (perspective only, its back never shows) and the straps are redrawn as two SVG paths. At rest all
// of that comes off and the original strap SVG is back, so the page at rest is exactly the 2D design.
// Test hooks: bopsLanyard.state() is "static" | "waiting" | "awake" | "asleep" (also data-lanyard on
// the stage) and bopsLanyard.drop() drops it again.
(() => {
  const stage = document.querySelector(".lanyard");
  const badge = stage && stage.querySelector(".badge");
  const straps = stage && stage.querySelector(".straps");
  if (!badge || !straps) return;
  const band = stage.closest(".band") || stage.parentElement, root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let state;
  const setState = (v) => (stage.dataset.lanyard = state = v);
  window.bopsLanyard = { state: () => state, drop: () => drop() };
  setState("static");
  if (!window.IntersectionObserver || !window.PointerEvent) return;

  // Stage px: the scene's designed 560 × 860 (scaled down on narrow screens).
  const ANCHOR = [[218, 0], [342, 0]]; // where the straps come in at the top edge
  const CLIP = [280, 205]; // the clip's centre at rest
  const ENDS = [[-8, -1], [8, -1]]; // where the straps meet the clip, from its centre
  const LEN = Math.hypot(54, 204); // a strap's length: taut at rest
  const REST = (-3 * Math.PI) / 180; // styles.css: .badge { transform: rotate(-3deg) }
  const VP = [280, 440], DEPTH = 1300; // vanishing point (the badge's middle) and perspective

  // A few damped springs, x'' = -k (x - goal) - c x', stepped at a fixed 480 Hz. Each is [k, c].
  const STEP = 1 / 480;
  const G = 6000; // gravity (px/s²); it only shows while the straps are slack
  const TAUT = [42000, 150]; // the straps going taut: stiff, and about a third of the speed bounces back
  const SAG = G / TAUT[0]; // so it hangs exactly at rest
  // The clip sideways (x); the swing about the clip in the badge's own plane (a: ~0.8 s a swing, a few
  // swings); its pitch (p, rotateX) and yaw (w, rotateY) about the clip.
  const SPRING = { x: [260, 11], a: [62, 5.4], p: [110, 6], w: [80, 5.4] };
  const HAND = [700, 46]; // held: the swing and the clip follow the pointer
  const EASED = [16 * 16, 2 * 16]; // critically damped: hover, and the last ease into the exact pose
  const KICK = 0.0006; // how much of the straps' jolt tips the bottom toward you
  const LIMIT = { a: 0.7, p: 0.44, w: 0.61 }; // 40°, 25°, 35°: never edge-on, never the back
  const FAR = 300; // px per radian near the badge's far edge (to tell when it's still)

  const KEYS = ["x", "y", "a", "p", "w"]; // clip x and y, swing (rotate), pitch (rotateX), yaw (rotateY)
  const s = {}, v = {}, prev = {}, goal = {}, F = {};
  const home = () => KEYS.forEach((k) => (s[k] = v[k] = prev[k] = goal[k] = 0));
  home();
  const ptr = { on: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 };
  const eyes = { x: 0, y: 0, blink: -1, next: 1, squint: 0, happy: 0, drawn: "" };
  let mode = "ease"; // "swing" after a drop, release or tap; "ease" once it's nearly still, and for hover
  let moving = false, falling = false, onscreen = false, raf = 0, last = 0, acc = 0, now = 0;
  let grab = null, press = null, org = null, blinkTimer = 0, queued = false;
  let L0 = [75, 212], q = [217.4, -6.7], H = 459, BW = 410, eyeAt = [146, 312]; // measured when it starts moving

  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
  const f2 = (n) => n.toFixed(2);
  const deg = (r) => ((r * 180) / Math.PI).toFixed(3);

  // The moving straps and clip: the same strokes as the static SVG, drawn in stage px (added when needed).
  const strap = '<path fill="none" stroke="#0A0A0A" stroke-width="10" stroke-linecap="round" />';
  const rig = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" class="lanyard-rig" width="560" height="860" viewBox="0 0 560 860" aria-hidden="true">${strap}${strap}<rect x="-18" y="-11" width="36" height="22" rx="5" fill="#C9C9C6" stroke="#0A0A0A" stroke-width="2.5" /></svg>`, "image/svg+xml").documentElement;
  const [lines, clip] = [[...rig.querySelectorAll("path")], rig.querySelector("rect")];
  // Wind: thin wavy ink lines trailing behind the badge when it moves fast (the drop, a hard fling).
  // Four points just off its sides each remember where they were over the last moment; a line is drawn
  // along that path, so a fall streaks straight up and a swing leaves curved trails.
  const wind = document.createElementNS("http://www.w3.org/2000/svg", "g");
  wind.innerHTML = '<path fill="none" stroke="#0A0A0A" stroke-width="2.5" stroke-linecap="round" />'.repeat(4);
  rig.appendChild(wind);
  const gusts = [...wind.children];
  const TRAIL = [[-30, 0.95, 1], [-54, 0.72, 0.7], [30, 0.88, 0.9], [54, 0.62, 0.65]]; // px off the edge, how far down, length
  const WINDOW = 0.13, CALM = 650, FULL = 1300; // s of path per line; px/s below which there's no wind, and over which it's full
  const trails = TRAIL.map(() => []);
  let gust = 0, windAt = 0, OFF = TRAIL.map(([off]) => off); // OFF: the offsets in use, pulled in on narrow screens
  const calm = () => trails.forEach((t) => (t.length = 0));
  // Boppy on the badge is its own copy of the symbol, so only these two eyes ever move.
  const eyeEls = [...badge.querySelectorAll(".photo .eye")];
  const drawEyes = (dx, cy, rx, ry) =>
    eyeEls.forEach((el, i) => {
      const at = { cx: dx === 0 ? [15.5, 24.5][i] : f2([15.5, 24.5][i] + dx), cy, rx, ry };
      for (const k in at) el.setAttribute(k, at[k]);
    });

  function measure() {
    const w = badge.offsetWidth, photo = badge.querySelector(".photo");
    H = badge.offsetHeight;
    BW = w;
    calm(); // a new measure can move the points: no wind from that
    L0 = [badge.offsetLeft, badge.offsetTop];
    // The clip in the badge's own px: from its middle, turned back by the 3° it hangs at.
    const dx = CLIP[0] - L0[0] - w / 2, dy = CLIP[1] - L0[1] - H / 2, c = Math.cos(REST), sn = Math.sin(REST);
    q = [w / 2 + c * dx + sn * dy, H / 2 - sn * dx + c * dy];
    if (photo) eyeAt = [L0[0] + photo.offsetLeft + photo.offsetWidth / 2, L0[1] + photo.offsetTop + photo.offsetHeight / 2];
    // On a narrow screen the card nearly fills it: bring the wind points in so both sides stay on screen
    // (the drop starts 12 px left of rest, hence the 12s).
    const r = stage.getBoundingClientRect(), k = r.width / 560 || 1, vw = root.clientWidth || innerWidth;
    const room = [L0[0] - 12 - (6 - r.left) / k, (vw - 6 - r.left) / k - (L0[0] + w) + 12];
    OFF = TRAIL.map(([off]) => off * clamp((room[off < 0 ? 0 : 1] - 4) / 54, 0.15, 1));
  }
  // Pointer to stage px. The stage is measured when a drag or hover starts, whatever scales it.
  function measureStage() {
    const r = stage.getBoundingClientRect();
    org = { x: r.left + scrollX, y: r.top + scrollY, s: r.width / 560 || 1 };
  }
  const toStage = (e) => {
    if (!org) measureStage(); // a resize mid-drag clears it
    return [(e.clientX + scrollX - org.x) / org.s, (e.clientY + scrollY - org.y) / org.s];
  };

  // The springs take the badge over (inline transform, drawn straps), or give it back as it was.
  function own(on) {
    moving = on;
    if (on) {
      if (rig.parentNode !== stage) straps.after(rig);
      measure();
      badge.style.transformOrigin = "0 0";
      render(1);
    } else {
      badge.style.removeProperty("transform");
      badge.style.removeProperty("transform-origin");
      drawEyes(0, "22.3", "1.9", "2.6");
      eyes.drawn = "";
    }
    stage.classList.toggle("is-moving", on);
    band.classList.toggle("lanyard-band", on);
  }

  function force(k, ease) {
    if (k === "y" && !grab) return G - (s.y > -SAG ? TAUT[0] * (s.y + SAG) + TAUT[1] * v.y : 0); // falls until the straps catch it
    const [kk, c] = grab ? (k === "x" ? SPRING.x : k === "p" || k === "w" ? EASED : HAND) : ease ? EASED : SPRING[k];
    return falling ? 0 : -kk * (s[k] - goal[k]) - c * v[k]; // falling, nothing pulls it back yet
  }
  function step(h) {
    const ease = mode === "ease" && !grab;
    for (const k of KEYS) F[k] = force(k, ease);
    F.a += F.x / 250; // the clip moving sideways swings the badge the other way
    if (!grab) F.p += KICK * Math.max(0, -F.y); // and the straps' jolt tips its bottom toward you
    for (const k of KEYS) {
      v[k] += F[k] * h;
      prev[k] = s[k];
      s[k] += v[k] * h;
      if (Math.abs(s[k]) > (LIMIT[k] || Infinity)) {
        s[k] = Math.sign(s[k]) * LIMIT[k];
        if (v[k] * s[k] > 0) v[k] = 0;
      }
    }
    if (falling && s.y > -SAG) {
      falling = false;
      eyes.blink = 0; // caught: a startled blink
    }
  }

  function render(f) {
    const at = (k) => prev[k] + (s[k] - prev[k]) * f;
    const a = at("a"), cx = CLIP[0] + at("x"), cy = CLIP[1] + at("y"), c = Math.cos(a), sn = Math.sin(a);
    // The badge hangs from the clip: it swings, tips and turns about it, then hangs at its 3°.
    badge.style.transform =
      `translate(${f2(VP[0] - L0[0])}px,${f2(VP[1] - L0[1])}px) perspective(${DEPTH}px) translate(${f2(cx - VP[0])}px,${f2(cy - VP[1])}px) ` +
      `rotate(${deg(a)}deg) rotateX(${deg(at("p"))}deg) rotateY(${deg(at("w"))}deg) rotate(-3deg) translate(${f2(-q[0])}px,${f2(-q[1])}px)`;
    // Each strap runs from its anchor to the clip: straight when taut, a gentle bow outward when slack.
    for (let i = 0; i < 2; i++) {
      const [ax, ay] = ANCHOR[i], side = i ? 2 : -2;
      const ex = cx + c * ENDS[i][0] - sn * ENDS[i][1], ey = cy + sn * ENDS[i][0] + c * ENDS[i][1];
      const dx = ex - ax, dy = ey - ay, len = Math.max(1, Math.hypot(dx, dy));
      const bow = LEN - len > 0.3 ? Math.min(24, 0.42 * Math.sqrt((3 * len * (LEN - len - 0.3)) / 8)) : 0;
      const kx = ax + dx / 2 + (side * bow * dy) / len, ky = ay + dy / 2 - (side * bow * dx) / len;
      // Heading up out of sight (early in the drop), its round end stays out of sight too.
      const up = (5 * Math.min(0, ky - ay)) / Math.max(1, Math.hypot(kx - ax, ky - ay));
      const to = bow ? `Q${f2(kx)} ${f2(ky)} ` : "L"; // taut: a line, stroked exactly like the static strap
      lines[i].setAttribute("d", `M${ax} ${f2(ay + up)}${to}${f2(ex)} ${f2(ey)}`);
    }
    clip.setAttribute("transform", `translate(${f2(cx)} ${f2(cy)}) rotate(${deg(a)})`);
    // Wind: each point's recent path, shown only while it moves fast, swaying a little, fading out after.
    const t = a + REST, tc = Math.cos(t), ts = Math.sin(t);
    let fast = 0;
    trails.forEach((tr, i) => {
      const [, down, len] = TRAIL[i], off = OFF[i], lx = off < 0 ? -BW / 2 + off : BW / 2 + off, ly = H * down;
      tr.push([cx + lx * tc - ly * ts, cy + lx * ts + ly * tc, now]);
      while (tr.length > 2 && now - tr[1][2] > WINDOW * len) tr.shift();
      // Where the point turned back (the catch, the end of a swing) the older path goes, so no hooks.
      const n = tr.length;
      if (n > 2) {
        const hx = tr[n - 1][0] - tr[n - 2][0], hy = tr[n - 1][1] - tr[n - 2][1];
        for (let k = n - 2; k > 0; k--) {
          if ((tr[k][0] - tr[k - 1][0]) * hx + (tr[k][1] - tr[k - 1][1]) * hy < 0) {
            tr.splice(0, k);
            break;
          }
        }
      }
      // Speed over the whole window, so one quick frame (a tap's kick) doesn't count as wind.
      const [x0, y0, t0] = tr[0], [x1, y1, t1] = tr[tr.length - 1];
      fast = Math.max(fast, Math.hypot(x1 - x0, y1 - y0) / Math.max(t1 - t0, WINDOW * len));
    });
    // It fades by time, the same at any frame rate.
    gust = Math.max(gust * Math.pow(0.9, (now - windAt) * 60), clamp((fast - CALM) / FULL, 0, 1));
    windAt = now;
    wind.setAttribute("opacity", gust > 0.02 ? f2(0.55 * gust) : "0");
    if (gust > 0.02) {
      gusts.forEach((g, i) => {
        const tr = trails[i], n = tr.length, len = TRAIL[i][2];
        const span = n < 2 ? 0 : Math.hypot(tr[n - 1][0] - tr[0][0], tr[n - 1][1] - tr[0][1]);
        if (span < 3) return g.setAttribute("d", "");
        g.setAttribute("stroke-opacity", f2(Math.min(1, span / 24))); // a short trail fades instead of shrinking to a dot
        // From the point back along its path; the sway grows with each sample's age (time, not frames).
        const pts = tr.map(([x, y, tk], k) => {
          const [nx, ny] = tr[Math.min(n - 1, k + 1)], [px, py] = tr[Math.max(0, k - 1)], age = now - tk;
          const dx = nx - px, dy = ny - py, d = Math.hypot(dx, dy) || 1;
          const w = 4 * gust * Math.sin(now * 9 + i * 1.7 - age * 78) * Math.min(1, age / (WINDOW * len));
          return [x - (dy / d) * w, y + (dx / d) * w];
        }).reverse();
        let d = `M${f2(pts[0][0])} ${f2(pts[0][1])}`;
        for (let k = 1; k < n - 1; k++) d += `Q${f2(pts[k][0])} ${f2(pts[k][1])} ${f2((pts[k][0] + pts[k + 1][0]) / 2)} ${f2((pts[k][1] + pts[k + 1][1]) / 2)}`;
        g.setAttribute("d", d + `L${f2(pts[n - 1][0])} ${f2(pts[n - 1][1])}`);
      });
    }
  }

  // Boppy's eyes look at the pointer (at most ~1.5 px) and up while falling; they blink now and then
  // and squint happily while held or tapped. Returns true while they're still changing.
  function updateEyes(dt) {
    let lx = 0, ly = falling ? -1 : 0;
    if (ptr.on && !falling) {
      const dx = ptr.x - eyeAt[0], dy = ptr.y - eyeAt[1], d = Math.hypot(dx, dy) || 1, k = (1.1 * Math.min(1, d / 160)) / d;
      lx = dx * k;
      ly = dy * k;
    }
    const k = 1 - Math.exp(-dt * 16), happy = grab || now < eyes.happy ? 1 : 0;
    eyes.x += (lx - eyes.x) * k;
    eyes.y += (ly - eyes.y) * k;
    eyes.squint += (happy - eyes.squint) * (1 - Math.exp(-dt * 14));
    if (eyes.blink >= 0 && (eyes.blink += dt) > 0.16) {
      eyes.blink = -1;
      eyes.next = now + 2 + Math.random() * 3;
    } else if (eyes.blink < 0 && now > eyes.next && !falling) eyes.blink = 0;
    const open = eyes.blink < 0 ? 1 : Math.max(0.12, Math.abs(1 - eyes.blink / 0.08)), sq = eyes.squint;
    const key = [eyes.x, 22.3 + eyes.y + 0.6 * sq, 1.9 * (1 + 0.12 * sq), 2.6 * open * (1 - 0.62 * sq)].map(f2);
    if (key.join() !== eyes.drawn) drawEyes(eyes.x, key[1], key[2], key[3]);
    eyes.drawn = key.join();
    return eyes.blink >= 0 || Math.abs(lx - eyes.x) + Math.abs(ly - eyes.y) > 0.02 || Math.abs(happy - sq) > 0.01;
  }

  // Held, it swings about the clip toward the pointer, tilts with the drag's speed, and the clip comes a
  // little way toward the hand (clamped). Hovering, it turns a little to face the pointer.
  const angle = (x, y) => Math.atan2(CLIP[0] + s.x - x, Math.max(y - CLIP[1] - s.y, 0) + 60);
  function aim(dt) {
    goal.x = goal.y = goal.a = goal.p = goal.w = 0;
    if (grab) {
      if (dt > 0) {
        const k = 1 - Math.exp(-dt * 18); // the hand's speed, smoothed
        ptr.vx += ((ptr.x - ptr.px) / dt - ptr.vx) * k;
        ptr.vy += ((ptr.y - ptr.py) / dt - ptr.vy) * k;
      }
      ptr.px = ptr.x;
      ptr.py = ptr.y;
      goal.a = clamp(grab.a0 + angle(ptr.x, ptr.y) - grab.b0, -LIMIT.a, LIMIT.a);
      goal.x = clamp((ptr.x - grab.x0) * 0.06, -10, 10);
      goal.y = clamp((ptr.y - grab.y0) * 0.06, -18, 2);
      goal.w = clamp(ptr.vx * 0.0004, -0.5, 0.5);
      goal.p = clamp(0.06 - ptr.vy * 0.0003, -0.35, 0.35);
    } else if (ptr.on && !falling) {
      goal.w = clamp((ptr.x - 280) / 260, -1, 1) * 0.15;
      goal.p = clamp((ptr.y - 440) / 320, -1, 1) * -0.11;
    }
  }

  function frame(t) {
    raf = 0;
    if (!moving || !onscreen || document.hidden) return; // paused; wake() picks it up again
    const dt = last ? Math.min((t - last) / 1000, 0.1) : 0; // clamped after a stall
    last = t;
    now += dt;
    acc += dt;
    aim(dt);
    for (let n = 0; acc >= STEP && n < 60; n++, acc -= STEP) step(STEP);
    acc = Math.min(acc, STEP);
    const eyesBusy = updateEyes(dt);
    render(acc / STEP);
    let off = 0, speed = 0;
    for (const k of KEYS) {
      off += Math.abs(s[k] - goal[k]) * (k === "x" || k === "y" ? 1 : FAR);
      speed += Math.abs(v[k]) * (k === "x" || k === "y" ? 1 : FAR);
    }
    if (mode === "swing" && !grab && !falling && off < 6 && speed < 60) mode = "ease";
    if (falling || eyesBusy || gust > 0.02 || off > 0.04 || speed > 0.5 || (mode === "swing" && !grab) || (grab && Math.abs(ptr.vx) + Math.abs(ptr.vy) > 4)) {
      raf = requestAnimationFrame(frame);
    } else if (!grab && !ptr.on) {
      home(); // the exact 2D pose: the inline styles come off with nothing to see
      own(false);
      setState("asleep");
    } else if (!grab) {
      // Still, and being looked at: it blinks now and then.
      blinkTimer = setTimeout(() => {
        eyes.next = 0;
        wake();
      }, 2000 + Math.random() * 3000);
    }
  }
  function wake() {
    if (state === "static" || state === "waiting") return;
    if (!moving) own(true);
    if (state !== "awake") setState("awake");
    clearTimeout(blinkTimer);
    if (raf || !onscreen || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  // The drop: from just above the top edge (badge and shadow out of sight), a little turned and tipped,
  // straps slack. It falls, the straps catch it with a jolt, it bounces once or twice and swings.
  function drop() {
    if (state === "static") return;
    stage.classList.remove("is-waiting");
    root.classList.remove("lanyard-grabbing");
    grab = press = null;
    measure();
    home();
    Object.assign(s, { x: -12, y: -(CLIP[1] + H + 70), a: 0.12, p: -0.1, w: 0.45 });
    Object.assign(v, { p: 0.18, w: -0.35 });
    Object.assign(prev, s);
    acc = 0;
    mode = "swing";
    falling = true;
    eyes.blink = -1;
    if (!moving) own(true);
    setState("awake");
    wake();
  }
  // A tap: a playful little swing away from where it landed, a hop on the straps and a happy squint.
  function tap(p) {
    const side = clamp((p[0] - CLIP[0]) / 200, -1, 1), low = clamp((p[1] - CLIP[1]) / 470, 0, 1);
    v.a += side * 2.4;
    v.w += side * 4.5;
    v.p -= 1.2 + 1.8 * low;
    v.y -= 380;
    eyes.happy = now + 0.6;
    mode = "swing";
    wake();
  }

  function hold(e, p) {
    try {
      badge.setPointerCapture(e.pointerId);
    } catch (err) {} // the browser already took this pointer for a scroll
    grab = { id: e.pointerId, x0: p[0], y0: p[1], a0: s.a, b0: angle(p[0], p[1]), t0: performance.now(), moved: 0, mouse: e.pointerType === "mouse" };
    const [x, y] = toStage(e);
    Object.assign(ptr, { x, y, px: x, py: y, vx: 0, vy: 0, on: true });
    mode = "swing";
    root.classList.add("lanyard-grabbing");
    wake();
  }
  const live = () => state === "awake" || state === "asleep";
  badge.addEventListener("pointerdown", (e) => {
    if (!live() || falling || grab || press || e.button > 0) return;
    measureStage();
    if (e.pointerType !== "mouse") press = { id: e.pointerId, x: e.clientX, y: e.clientY, p: toStage(e) };
    else {
      e.preventDefault();
      hold(e, toStage(e));
    }
  });
  badge.addEventListener("pointermove", (e) => {
    // Touch and pen: sideways swings it, up and down still scrolls the page (touch-action: pan-y).
    if (press && e.pointerId === press.id) {
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) hold(e, press.p);
      if (grab || Math.abs(dy) > 10) press = null;
    }
    if (!grab || e.pointerId !== grab.id) return;
    [ptr.x, ptr.y] = toStage(e);
    grab.moved = Math.max(grab.moved, Math.hypot(ptr.x - grab.x0, ptr.y - grab.y0) * org.s);
    wake();
  });
  const letGo = (e) => {
    const g = grab, p = press;
    if (e.type === "lostpointercapture" && e.target !== badge) return; // a touch's implicit capture moving to the badge
    if (p && e.pointerId === p.id) {
      press = null;
      if (e.type === "pointerup") tap(p.p); // a tap
    } else if (g && e.pointerId === g.id) {
      grab = null;
      root.classList.remove("lanyard-grabbing");
      if (!g.mouse) ptr.on = false;
      mode = "swing"; // it springs back with a couple of swings
      if (e.type === "pointerup" && g.moved < 5 && performance.now() - g.t0 < 350) tap([g.x0, g.y0]); // a click
      wake();
    }
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) badge.addEventListener(type, letGo);
  for (const type of ["pointermove", "pointerleave"]) {
    stage.addEventListener(type, (e) => {
      if (e.pointerType !== "mouse" || grab || !live()) return;
      if (!org) measureStage();
      if ((ptr.on = type === "pointermove")) [ptr.x, ptr.y] = toStage(e);
      wake();
    });
  }
  addEventListener("resize", () => (org = null));
  document.addEventListener("visibilitychange", () => (state === "waiting" ? check(stage.getBoundingClientRect()) : moving && wake()));

  // The drop waits until the spot where the badge comes to rest is mostly on screen (or partly, for a
  // moment), and for the fonts, so the badge is measured at its final size.
  function check(r, late) {
    if (state !== "waiting" || queued || document.hidden) return;
    const k = r.height / 860 || 1, top = r.top + 190 * k, bottom = r.top + 700 * k;
    const seen = (Math.min(bottom, innerHeight) - Math.max(top, 0)) / (bottom - top);
    if (seen > 0.2 && !late) setTimeout(() => check(stage.getBoundingClientRect(), true), 400);
    if (seen < 0.45 && !(late && seen > 0.2)) return;
    queued = true;
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.race([fonts, new Promise((res) => setTimeout(res, 1500))]).then(() => state === "waiting" && drop());
  }
  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    onscreen = e.isIntersecting;
    if (state === "waiting") check(e.boundingClientRect);
    else if (onscreen && moving) wake();
  }, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) });
  io.observe(stage);

  // Reduced motion: nothing moves and nothing changes. Switched on later, it stops at rest; off, it's live.
  function follow(first) {
    grab = press = null;
    ptr.on = falling = false;
    root.classList.remove("lanyard-grabbing");
    if (moving) own(false);
    home();
    stage.classList.toggle("is-live", !reduce.matches);
    stage.classList.toggle("is-waiting", !reduce.matches && first === true);
    setState(reduce.matches ? "static" : first === true ? "waiting" : "asleep");
  }
  if (reduce.addEventListener) reduce.addEventListener("change", follow);
  follow(true);
})();
