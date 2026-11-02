"use strict";

/* Tracking for Thunderbird – sending side.
 *
 * Adds an invisible pixel from your own server (TRACK_CONFIG in config.js) to
 * every sent HTML message, offers an eye button in the compose window to turn
 * it off per message, and polls the server for opens. */

const POLL_MS = 60000;
const HISTORY_DAYS = 90;

const TITLE_ON = "Open tracking is on";
const TITLE_OFF = "Open tracking is off";

const disabledTabs = new Set(); // compose tabs with tracking turned off
const pendingTokens = new Map(); // compose tab -> pixel token of the message being sent

const SERVER = TRACK_CONFIG.url.replace(/\/+$/, ""); // same normalisation as build.sh
const ownPixel = new RegExp(`<img[^>]*${SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/o/[^>]*>`, "gi");

let lastData = null; // last /api/recent response, to skip unchanged polls

async function request(path, body) {
  const res = await fetch(SERVER + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${TRACK_CONFIG.key}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.text();
}

async function poll() {
  try {
    const data = await request(`/api/recent?days=${HISTORY_DAYS}`);
    if (data !== lastData) {
      await browser.tkTracking.setTracking(data);
      lastData = data;
    }
  } catch (e) {
    console.warn("[Tracking for Thunderbird] could not fetch opens:", e);
  }
}

// Before the quoted text (replies/forwards), otherwise at the end of the body.
function insertPixel(body, img) {
  const quote = body.search(/<div class="moz-cite-prefix"|<div class="moz-forward-container"|<blockquote/i);
  if (quote >= 0) {
    return body.slice(0, quote) + img + body.slice(quote);
  }
  return /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${img}</body>`) : body + img;
}

browser.composeAction.onClicked.addListener(async tab => {
  const on = disabledTabs.has(tab.id);
  if (on) {
    disabledTabs.delete(tab.id);
  } else {
    disabledTabs.add(tab.id);
  }
  await browser.composeAction.setIcon({ tabId: tab.id, path: on ? "icons/eye-on.svg" : "icons/eye-off.svg" });
  await browser.composeAction.setTitle({ tabId: tab.id, title: on ? TITLE_ON : TITLE_OFF });
});

// The compose window closes BEFORE onAfterSend fires, so pendingTokens is not cleared here.
browser.tabs.onRemoved.addListener(tabId => disabledTabs.delete(tabId));

browser.compose.onBeforeSend.addListener(async (tab, details) => {
  pendingTokens.delete(tab.id);
  if (details.isPlainText) {
    return {};
  }
  // Drop our own pixels from quoted text, so a reply doesn't count as an open of the old message.
  const body = details.body.replace(ownPixel, "");
  const unchanged = body === details.body;
  if (!disabledTabs.has(tab.id)) {
    try {
      const token = crypto.randomUUID();
      await request("/api/pixels", { token });
      const img = `<img src="${SERVER}/o/${token}.png" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`;
      pendingTokens.set(tab.id, token);
      return { details: { body: insertPixel(body, img) } };
    } catch (e) {
      // Server unreachable: send without tracking rather than blocking the message.
      console.warn("[Tracking for Thunderbird] sending without tracking:", e);
    }
  }
  return unchanged ? {} : { details: { body } };
});

browser.compose.onAfterSend.addListener(async (tab, info) => {
  const token = pendingTokens.get(tab.id);
  pendingTokens.delete(tab.id);
  if (!token || info.error || !info.headerMessageId) {
    return;
  }
  try {
    await request("/api/link", { token, messageId: info.headerMessageId.replace(/^<|>$/g, "") });
    await poll();
  } catch (e) {
    console.warn("[Tracking for Thunderbird] could not link the pixel to the message:", e);
  }
});

browser.composeAction.setTitle({ title: TITLE_ON });
poll();
setInterval(poll, POLL_MS);
