// The download buttons. Bops is a Mac app for Apple silicon: on a Mac they download it
// (/download/Bops.dmg, always the newest release). Anywhere else (an iPhone, an iPad, Android,
// Windows, Linux, ChromeOS) they open a short note instead: open bops.bot on your Mac. An Intel Mac,
// which only Chromium can tell apart, gets the note's Apple silicon version. Without JS the buttons
// simply download.
(() => {
  const links = document.querySelectorAll('a[href="/download/Bops.dmg"]');
  if (!links.length) return;
  const SITE = "https://bops.bot";
  const ua = navigator.userAgent;
  const uaData = navigator.userAgentData;
  // iPadOS Safari says "Macintosh" too, but no Mac has a touch screen.
  const mac =
    (uaData && uaData.platform ? uaData.platform === "macOS" : /Macintosh/.test(ua)) &&
    !/iPhone|iPad|iPod/.test(ua) &&
    !(navigator.maxTouchPoints > 1);
  let intel = false;
  if (mac && uaData && uaData.getHighEntropyValues) {
    uaData.getHighEntropyValues(["architecture"]).then((v) => { intel = v.architecture === "x86"; }, () => {});
  }

  const NOTES = {
    other: ["Bops is a Mac app", "Open bops.bot on your MacBook to download it. It needs a Mac with Apple silicon (M1 or newer)."],
    intel: ["Bops needs Apple silicon", "This Mac has an Intel chip, and Bops runs on Macs with Apple silicon (M1 or newer). Open bops.bot on one of those to get it."],
  };
  const canShare = typeof navigator.share === "function";
  let dialog, title, body, share, copy, anyway, status, opener, copyTimer;

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "mac-note";
    dialog.tabIndex = -1;
    dialog.setAttribute("aria-labelledby", "mac-note-title");
    dialog.setAttribute("aria-describedby", "mac-note-body");
    dialog.innerHTML =
      '<span class="mac-note-disc"><svg width="60" height="60" aria-hidden="true"><use href="#boppy" /></svg></span>' +
      '<h2 id="mac-note-title"></h2>' +
      '<p id="mac-note-body"></p>' +
      '<div class="mac-note-actions">' +
      '<button class="pill" type="button" data-act="share"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2M4.9 4.4L8 1.3l3.1 3.1M5.2 6.5H4a1.5 1.5 0 00-1.5 1.5v5A1.5 1.5 0 004 14.5h8a1.5 1.5 0 001.5-1.5V8A1.5 1.5 0 0012 6.5h-1.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>Send to my Mac</button>' +
      '<button class="pill" type="button" data-act="copy">Copy link</button>' +
      "</div>" +
      '<a class="mac-note-anyway" href="/download/Bops.dmg">Download anyway</a>' +
      '<p class="mac-note-status" role="status"></p>' +
      '<button class="mac-note-close" type="button" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg></button>';
    title = dialog.querySelector("h2");
    body = dialog.querySelector("#mac-note-body");
    share = dialog.querySelector('[data-act="share"]');
    copy = dialog.querySelector('[data-act="copy"]');
    anyway = dialog.querySelector(".mac-note-anyway");
    status = dialog.querySelector(".mac-note-status");

    share.addEventListener("click", () => {
      // AirDrop, Messages, Mail: whatever gets the link to their Mac.
      navigator.share({ title: "Bops", url: SITE }).catch(() => {});
    });
    copy.addEventListener("click", async () => {
      const ok = await copyText(SITE);
      copy.innerHTML = ok ? '<svg width="18" height="18" aria-hidden="true"><use href="#check" /></svg>Copied' : "Couldn't copy";
      copy.classList.toggle("is-done", ok);
      status.textContent = ok ? "Link copied." : "";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copy.textContent = "Copy link";
        copy.classList.remove("is-done");
        status.textContent = "";
      }, 2000);
    });
    dialog.querySelector(".mac-note-close").addEventListener("click", () => dialog.close());
    // A tap outside the card (on the backdrop) closes it too; Escape does by itself.
    dialog.addEventListener("click", (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (opener) opener.focus({ preventScroll: true });
    });
    document.body.append(dialog);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // No clipboard API (an older browser, or not https): the old way, from inside the dialog.
      const area = document.createElement("textarea");
      area.className = "mac-note-copy";
      area.value = text;
      area.setAttribute("readonly", "");
      dialog.append(area);
      area.select();
      area.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      area.remove();
      copy.focus();
      return ok;
    }
  }

  // Opened from the keyboard, focus goes to the first button; from a tap or a click, to the card itself,
  // so no focus ring shows up on a phone.
  function open(kind, from, keyboard) {
    if (!dialog) build();
    if (dialog.open) return;
    opener = from;
    [title.textContent, body.textContent] = NOTES[kind];
    dialog.dataset.kind = kind;
    const sharing = kind === "other" && canShare;
    share.hidden = !sharing;
    copy.className = sharing ? "pill pill-line" : "pill";
    clearTimeout(copyTimer);
    copy.textContent = "Copy link";
    status.textContent = "";
    anyway.hidden = kind !== "intel";
    dialog.showModal();
    (keyboard ? (sharing ? share : copy) : dialog).focus();
  }

  const downloads = () => mac && !intel;
  for (const a of links) {
    a.addEventListener("click", (e) => {
      if (downloads()) return;
      e.preventDefault();
      open(mac ? "intel" : "other", a, e.detail === 0);
    });
    // A middle click would open the file in a new tab: the note instead.
    a.addEventListener("auxclick", (e) => {
      if (e.button !== 1 || downloads()) return;
      e.preventDefault();
      open(mac ? "intel" : "other", a, false);
    });
  }
})();
