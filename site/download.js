// The download buttons. Bops is a Mac app for Apple silicon: on a Mac they open a short card first
// (Get First Access: leave your email, or skip, and the download starts; /download/Bops.dmg is always the
// newest release), with what's new in that release at its foot. Anywhere else (an iPhone, an iPad,
// Android, Windows, Linux, ChromeOS) they open a short note instead: open bops.bot on your Mac. An Intel
// Mac, which only Chromium can tell apart, gets the note's Apple silicon version. Without JS the buttons
// simply download.
(() => {
  const links = document.querySelectorAll('a[href="/download/Bops.dmg"]');
  if (!links.length) return;
  const SITE = "https://bops.bot";
  const DMG = "/download/Bops.dmg";
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

  // PostHog (the snippet in index.html) may be blocked, half loaded or missing: every call goes through
  // here, so nothing it does or doesn't do can break a button or a card.
  function ph(method, ...args) {
    try {
      const p = window.posthog;
      if (p && typeof p[method] === "function") p[method](...args);
    } catch (_) {}
  }

  const NOTES = {
    other: ["Bops is a Mac app", "Open bops.bot on your MacBook to download it. It needs a Mac with Apple silicon (M1 or newer)."],
    intel: ["Bops needs Apple silicon", "This Mac has an Intel chip, and Bops runs on Macs with Apple silicon (M1 or newer). Open bops.bot on one of those to get it."],
  };
  const CLOSE =
    '<button class="mac-note-close" type="button" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg></button>';
  const DISC = '<span class="mac-note-disc"><svg width="60" height="60" aria-hidden="true"><use href="#boppy" /></svg></span>';
  const canShare = typeof navigator.share === "function";
  let note, title, body, share, copy, anyway, status, opener, copyTimer;
  let access, ask, form, email, error, done, doneTitle, from;

  // What's new in the newest release: its version and a few short lines from /download/latest.json, which
  // scripts/download-publish.sh writes with each release. Read once on a Mac as the page loads, and shown
  // as text at the foot of Get First Access. When it can't be read or has no lines, the card is as it was.
  let news;
  function whatsNew(latest) {
    const version = latest && typeof latest.version === "string" ? latest.version.trim() : "";
    const notes = latest && Array.isArray(latest.notes) ? latest.notes.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()).slice(0, 5) : [];
    return /^\d+\.\d+\.\d+$/.test(version) && notes.length ? { version, notes } : undefined;
  }
  function showNews() {
    if (!access || !news) return;
    const box = access.querySelector(".access-new");
    box.querySelector("h3").textContent = `What's new in ${news.version}`;
    box.querySelector("ul").replaceChildren(
      ...news.notes.map((n) => {
        const li = document.createElement("li");
        li.textContent = n;
        return li;
      }),
    );
    box.hidden = false;
  }
  if (mac && typeof fetch === "function") {
    fetch("/download/latest.json")
      .then((r) => (r.ok ? r.json() : undefined))
      .then((latest) => {
        news = whatsNew(latest);
        showNews();
      })
      .catch(() => {});
  }

  // Both cards are a <dialog> in the page's style: the close button, a click on the backdrop and Escape
  // (by itself) close them, and focus goes back to the button that opened them.
  function card(html, labelledBy, describedBy) {
    const d = document.createElement("dialog");
    d.className = "mac-note";
    d.tabIndex = -1;
    d.setAttribute("aria-labelledby", labelledBy);
    d.setAttribute("aria-describedby", describedBy);
    d.innerHTML = DISC + html + CLOSE;
    d.querySelector(".mac-note-close").addEventListener("click", () => d.close());
    d.addEventListener("click", (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
    d.addEventListener("close", () => {
      if (opener) opener.focus({ preventScroll: true });
    });
    document.body.append(d);
    return d;
  }

  function buildNote() {
    note = card(
      '<h2 id="mac-note-title"></h2>' +
        '<p id="mac-note-body"></p>' +
        '<div class="mac-note-actions">' +
        '<button class="pill" type="button" data-act="share"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2M4.9 4.4L8 1.3l3.1 3.1M5.2 6.5H4a1.5 1.5 0 00-1.5 1.5v5A1.5 1.5 0 004 14.5h8a1.5 1.5 0 001.5-1.5V8A1.5 1.5 0 0012 6.5h-1.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>Send to my Mac</button>' +
        '<button class="pill" type="button" data-act="copy">Copy link</button>' +
        "</div>" +
        `<a class="mac-note-anyway" href="${DMG}">Download anyway</a>` +
        '<p class="mac-note-status" role="status"></p>',
      "mac-note-title",
      "mac-note-body",
    );
    title = note.querySelector("h2");
    body = note.querySelector("#mac-note-body");
    share = note.querySelector('[data-act="share"]');
    copy = note.querySelector('[data-act="copy"]');
    anyway = note.querySelector(".mac-note-anyway");
    status = note.querySelector(".mac-note-status");

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
      note.append(area);
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
  function openNote(kind, a, keyboard) {
    if (!note) buildNote();
    if (note.open || (access && access.open)) return;
    opener = a;
    [title.textContent, body.textContent] = NOTES[kind];
    note.dataset.kind = kind;
    const sharing = kind === "other" && canShare;
    share.hidden = !sharing;
    copy.className = sharing ? "pill pill-line" : "pill";
    clearTimeout(copyTimer);
    copy.textContent = "Copy link";
    status.textContent = "";
    anyway.hidden = kind !== "intel";
    note.showModal();
    (keyboard ? (sharing ? share : copy) : note).focus();
    ph("capture", "bops_download_note", { kind, button: where(a) });
  }

  // On a Mac: Get First Access. The email is optional (Skip and download), and either way the download
  // starts right away and the card says so, with a link in case the browser held it back.
  function buildAccess() {
    access = card(
      '<div class="access-ask">' +
        '<h2 id="access-title">Get First Access</h2>' +
        '<span class="access-chip">Free for now (not forever)</span>' +
        '<p id="access-body">Leave your email and your download starts right away.</p>' +
        '<form class="access-form" novalidate>' +
        '<label class="access-label" for="access-email">Email</label>' +
        '<input class="access-input" id="access-email" name="email" type="email" autocomplete="email" inputmode="email" required placeholder="you@company.com" aria-describedby="access-error" />' +
        '<button class="pill" type="submit">Download</button>' +
        '<p class="access-error" id="access-error" aria-live="polite"></p>' +
        "</form>" +
        `<a class="mac-note-anyway access-skip" href="${DMG}">Skip and download</a>` +
        "</div>" +
        '<div class="access-done" hidden>' +
        '<h2 id="access-done-title" tabindex="-1">Your download has started</h2>' +
        `<a class="access-again" href="${DMG}">Didn't start? Download again</a>` +
        "</div>" +
        '<div class="access-new" hidden><h3 id="access-new-title"></h3><ul aria-labelledby="access-new-title"></ul></div>',
      "access-title",
      "access-body",
    );
    ask = access.querySelector(".access-ask");
    form = access.querySelector("form");
    email = access.querySelector("input");
    error = access.querySelector(".access-error");
    done = access.querySelector(".access-done");
    doneTitle = done.querySelector("h2");

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = email.value.trim();
      // type=email alone takes "a@b"; an address someone can actually be written to has a dot after the @.
      const problem = !value ? "Enter your email first." : !email.checkValidity() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? "That doesn't look like an email address." : "";
      if (problem) {
        error.textContent = problem;
        email.setAttribute("aria-invalid", "true");
        email.focus();
        return;
      }
      // On the visitor as they are, never a person keyed by their email (orgo-web's rule): the Bops
      // app identifies them by their Orgo user id once they sign in.
      ph("setPersonProperties", { email: value, source: "bops.bot" });
      ph("capture", "bops_download_email", { email: value, button: from });
      download();
    });
    // The message goes as soon as they fix it; it never shows up mid-typing.
    email.addEventListener("input", () => {
      if (!error.textContent) return;
      error.textContent = "";
      email.removeAttribute("aria-invalid");
    });
    access.querySelector(".access-skip").addEventListener("click", (e) => {
      e.preventDefault();
      ph("capture", "bops_download_skip_email", { button: from });
      download();
    });
    showNews();
  }

  // A download doesn't leave the page (the server sends it as an attachment), so the card stays up and
  // turns into the done state.
  function download() {
    location.href = DMG;
    ask.hidden = true;
    done.hidden = false;
    access.setAttribute("aria-labelledby", "access-done-title");
    access.removeAttribute("aria-describedby");
    doneTitle.focus();
  }

  function openAccess(a) {
    if (!access) buildAccess();
    if (access.open || (note && note.open)) return;
    opener = a;
    from = where(a);
    ask.hidden = false;
    done.hidden = true;
    access.setAttribute("aria-labelledby", "access-title");
    access.setAttribute("aria-describedby", "access-body");
    error.textContent = "";
    email.removeAttribute("aria-invalid");
    access.showModal();
    // A Mac has a keyboard: straight into the field, so they can type and press Return.
    email.focus();
    ph("capture", "bops_download_click", { button: from });
  }

  // Which of the three buttons it was: the nav's, the hero's or the one at the bottom of the page.
  function where(a) {
    return a.closest(".nav") ? "nav" : a.closest(".hero") ? "hero" : "footer";
  }

  function open(a, keyboard) {
    if (mac && !intel) openAccess(a);
    else openNote(mac ? "intel" : "other", a, keyboard);
  }
  for (const a of links) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      open(a, e.detail === 0);
    });
    // A middle click would open the file in a new tab: the card instead.
    a.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open(a, false);
    });
  }
})();
