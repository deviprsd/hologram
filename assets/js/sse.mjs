"use strict";

import App from "./app.mjs";
import ComponentRegistry from "./component_registry.mjs";
import GlobalRegistry from "./global_registry.mjs";
import Hologram from "./hologram.mjs";
import Interpreter from "./interpreter.mjs";
import Logger from "./logger.mjs";
import Serializer from "./serializer.mjs";
import Type from "./type.mjs";

export default class Sse {
  static BASE_RECONNECT_DELAY = 250;
  static HANDSHAKE_PATH = "/hologram/sse/handshake";
  static MAX_RECONNECT_DELAY = 5_000;
  static RECONNECT_BACKOFF_FACTOR = 2;
  static RECONNECT_JITTER = 0.25;
  static SSE_PATH = "/hologram/sse";

  // How long a stream has to last before the client forgets the failures that preceded
  // it. Opening is not enough: the server sends the 200 before the work that can kill
  // the stream runs, so a doomed connection still opens.
  //
  // The only hard requirement is that it exceed the time a doomed stream takes to die,
  // which is milliseconds - the death follows the 200 in the same request. Everything
  // above that is policy, and this is set to MAX_RECONNECT_DELAY's 5 s for one
  // property: a stream that dies sooner than the longest retry delay can never clear
  // the count, so a connection that keeps dying right after opening climbs to the
  // ceiling and stays there rather than retrying at the floor forever. The two are
  // kept as separate numbers because they answer separate questions - how hard may we
  // retry, and how long until we trust - and should be free to move apart.
  static STABLE_CONNECTION_MS = 5_000;

  static eventSource = null;
  static reconnectAttempts = 0;
  static stabilityTimer = null;

  // Bumped by suspend() and never reset. A connect() invocation captures the epoch it
  // started with and re-checks it after every await, so a continuation that was already
  // in flight when suspend() ran can tell it has been superseded and stop instead of
  // opening a stream nobody asked for anymore. isSuspended alone can't do this: it is
  // cleared by resume(), so a stale continuation that resumes after resume() has already
  // opened the real stream would pass a plain boolean check.
  static connectionEpoch = 0;
  static isSuspended = false;
  static reconnectTimer = null;

  // Exponential backoff with ±RECONNECT_JITTER noise. Mirrors the established
  // pattern in `Hologram.Connection` so consecutive SSE reconnect failures
  // don't hammer the handshake endpoint.
  static computeReconnectDelay(attempts) {
    const baseDelay = Math.min(
      $.BASE_RECONNECT_DELAY *
        Math.pow($.RECONNECT_BACKOFF_FACTOR, attempts - 1),
      $.MAX_RECONNECT_DELAY,
    );

    const jitterRange = baseDelay * $.RECONNECT_JITTER;

    return baseDelay + (Math.random() * 2 - 1) * jitterRange;
  }

  static buildHandshakePayload() {
    const receipts = Array.from(
      App.subscriptionReceiptRegistry.entries.values(),
    ).map((triple) => triple.data[2]);

    return Type.map([
      [Type.atom("instance_id"), Type.bitstring(App.instanceId)],
      [Type.atom("receipts"), Type.list(receipts)],
    ]);
  }

