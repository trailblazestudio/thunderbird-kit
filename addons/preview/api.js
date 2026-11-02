"use strict";

/* Preview for Thunderbird
 *
 * Runs in the main process and patches every open about:3pane:
 *  - adds a third line with the message preview to each card in the message list,
 *  - shows the newest message (participants + count) for collapsed threads,
 *  - opens the newest message when a thread is selected, with the other
 *    messages of the thread as compact bars above it. */

const { MsgHdrToMimeMessage } = ChromeUtils.importESModule("resource:///modules/gloda/MimeMessage.sys.mjs");
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

const XHTML = "http://www.w3.org/1999/xhtml";
const HOOK = "preview";
const SCAN_MS = 1000; // how often new about:3pane tabs are looked for
const ROW_HEIGHT = 85; // room for three lines (Thunderbird's own card is ~75px)
const PREVIEW_LENGTH = 200;
const MAX_PARALLEL = 2;
const MAX_CACHED = 5000;
const MAX_PENDING = 500;

const T = { you: "You", older: n => `${n} older messages` };

// Services.intl follows the regional settings Thunderbird itself uses.
const FMT = {
  time: new Services.intl.DateTimeFormat(undefined, { timeStyle: "short" }),
  weekday: new Services.intl.DateTimeFormat(undefined, { weekday: "short" }),
  dateTime: new Services.intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }),
  dayMonth: new Services.intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }),
  dayMonthYear: new Services.intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }),
};

// The card's third row gets a preview column between the replies button and the icons.
const LIST_CSS = `
  #threadTree .card-container .thread-card-dynamic-row {
    grid-template:
      "subject subject subject" max-content
      "button preview info" minmax(auto, 1fr)
      / auto 1fr auto !important;
  }
  #threadTree .card-container .tk-preview {
    grid-area: preview;
    min-width: 0;
    padding-inline-start: 3px;
    font-size: 13px;
    font-weight: 400;
    opacity: 0.62;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #threadTree .card-layout[data-properties~="dummy"] .tk-preview {
    display: none;
  }
`;

// ---------- Shared row hook ----------
// Preview and Tracking both render into message list rows. Instead of wrapping
// ThreadCard.prototype.fillRow on top of each other, they register on ONE shared
// wrapper. When an add-on stops, the wrapper is removed completely and the other
// add-on re-registers on its next scan (the wrapper may belong to the stopped add-on).

const ROW_HOOKS = Symbol.for("thunderbird-kit.rowHooks");

function addRowHook(Card, name, fn) {
  const proto = Card.prototype;
  if (!proto[ROW_HOOKS]) {
    const orig = proto.fillRow;
    const hooks = new Map();
    proto.fillRow = function (...args) {
      const result = orig.apply(this, args);
      for (const hook of hooks.values()) {
        try {
          hook(this);
        } catch (e) {
          console.error("[thunderbird-kit]", e);
        }
      }
      return result;
    };
    proto[ROW_HOOKS] = { orig, hooks };
  }
  proto[ROW_HOOKS].hooks.set(name, fn);
}

function hasRowHook(Card, name) {
  return !!Card.prototype[ROW_HOOKS]?.hooks.has(name);
}

function removeRowHooks(Card) {
  const shared = Card.prototype[ROW_HOOKS];
  if (shared) {
    Card.prototype.fillRow = shared.orig;
    delete Card.prototype[ROW_HOOKS];
  }
}

// ---------- Helpers ----------

function newTimer(fn, ms, type) {
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback({ notify: fn }, ms, type);
  return timer;
}

