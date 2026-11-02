"use strict";

/* Tracking for Thunderbird – the Thunderbird side.
 *
 * Shows an eye next to tracked sent messages in the message list (purple once
 * opened) and "N opens" in the message header with a list of who/when.
 * The data comes from background.js via tkTracking.setTracking(). It also
 * blocks Thunderbird itself from ever loading the pixel, so viewing your own
 * mail never counts as an open. */

const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

const XHTML = "http://www.w3.org/1999/xhtml";
const SCAN_MS = 1000;
const PIXEL_ORIGIN = "__TRACKING_URL__"; // filled in by build.sh
const OPENED_COLOR = "#7c19cc";
const POPUP_WIDTH = 300;
const EYE = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M1.25%208S3.75%203.25%208%203.25%2014.75%208%2014.75%208%2012.25%2012.75%208%2012.75%201.25%208%201.25%208z%22/%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%222.1%22/%3E%3C/svg%3E";

const T = {
  opens: n => (n === 0 ? "No opens" : `${n} ${n === 1 ? "open" : "opens"}`),
  openedBy: "Opened by:",
  someRecipient: "One of the recipients",
};

// Message-ID -> { sentAt, opens: [{ ts, country, city, client, auto }] }
let trackMap = new Map();
let onTrackUpdate = () => {};

const LIST_CSS = `
  #threadTree .card-container .tk-track {
    display: inline-block;
    flex-shrink: 0;
    width: 15px;
    height: 15px;
    margin-inline-end: 6px;
    background-color: color-mix(in srgb, ${OPENED_COLOR} 25%, transparent);
    mask: url("${EYE}") center / 15px no-repeat;
  }
  #threadTree .card-container .tk-track.opened {
    background-color: ${OPENED_COLOR};
  }
  #threadTree .card-layout.selected.current .card-container .tk-track {
    background-color: rgba(255, 255, 255, 0.45);
  }
  #threadTree .card-layout.selected.current .card-container .tk-track.opened {
    background-color: #fff;
  }
`;

const HEADER_CSS = `
  #tk-track {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-inline-start: 10px;
    color: rgba(35, 31, 32, 0.5);
    font-size: 12.5px;
    white-space: nowrap;
  }
  #tk-track::before {
    content: "";
    width: 15px;
    height: 15px;
    background-color: rgba(35, 31, 32, 0.5);
    mask: url("${EYE}") center / 15px no-repeat;
  }
  #tk-track.opened { cursor: pointer; }
  #tk-track.opened::before { background-color: ${OPENED_COLOR}; }
  #tk-track-pop {
    position: fixed;
    z-index: 1000;
    box-sizing: border-box;
    width: ${POPUP_WIDTH}px;
    max-height: 300px;
    overflow: auto;
    padding: 8px 12px 10px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
    font-size: 12.5px;
    color: rgba(35, 31, 32, 0.75);
    cursor: default;
  }
  #tk-track-pop .tk-track-head { text-align: center; font-weight: 600; margin-bottom: 6px; }
  #tk-track-pop .tk-track-all { color: rgba(35, 31, 32, 0.5); font-size: 11.5px; text-align: center; margin: -2px 0 6px; }
  #tk-track-pop .tk-track-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    column-gap: 12px;
    align-items: baseline;
    padding: 5px 0;
    border-top: 1px solid rgba(0, 0, 0, 0.06);
  }
  #tk-track-pop .tk-track-who { color: #231f20; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #tk-track-pop .tk-track-when { color: rgba(35, 31, 32, 0.6); white-space: nowrap; }
  #tk-track-pop .tk-track-app { color: rgba(35, 31, 32, 0.5); font-size: 11.5px; white-space: nowrap; }
`;

// ---------- Helpers ----------

// "2 Nov, 10:36", with the year when it is not this year.
function fmtOpenDate(ms) {
  const d = new Date(ms);
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) {
    opts.year = "numeric";
  }
  const date = new Services.intl.DateTimeFormat(undefined, opts).format(d);
  return `${date}, ${new Services.intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(d)}`;
}

// Recipient addresses (To, Cc, Bcc) of a message.
function mailAddresses(hdr) {
  const out = [];
  for (const list of [hdr.recipients, hdr.ccList, hdr.bccList]) {
    for (const a of MailServices.headerParser.parseEncodedHeaderW(list || "")) {
      if (a.email && !out.includes(a.email)) {
        out.push(a.email);
      }
    }
  }
  return out;
}