  static async connect() {
    const epoch = $.connectionEpoch;

    if ($.isSuspended) return;

    try {
      const preHandshakeReceiptCount =
        App.subscriptionReceiptRegistry.entries.size;

      const response = await fetch($.HANDSHAKE_PATH, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: Serializer.serialize($.buildHandshakePayload(), "server"),
      });

      // A suspend() (and possibly a resume()) may have run while this fetch was in
      // flight. Bail rather than act on a handshake for a page that is being torn
      // down, or double-open a stream resume() already opened.
      if (epoch !== $.connectionEpoch) return;

      if (!response.ok) {
        Logger.debug(`SSE handshake error: ${response.status}`);
        $.scheduleReconnect();
        return;
      }

      const {handshakeId, refreshedReceipts: encodedRefreshed} =
        await response.json();

      if (epoch !== $.connectionEpoch) return;

      const refreshed =
        Interpreter.evaluateJavaScriptExpression(encodedRefreshed);

      if (preHandshakeReceiptCount > 0 && refreshed.data.length === 0) {
        window.location.reload();
        return;
      }

      App.subscriptionReceiptRegistry.merge(refreshed, Type.list());

      const params = new URLSearchParams({
        instance_id: App.instanceId,
        handshake_id: handshakeId,
      });

      const eventSource = new EventSource(`${$.SSE_PATH}?${params}`);
      $.eventSource = eventSource;

      eventSource.addEventListener("action", (event) => {
        const action = Interpreter.evaluateJavaScriptExpression(event.data);
        const target = Erlang_Maps["get/2"](Type.atom("target"), action);

        // Hologram realtime is fire-and-forget: silently drop actions
        // targeting cids that are not mounted on this client. Keeps the
        // dispatcher's strict contract intact for command responses (where
        // a missing cid is a real bug worth surfacing).
        if (!ComponentRegistry.isCidRegistered(target)) {
          return;
        }

        Hologram.scheduleAction(action);
      });

      eventSource.addEventListener("add_sub_receipts", (event) => {
        const receipts = Interpreter.evaluateJavaScriptExpression(event.data);
        App.subscriptionReceiptRegistry.merge(receipts, Type.list());
      });

      eventSource.addEventListener("broadcast", (event) => {
        const decoded = Interpreter.evaluateJavaScriptExpression(event.data);
        const [actionName, params, cidsList] = decoded.data;

        for (const cid of cidsList.data) {
          if (!ComponentRegistry.isCidRegistered(cid)) continue;

          const action = Type.actionStruct({
            name: actionName,
            params: params,
            target: cid,
          });

          Hologram.scheduleAction(action);
        }
      });

      eventSource.addEventListener("drop_sub_receipts", (event) => {
        const keys = Interpreter.evaluateJavaScriptExpression(event.data);
        App.subscriptionReceiptRegistry.purge(keys);
      });

      eventSource.addEventListener("refresh_sub_receipts", (event) => {
        const refreshed = Interpreter.evaluateJavaScriptExpression(event.data);
        App.subscriptionReceiptRegistry.merge(refreshed, Type.list());
      });

      eventSource.onopen = () => {
        // A stream opening after this connect() was superseded (suspend() bumped the
        // epoch, and possibly resume() already opened a newer one) reports nothing.
        if (epoch !== $.connectionEpoch) return;

        GlobalRegistry.set("sseConnected?", true);

        // Opening reports liveness. Clearing the failure count is a separate judgement
        // the stream has to earn by lasting, so one that opens and dies still counts as
        // a failed attempt and the delay after it grows.
        $.stabilityTimer = setTimeout(() => {
          $.reconnectAttempts = 0;
        }, $.STABLE_CONNECTION_MS);
      };

      // JS-driven reconnect: native EventSource auto-reconnect would re-use
      // the original URL with the now-stale single-use handshake_id and
      // produce a 4xx loop. Close the failed connection and re-run the
      // handshake protocol from scratch after an exponential backoff delay.
      // No retry cap: the receipt-expiry path inside `connect()` handles the
      // "give up and reload" case organically once stored receipts age out.
      eventSource.onerror = (event) => {
        // A superseded stream's failure isn't ours to react to: suspend() already
        // closed and nulled $.eventSource (or resume() replaced it with a newer one),
        // so touching $.eventSource here would close/reconnect the wrong stream.
        if (epoch !== $.connectionEpoch) return;

        clearTimeout($.stabilityTimer);

        Logger.debug(`SSE error: ${event.type}`);
        GlobalRegistry.set("sseConnected?", false);
        eventSource.close();

        $.scheduleReconnect();
      };
    } catch (error) {
      if (epoch !== $.connectionEpoch) return;

      Logger.debug(`SSE handshake error: ${error}`);
      $.scheduleReconnect();
    }
  }

  // Closes the current stream (if any) and blocks new connection attempts, including
  // ones already in flight. Called on `pagehide`: Chrome does not tear down an
  // EventSource across a full page navigation (Chromium issue 358538891), and on local
  // HTTP/1.1 dev six leaked streams exhaust the six-connection-per-origin pool, stalling
  // every further request to the origin - including unrelated ones.
  static suspend() {
    $.isSuspended = true;
    $.connectionEpoch++;
    $.clearReconnectTimer();

    clearTimeout($.stabilityTimer);
    $.stabilityTimer = null;

    if ($.eventSource) {
      $.eventSource.close();
      $.eventSource = null;
    }

    GlobalRegistry.set("sseConnected?", false);
  }

  // Called on `pageshow` when the page is restored from bfcache. Re-opening is left to
  // connect()'s own `eventSource === null` guard so a resume() with no matching suspend()
  // (or a doubled pageshow) can't open a second stream.
  static resume() {
    $.isSuspended = false;

    if ($.eventSource === null) {
      $.connect();
    }
  }

  static clearReconnectTimer() {
    if ($.reconnectTimer) {
      clearTimeout($.reconnectTimer);
      $.reconnectTimer = null;
    }
  }

  // Bump the failure counter and re-run the handshake protocol from scratch
  // after an exponential backoff delay. Shared by the handshake-failure paths
  // and the post-open EventSource onerror handler so a failure anywhere in the
  // connect lifecycle backs off identically instead of leaving realtime down.
  static scheduleReconnect() {
    if ($.isSuspended) return;

    $.reconnectAttempts++;
    const delay = $.computeReconnectDelay($.reconnectAttempts);

    $.reconnectTimer = setTimeout(() => $.connect(), delay);
  }
}

const $ = Sse;
