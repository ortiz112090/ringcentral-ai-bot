import type { Server } from "http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { logger } from "../logger";
import {
  attachBargeInHandler,
  attachMediaSink,
  endCallBridge,
  pushCallerAudio,
  startCallBridge,
} from "../ringcentral/audioBridge";
import { onCallEnded } from "../callHandler";
import { escalateTwilioCall } from "./escalation";
import { getTwilioAuthToken } from "./client";
import { verifyStreamToken } from "./streamToken";

/**
 * Twilio Media Streams ↔ OpenAI Realtime bridge (WebSocket endpoint /media/{callSid}).
 *
 * Twilio connects here after the voice webhook returns <Connect><Stream url=
 * "wss://host/media/{CallSid}">. The path is per-call so the CallSid is visible on
 * the upgrade request; the per-call HMAC token (a custom <Parameter>) is still the
 * actual authenticator, verified on "start".
 *
 * Confirmed against current Twilio docs (twilio.com/docs/voice/media-streams/
 * websocket-messages, verified for this rebuild) — bidirectional frame formats:
 *   INBOUND (Twilio → us):
 *     - "connected" {event,protocol,version}                       — handshake, ignored.
 *     - "start"     {event,sequenceNumber,streamSid,start:{streamSid,accountSid,
 *                    callSid,tracks,mediaFormat:{encoding:"audio/x-mulaw",
 *                    sampleRate:8000,channels:1},customParameters}} — begin bridge.
 *     - "media"     {event,streamSid,media:{track,chunk,timestamp,payload}}
 *                    payload = base64 mulaw/8000 → pushed straight into the model.
 *     - "dtmf"/"mark" — not needed here.
 *     - "stop"      {event,streamSid,stop:{accountSid,callSid}}     — tear down.
 *   OUTBOUND (us → Twilio), streamSid REQUIRED on every frame:
 *     - media {event:"media",streamSid,media:{payload}}  (base64 mulaw/8000)
 *     - clear {event:"clear",streamSid}                  (flush buffered bot audio)
 *
 * Teardown is idempotent and runs on stop, socket close, and socket error so a
 * dropped connection never leaks a bridge or a Realtime session.
 *
 * Twilio media payloads (base64 mulaw/8000) match config.openai.realtimeAudioFormat
 * (g711_ulaw) exactly — the bridge forwards bytes both ways with no transcoding.
 */

/** Matches the per-call media upgrade path and captures the CallSid segment. */
const MEDIA_PATH_RE = /^\/media\/([^/]+)\/?$/;

/** Minimal outbound socket surface — lets tests drive the session with a fake. */
export interface TwilioSocket {
  send(data: string): void;
  close(): void;
}

/**
 * Create a media-stream session bound to one Twilio socket. `pathCallSid` is the
 * CallSid parsed from the /media/{callSid} upgrade path (when available); on
 * "start" we cross-check it against the start frame's callSid as extra defense so
 * a token minted for one call can't be replayed on a different call's path.
 * Returned handlers are driven by the ws "message"/"close"/"error" events (or
 * directly by tests).
 */
export function createMediaSession(socket: TwilioSocket, pathCallSid: string | null = null) {
  let callSid: string | null = null;
  let streamSid: string | null = null;
  let torn = false;

  async function onMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore non-JSON frames
    }

    switch (msg?.event) {
      case "connected":
        break; // handshake only

      case "start": {
        const start = msg.start ?? {};
        streamSid = msg.streamSid ?? start.streamSid ?? null;
        callSid = start.callSid ?? null;
        const params = start.customParameters ?? {};
        const callerNumber: string | null = params.from || null;
        if (!callSid || !streamSid) {
          logger.warn("Twilio media start missing callSid/streamSid; ignoring", {
            callSid,
            streamSid,
          });
          break;
        }
        const sid = streamSid;
        const cid = callSid;

        // Defense-in-depth: the CallSid in the connection path must match the one
        // in the start frame. The HMAC token below is the real authenticator, but
        // this stops a mismatched path/frame pairing outright.
        if (pathCallSid && pathCallSid !== cid) {
          logger.warn("Rejecting Twilio media stream: path CallSid != start CallSid", {
            pathCallSid,
            startCallSid: cid,
            streamSid: sid,
          });
          callSid = null;
          streamSid = null;
          socket.close();
          break;
        }

        // Security: the media socket is unauthenticated, so require the call-bound
        // token minted by the voice webhook. Reject (close, no bridge) when it is
        // missing, expired, or not a valid HMAC for THIS callSid — otherwise anyone
        // who finds the wss URL could open a paid Realtime session with a fake call.
        const authToken = await getTwilioAuthToken();
        if (!authToken || !verifyStreamToken(cid, params.token, authToken)) {
          logger.warn("Rejecting Twilio media stream: missing/invalid/expired token", {
            callSid: cid,
            streamSid: sid,
            hasToken: Boolean(params.token),
            hasAuthToken: Boolean(authToken),
          });
          // Reset so a subsequent stop/close doesn't try to tear down a bridge we
          // never started.
          callSid = null;
          streamSid = null;
          socket.close();
          break;
        }
        logger.info("Twilio media stream started", { callSid: cid, streamSid: sid, callerNumber });
        // Bridge escalation goes through the Twilio REST redirect, not RC transfer.
        await startCallBridge(cid, sid, callerNumber, {
          onEscalate: (id) => escalateTwilioCall(id),
        });
        // Outbound: stream bot audio back to Twilio as media frames.
        attachMediaSink(cid, (payload) => {
          socket.send(JSON.stringify({ event: "media", streamSid: sid, media: { payload } }));
        });
        // Barge-in: flush Twilio's outbound buffer when the caller speaks over the bot.
        attachBargeInHandler(cid, () => {
          socket.send(JSON.stringify({ event: "clear", streamSid: sid }));
        });
        break;
      }

      case "media": {
        const payload: string | undefined = msg.media?.payload;
        if (callSid && typeof payload === "string") {
          pushCallerAudio(callSid, payload);
        }
        break;
      }

      case "stop":
        logger.info("Twilio media stream stopped", { callSid, streamSid });
        await teardown();
        break;

      default:
        break; // marks, dtmf, etc. — not needed here
    }
  }

  async function teardown(): Promise<void> {
    if (torn) return;
    torn = true;
    if (callSid) {
      endCallBridge(callSid);
      await onCallEnded(callSid);
    }
  }

  return { onMessage, teardown };
}

/**
 * Attach the per-call /media/{callSid} WebSocket endpoint to the existing HTTP
 * server (no new port). Uses noServer + a single upgrade listener so only paths
 * matching /media/{callSid} upgrade; other upgrade paths are destroyed. The parsed
 * CallSid is passed to the session for cross-checking against the start frame.
 */
export function attachTwilioMediaStream(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    const match = MEDIA_PATH_RE.exec(pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const pathCallSid = decodeURIComponent(match[1]);
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, pathCallSid)
    );
  });

  wss.on("connection", (ws: WebSocket, pathCallSid: string | null) => {
    const session = createMediaSession(
      {
        send: (data) => ws.send(data),
        close: () => ws.close(),
      },
      pathCallSid ?? null
    );
    ws.on("message", (data: RawData) => {
      void session.onMessage(data.toString());
    });
    ws.on("close", () => {
      void session.teardown();
    });
    ws.on("error", (err: Error) => {
      logger.error("Twilio media socket error; tearing down", { error: err.message });
      void session.teardown();
    });
  });

  logger.info("Twilio media stream endpoint attached", { path: "/media/{callSid}" });
}