// The message a list row stands for: the newest one for a collapsed thread.
function shownHdr(row) {
  if (!row.view || row.dataset.properties?.split(" ").includes("dummy")) {
    return null;
  }
  const hdr = row.view.getMsgHdrAt(row.index);
  if (!hdr || !row.classList.contains("children") || !row.classList.contains("collapsed")) {
    return hdr;
  }
  const thread = row.view.getThreadContainingIndex(row.index);
  let newest = hdr;
  for (let i = 0; i < (thread?.numChildren ?? 0); i++) {
    const k = thread.getChildHdrAt(i);
    if (k?.dateInSeconds > newest.dateInSeconds) {
      newest = k;
    }
  }
  return newest;
}

function realOpens(t) {
  return t.opens.filter(o => !o.auto);
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

function start() {
  const patched = new Map(); // about:3pane window -> undo function

  // ---------- Message list ----------

  function renderTrack(row) {
    const hdr = shownHdr(row);
    const t = hdr && trackMap.get(hdr.messageId);
    let icon = row.querySelector(".tk-track");
    if (!t) {
      icon?.remove();
      return;
    }
    icon ??= el(row.ownerDocument, "span", "tk-track");
    const dateEl = row.querySelector(".thread-card-row .date");
    if (dateEl && icon.nextElementSibling !== dateEl) {
      dateEl.before(icon);
    }
    const n = realOpens(t).length;
    icon.classList.toggle("opened", n > 0);
    icon.title = T.opens(n);
  }

  // ---------- Message header ----------

  function showPopup(doc, anchor, hdr, t) {
    const pop = el(doc, "div");
    pop.id = "tk-track-pop";
    pop.append(el(doc, "div", "tk-track-head", T.openedBy));
    // One pixel per message: only with a single recipient do we know who opened it.
    const recipients = mailAddresses(hdr);
    const who = recipients.length === 1 ? recipients[0] : T.someRecipient;
    if (recipients.length > 1) {
      pop.append(el(doc, "div", "tk-track-all", recipients.join(", ")));
    }
    for (const o of realOpens(t).reverse()) {
      const row = el(doc, "div", "tk-track-row");
      row.append(
        el(doc, "span", "tk-track-who", who),
        el(doc, "span", "tk-track-when", fmtOpenDate(o.ts)),
        el(doc, "span", "tk-track-app", o.client || "")
      );
      pop.append(row);
    }
    // Fixed in the document so it floats above the message body, right-aligned under "N opens".
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${Math.max(8, rect.right - POPUP_WIDTH)}px`;
    doc.documentElement.append(pop);
    const close = ev => {
      if (!anchor.contains(ev.target) && !pop.contains(ev.target)) {
        pop.remove();
        doc.removeEventListener("mousedown", close, true);
      }
    };
    doc.addEventListener("mousedown", close, true);
  }

  function updateTrack(w) {
    const mw = w.messageBrowser?.contentWindow;
    if (!mw || !String(mw.location?.href).startsWith("about:message")) {
      return;
    }
    const doc = mw.document;
    const toRow = doc.getElementById("expandedtoRow");
    if (!toRow) {
      return;
    }
    const hdr = w.messageBrowser.hidden ? null : mw.gMessage;
    const t = hdr && trackMap.get(hdr.messageId);
    let status = doc.getElementById("tk-track");
    const key = t ? `${hdr.messageId}:${t.opens.length}` : "";
    if (status?.dataset.key === key && status.parentNode === toRow) {
      return;
    }
    status?.remove();
    doc.getElementById("tk-track-pop")?.remove();
    if (!t) {
      return;
    }

    let style = doc.getElementById("tk-track-style");
    if (!style) {
      style = el(doc, "style");
      style.id = "tk-track-style";
      doc.documentElement.append(style);
    }
    if (style.textContent !== HEADER_CSS) {
      style.textContent = HEADER_CSS; // also after the add-on was updated
    }

    const n = realOpens(t).length;
    status = el(doc, "span", n > 0 ? "opened" : "", T.opens(n));
    status.id = "tk-track";
    status.dataset.key = key;
    if (n > 0) {
      status.addEventListener("mousedown", () => {
        const open = doc.getElementById("tk-track-pop");
        if (open) {
          open.remove();
        } else {
          showPopup(doc, status, hdr, t);
        }
      });
    }
    toRow.append(status);
  }

  // ---------- Patching ----------

  function refreshAll() {
    for (const w of patched.keys()) {
      for (const row of w.document.querySelectorAll("#threadTree tr.card-layout")) {
        try {
          renderTrack(row);
        } catch (e) {
          // the row is being recycled
        }
      }
      try {
        updateTrack(w);
      } catch (e) {
        // the message pane is being swapped
      }
    }
  }
  onTrackUpdate = refreshAll;

  function wrapFill(Card) {
    const orig = Card.prototype.fillRow;
    if (orig.tkTrack) {
      return;
    }
    const wrapped = function (...args) {
      const result = orig.apply(this, args);
      try {
        renderTrack(this);
      } catch (e) {
        console.error("[Tracking for Thunderbird]", e);
      }
      return result;
    };
    wrapped.tkTrack = orig;
    Card.prototype.fillRow = wrapped;
  }

  function patch(w) {
    const Card = w.customElements.get("thread-card");
    if (!Card || !w.document.getElementById("threadTree")) {
      return;
    }
    // Preview may have wrapped fillRow again on top of ours – check on every scan.
    wrapFill(Card);
    if (patched.has(w)) {
      return;
    }
    const style = el(w.document, "style");
    style.textContent = LIST_CSS;
    w.document.documentElement.append(style);
    patched.set(w, () => {
      if (Card.prototype.fillRow.tkTrack) {
        Card.prototype.fillRow = Card.prototype.fillRow.tkTrack; // remove only our own wrapper
      }
      style.remove();
      w.document.querySelectorAll(".tk-track").forEach(node => node.remove());
      try {
        const doc = w.messageBrowser.contentWindow.document;
        doc.getElementById("tk-track")?.remove();
        doc.getElementById("tk-track-pop")?.remove();
      } catch (e) {
        // message browser already gone
      }
    });
    refreshAll();
  }

  function scan() {
    for (const w of patched.keys()) {
      if (w.closed) {
        patched.delete(w);
      }
    }
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      for (const info of win.document.getElementById("tabmail")?.tabInfo ?? []) {
        const w = info.chromeBrowser?.contentWindow;
        if (w?.location.href.startsWith("about:3pane")) {
          try {
            patch(w);
            updateTrack(w);
          } catch (e) {
            // tab still loading – the next scan retries
          }
        }
      }
    }
  }

  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback({ notify: scan }, SCAN_MS, Ci.nsITimer.TYPE_REPEATING_SLACK);
  scan();

  return {
    stop() {
      timer.cancel();
      onTrackUpdate = () => {};
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

// ---------- Never let Thunderbird load our own pixel ----------
// Same mechanism Thunderbird uses to block remote content.

const POLICY_CID = Components.ID("{3f6a1c52-8d4e-4b7a-9c1e-5a2b7d9e0f13}");
const POLICY_CONTRACT = "@thunderbird-kit/tracking-policy;1";
const pixelPolicy = {
  QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
  shouldLoad(location) {
    return location.prePath === PIXEL_ORIGIN ? Ci.nsIContentPolicy.REJECT_REQUEST : Ci.nsIContentPolicy.ACCEPT;
  },
  shouldProcess() {
    return Ci.nsIContentPolicy.ACCEPT;
  },
  createInstance(iid) {
    return this.QueryInterface(iid);
  },
};

function setPixelBlocked(blocked) {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  if (blocked) {
    registrar.registerFactory(POLICY_CID, "Tracking for Thunderbird pixel policy", POLICY_CONTRACT, pixelPolicy);
    Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
  } else {
    Services.catMan.deleteCategoryEntry("content-policy", POLICY_CONTRACT, false);
    registrar.unregisterFactory(POLICY_CID, pixelPolicy);
  }
}

this.tkTracking = class extends ExtensionAPI {
  onStartup() {
    setPixelBlocked(true);
    this.state = start();
  }

  onShutdown(isAppShutdown) {
    if (!isAppShutdown) {
      this.state?.stop();
      setPixelBlocked(false);
    }
  }

  getAPI() {
    return {
      tkTracking: {
        async setTracking(json) {
          trackMap = new Map(Object.entries(JSON.parse(json)));
          onTrackUpdate();
        },
      },
    };
  }
};