function el(doc, tag, cls, text) {
  const node = doc.createElementNS(XHTML, tag);
  if (cls) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function hdrKey(hdr) {
  return `${hdr.folder?.URI}#${hdr.messageKey}`;
}

function ownEmails() {
  const set = new Set();
  for (const identity of MailServices.accounts.allIdentities) {
    if (identity.email) {
      set.add(identity.email.toLowerCase());
    }
  }
  return set;
}

// First name ("David"), or "You" for the user's own addresses.
function shortName(hdr, own) {
  const who = MailServices.headerParser.parseDecodedHeader(hdr.mime2DecodedAuthor)[0] || {};
  if (who.email && own.has(who.email.toLowerCase())) {
    return T.you;
  }
  const base = who.name || (who.email || "").split("@")[0];
  return base.trim().split(/\s+/)[0] || "?";
}

// Like Thunderbird's list: time today, weekday + time this week, otherwise date + time.
function fmtListDate(sec) {
  const d = new Date(sec * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d >= today) {
    return FMT.time.format(d);
  }
  if (d >= today - 6 * 86400000) {
    return `${FMT.weekday.format(d)}, ${FMT.time.format(d)}`;
  }
  return FMT.dateTime.format(d);
}

// Thread bars: "1 Sep", with the year when it is not this year.
function fmtBarDate(sec) {
  const d = new Date(sec * 1000);
  return (d.getFullYear() === new Date().getFullYear() ? FMT.dayMonth : FMT.dayMonthYear).format(d);
}

// All messages of a thread, oldest first.
function threadKids(thread) {
  const kids = [];
  for (let i = 0; i < thread.numChildren; i++) {
    kids.push(thread.getChildHdrAt(i));
  }
  return kids.sort((a, b) => a.dateInSeconds - b.dateInSeconds);
}

function cleanBody(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[^\s{}]*\s*\{[^{}]*\}/g, " ") // CSS rules leaking out of HTML mails
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Drop the oldest entries of an insertion-ordered Map/Set once it grows too big.
function trim(collection) {
  if (collection.size > MAX_CACHED) {
    const drop = collection.size - MAX_CACHED / 2;
    let i = 0;
    for (const key of collection.keys()) {
      if (i++ >= drop) {
        break;
      }
      collection.delete(key);
    }
  }
}

function start() {
  const patched = new Map(); // about:3pane window -> undo function
  let own = ownEmails(); // refreshed on every scan

  // ---------- Preview text ----------
  // Text is read from the local (offline) copy only; nothing is downloaded.

  const cache = new Map(); // hdrKey -> preview text
  const attempted = new Set();
  const pendingOffline = new Map(); // hdrKey -> hdr of IMAP mails not downloaded yet
  const waiting = [];
  let running = 0;

  function previewOf(hdr) {
    return hdr.getStringProperty("preview") || cache.get(hdrKey(hdr)) || "";
  }

  function enqueue(hdr) {
    if (!hdr.folder) {
      return;
    }
    const id = hdrKey(hdr);
    if (hdr.folder.server?.type === "imap" && !(hdr.flags & Ci.nsMsgMessageFlags.Offline)) {
      pendingOffline.set(id, hdr); // retried by scan() once it is stored locally
      return;
    }
    pendingOffline.delete(id);
    if (attempted.has(id)) {
      return;
    }
    attempted.add(id);
    trim(attempted);
    waiting.push({ id, hdr });
    pump();
  }

  function pump() {
    while (running < MAX_PARALLEL && waiting.length) {
      const { id, hdr } = waiting.pop(); // newest request first: visible rows win
      running++;
      try {
        parse(hdr, id, false);
      } catch (e) {
        done(id, "");
      }
    }
  }

  function done(id, text) {
    if (text) {
      cache.set(id, text.slice(0, PREVIEW_LENGTH));
      trim(cache);
    }
    running--;
    refreshSoon();
    pump();
  }

  function parse(hdr, id, examineEncrypted) {
    MsgHdrToMimeMessage(
      hdr,
      null,
      (_, mime) => {
        try {
          const body = mime ? cleanBody(mime.coerceBodyToPlaintext(hdr.folder) || "") : "";
          if (body) {
            done(id, body);
          } else if (mime && !examineEncrypted) {
            parse(hdr, id, true); // look inside signed/encrypted parts
          } else {
            nativeFallback(hdr, id);
          }
        } catch (e) {
          done(id, "");
        }
      },
      false, // never download
      { saneBodySize: true, examineEncryptedParts: examineEncrypted }
    );
  }

  // Thunderbird's own preview extraction; works for some signed mails.
  function nativeFallback(hdr, id) {
    const finish = () => done(id, cleanBody(hdr.getStringProperty("preview") || ""));
    try {
      const isAsync = hdr.folder.fetchMsgPreviewText([hdr.messageKey], {
        OnStartRunningUrl() {},
        OnStopRunningUrl: finish,
      });
      if (!isAsync) {
        finish();
      }
    } catch (e) {
      done(id, "");
    }
  }

  // Fill in previews that arrived – only the empty spans, no full re-render.
  let refreshTimer = null;
  function refreshSoon() {
    refreshTimer ??= newTimer(
      () => {
        refreshTimer = null;
        for (const w of patched.keys()) {
          for (const span of w.document.querySelectorAll("#threadTree .tk-preview:empty")) {
            const text = cache.get(span.dataset.key);
            if (text) {
              span.textContent = text;
            }
          }
          updateBars(w);
        }
      },
      200,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
  }

  // ---------- Message list rows ----------

  function renderRow(row) {
    const dyn = row.querySelector(".card-container .thread-card-dynamic-row");
    if (!dyn) {
      return;
    }
    let span = dyn.querySelector(".tk-preview");
    if (!span) {
      span = el(row.ownerDocument, "span", "tk-preview");
      dyn.appendChild(span);
    }

    // Paperclip right before the time.
    const dateEl = row.dateLine;
    const att = row.querySelector(".attachment-icon");
    if (att && dateEl && att.nextElementSibling !== dateEl) {
      dateEl.before(att);
    }

    const hdr = row.view && !row.dataset.properties?.split(" ").includes("dummy") ? row.view.getMsgHdrAt(row.index) : null;
    if (!hdr) {
      span.textContent = "";
      delete span.dataset.key;
      return;
    }

    // Collapsed thread: show the newest message, its participants and the count.
    let shown = hdr;
    if (row.classList.contains("children") && row.classList.contains("collapsed")) {
      const thread = row.view.getThreadContainingIndex(row.index);
      if (thread?.numChildren > 1) {
        const kids = threadKids(thread);
        shown = kids.at(-1);
        const names = [...new Set(kids.map(k => shortName(k, own)))]; // participants, first appearance
        const label = names.length <= 3 ? names.join(", ") : `${names[0]}, ${names[1]} +${names.length - 2}`;
        row.senderLine.textContent = `${label} (${kids.length})`;
        dateEl.textContent = fmtListDate(shown.dateInSeconds);
      }
    }

    span.dataset.key = hdrKey(shown);
    span.textContent = previewOf(shown);
    if (!span.textContent) {
      enqueue(shown);
    }
  }

  // ---------- Thread bars above the open message ----------

  const barState = new WeakMap(); // about:message window -> { key, expandedFor }

  function removeBars(mw) {
    mw.document.getElementById("tk-thread")?.remove();
    mw.document.getElementById("messagepanebox")?.classList.remove("tk-has-thread");
  }

  function makeBar(doc, mw, hdr) {
    const text = previewOf(hdr);
    if (!text) {
      enqueue(hdr);
    }
    const bar = el(doc, "div", "tk-bar");
    bar.append(
      el(doc, "span", "tk-from", shortName(hdr, own)),
      el(doc, "span", "tk-snip", text),
      el(doc, "span", "tk-date", fmtBarDate(hdr.dateInSeconds))
    );
    bar.addEventListener("click", () => mw.displayMessage(hdr.folder.getUriForMsg(hdr), mw.gViewWrapper));
    return bar;
  }

  function updateBars(w) {
    const mw = w.messageBrowser?.contentWindow;
    if (!mw || !String(mw.location?.href).startsWith("about:message")) {
      return;
    }
    const doc = mw.document;
    const box = doc.getElementById("messagepanebox");
    const hdr = w.messageBrowser.hidden ? null : mw.gMessage;
    if (!box || !hdr) {
      removeBars(mw);
      return;
    }
    let st = barState.get(mw);
    if (!st) {
      st = { key: "", expandedFor: null };
      barState.set(mw, st);
    }
    const thread = hdr.folder.msgDatabase.getThreadContainingMsgHdr(hdr);
    if (!thread || thread.numChildren < 2) {
      st.key = "";
      removeBars(mw);
      return;
    }

    const others = threadKids(thread).filter(k => k.messageKey !== hdr.messageKey);
    const expanded = st.expandedFor === thread.threadKey;
    // Rebuild only when something visible changed (incl. this thread's previews arriving).
    const ready = others.filter(k => previewOf(k)).length;
    const key = `${hdrKey(hdr)}:${others.length}:${expanded}:${ready}`;
    let wrap = doc.getElementById("tk-thread");
    if (key === st.key && wrap) {
      return;
    }
    st.key = key;

    if (!wrap) {
      wrap = el(doc, "div");
      wrap.id = "tk-thread";
      box.insertBefore(wrap, doc.getElementById("singleMessage"));
    }
    if (!expanded && others.length > 3) {
      // Oldest, "N older messages", newest – like a folded conversation.
      const pill = el(doc, "span", "tk-pill", T.older(others.length - 2));
      pill.addEventListener("click", () => {
        st.expandedFor = thread.threadKey;
        st.key = "";
        updateBars(w);
      });
      const pillRow = el(doc, "div", "tk-pill-row");
      pillRow.append(pill);
      wrap.replaceChildren(makeBar(doc, mw, others[0]), pillRow, makeBar(doc, mw, others.at(-1)));
    } else {
      wrap.replaceChildren(...others.map(k => makeBar(doc, mw, k)));
    }
    box.classList.add("tk-has-thread");
    box.style.setProperty("--tk-bars-h", `${wrap.getBoundingClientRect().height}px`);
  }

  // ---------- Patching about:3pane ----------

  function patch(w) {
    const Card = w.customElements.get("thread-card");
    const tree = w.document.getElementById("threadTree");
    if (!Card || !tree) {
      return; // not loaded yet – the next scan retries
    }

    const style = el(w.document, "style", "", LIST_CSS);
    w.document.documentElement.append(style);

    const origHeight = Object.getOwnPropertyDescriptor(Card, "ROW_HEIGHT");
    Object.defineProperty(Card, "ROW_HEIGHT", {
      configurable: true,
      get: () => ROW_HEIGHT,
      set() {}, // Thunderbird recalculates on font/density changes – keep ours
    });
    addRowHook(Card, HOOK, renderRow);

    // Selecting a thread opens its newest message instead of the multi-message summary.
    const pane = w.document.getElementById("messagePane");
    const origDisplay = pane?.displayMessages;
    if (origDisplay) {
      pane.displayMessages = function (messages = []) {
        if (messages.length > 1 && w.gDBView?.selection?.count === 1) {
          const rootKey = m => w.gDBView.getThreadContainingMsgHdr(m).getRootHdr().messageKey;
          const root = rootKey(messages[0]);
          if (messages.every(m => rootKey(m) === root)) {
            const newest = messages.reduce((a, b) => (b.dateInSeconds > a.dateInSeconds ? b : a));
            return this.displayMessage(newest.folder.getUriForMsg(newest));
          }
        }
        return origDisplay.call(this, messages);
      };
    }

    // Thread bars follow the open message.
    const onLoaded = () => {
      try {
        updateBars(w);
      } catch (e) {
        console.error("[Preview for Thunderbird]", e);
      }
    };
    w.addEventListener("MsgLoaded", onLoaded); // bubbles up from about:message

    patched.set(w, () => {
      w.removeEventListener("MsgLoaded", onLoaded);
      if (origDisplay) {
        delete pane.displayMessages;
      }
      try {
        removeBars(w.messageBrowser.contentWindow);
      } catch (e) {
        // message browser already gone
      }
      removeRowHooks(Card);
      if (origHeight) {
        Object.defineProperty(Card, "ROW_HEIGHT", origHeight);
      }
      style.remove();
      w.document.querySelectorAll(".tk-preview").forEach(node => node.remove());
      tree.reset();
    });

    tree.reset(); // redraw existing rows with the new height and preview
    onLoaded(); // a message may already be open
  }

  function scan() {
    own = ownEmails();
    for (const hdr of pendingOffline.values()) {
      if (hdr.flags & Ci.nsMsgMessageFlags.Offline) {
        enqueue(hdr);
      }
    }
    if (pendingOffline.size > MAX_PENDING) {
      pendingOffline.clear();
    }
    for (const w of patched.keys()) {
      if (w.closed) {
        patched.delete(w);
      }
    }
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      for (const info of win.document.getElementById("tabmail")?.tabInfo ?? []) {
        const w = info.chromeBrowser?.contentWindow;
        if (!w?.location.href.startsWith("about:3pane")) {
          continue;
        }
        try {
          if (!patched.has(w)) {
            patch(w);
          } else {
            // Tracking may have stopped and taken the shared row hook with it.
            const Card = w.customElements.get("thread-card");
            if (!hasRowHook(Card, HOOK)) {
              addRowHook(Card, HOOK, renderRow);
            }
          }
        } catch (e) {
          console.error("[Preview for Thunderbird]", e);
        }
      }
    }
  }

  const scanTimer = newTimer(scan, SCAN_MS, Ci.nsITimer.TYPE_REPEATING_SLACK);
  scan();

  return {
    stop() {
      scanTimer.cancel();
      refreshTimer?.cancel();
      for (const undo of patched.values()) {
        try {
          undo();
        } catch (e) {
          // window already closed
        }
      }
      patched.clear();
    },
  };
}

this.tkPreview = class extends ExtensionAPI {
  onStartup() {
    this.state = start();
  }

  onShutdown(isAppShutdown) {
    if (!isAppShutdown) {
      this.state?.stop();
    }
  }

  getAPI() {
    return { tkPreview: {} };
  }
};
