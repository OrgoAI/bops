// The illustrated scenes are laid out at their designed size (data-w × data-h) and scaled down to
// fit their column, so cards, badge and thread keep their exact composition.
// On the desktop layout the whole stage scales, as designed. Below 1180 px the fit is content-aware:
// it scales to the box around what the scene actually draws (each stage has empty margins), so the
// scene and the text in it come out as large as the column allows. Only empty space is cropped, and
// the scene stays centered. On phones styles.css also recomposes the hero and the thread.
const fits = [...document.querySelectorAll(".fit")];
const narrow = matchMedia("(max-width: 1179.98px)");
// A scene's parts are its stage's children as written in the page: whatever a script adds later
// (the lanyard's moving straps, say) never changes the fit.
const parts = fits.map((fit) => [...fit.querySelector(".stage").children]);

// The box around a scene's parts in stage px, from their layout boxes, so transforms (Boppy's bob,
// the badge's tilt, a swinging lanyard) don't move it.
function drawn(i) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of parts[i]) {
    const cs = getComputedStyle(el);
    const x = parseFloat(cs.left), y = parseFloat(cs.top), w = parseFloat(cs.width), h = parseFloat(cs.height);
    if (cs.display === "none" || !(w > 0 && h > 0) || Number.isNaN(x + y)) continue;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function layout() {
  fits.forEach((fit, i) => {
    const w = Number(fit.dataset.w);
    const h = Number(fit.dataset.h);
    const stage = fit.querySelector(".stage");
    const box = narrow.matches && drawn(i);
    if (box) {
      // The drawn box fills the column (never past its designed size), centered, top at the top.
      fit.style.maxWidth = "none";
      const room = fit.clientWidth;
      const scale = Math.min(1, room / box.w);
      stage.style.left = "0px";
      stage.style.transform = `translate(${(room - box.w * scale) / 2 - box.x * scale}px, ${-box.y * scale}px) scale(${scale})`;
      fit.style.height = `${box.h * scale}px`;
      return;
    }
    fit.style.maxWidth = `${w}px`;
    const scale = Math.min(1, fit.clientWidth / w);
    stage.style.transform = `scale(${scale})`;
    // Centered when there's room to spare.
    stage.style.left = `${Math.max(0, (fit.clientWidth - w * scale) / 2)}px`;
    fit.style.height = `${h * scale}px`;
  });
}

new ResizeObserver(layout).observe(document.body);
layout();
// Card heights settle once Geist is in.
if (document.fonts) document.fonts.ready.then(layout);
