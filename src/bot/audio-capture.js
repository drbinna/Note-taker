// Injected into every frame before the meeting app's own scripts run.
// Set window.__notetakerMode first ('webrtc' or 'webrtc+webaudio').
//
// Two ways remote audio is caught:
//   1. WebRTC: RTCPeerConnection is wrapped so every incoming audio track is mixed in. (Google Meet)
//   2. WebAudio: AudioNode.connect is wrapped so anything an app sends to its speakers
//      (ctx.destination) is also copied into a tap. (Zoom's web client, and any app that
//      decodes audio itself.)
// When both carry the same speech, the WebRTC copy is ducked so voices aren't doubled.
// The mix is recorded with MediaRecorder and shipped to Node in 5-second webm/opus chunks
// via window.__notetakerChunk.
(() => {
  if (window.__notetaker) return;
  const mode = window.__notetakerMode || 'webrtc';

  let ctx = null;
  let dest = null;
  let rtcBus = null;
  let tapBus = null;
  let tapMeter = null;
  let recorder = null;
  const pending = [];
  const seenTracks = new Set();
  let tapCount = 0;

  function ensureGraph() {
    if (ctx) return;
    ctx = new AudioContext({ sampleRate: 48000 });
    dest = ctx.createMediaStreamDestination();
    rtcBus = ctx.createGain();
    tapBus = ctx.createGain();
    tapMeter = ctx.createAnalyser();
    tapMeter.fftSize = 1024;
    rtcBus.connect(dest);
    tapBus.connect(dest);
    tapBus.connect(tapMeter);

    // Duck WebRTC while the WebAudio tap carries sound (hold 5 s after it goes quiet).
    const buf = new Float32Array(tapMeter.fftSize);
    let lastTapSound = 0;
    setInterval(() => {
      if (!tapCount) return;
      tapMeter.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      if (Math.sqrt(sum / buf.length) > 0.002) lastTapSound = performance.now();
      const target = performance.now() - lastTapSound < 5000 ? 0 : 1;
      rtcBus.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
    }, 200);
  }

  // ---- 1. WebRTC tracks -------------------------------------------------
  function attachTrack(track) {
    if (track.kind !== 'audio' || seenTracks.has(track.id)) return;
    seenTracks.add(track.id);
    ensureGraph();
    const stream = new MediaStream([track]);
    // Chrome only decodes remote WebRTC audio into WebAudio if the stream is also
    // attached to a playing media element (crbug 933677). Muted so nothing plays out loud.
    const sink = new Audio();
    sink.muted = true;
    sink.srcObject = stream;
    sink.play().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    source.connect(rtcBus);
    track.addEventListener('ended', () => {
      try { source.disconnect(); } catch (_) {}
      sink.srcObject = null;
      seenTracks.delete(track.id);
    });
  }

  const NativePC = window.RTCPeerConnection;
  if (NativePC) {
    function PatchedPC(...args) {
      const pc = new NativePC(...args);
      pc.addEventListener('track', (e) => attachTrack(e.track));
      return pc;
    }
    PatchedPC.prototype = NativePC.prototype;
    Object.setPrototypeOf(PatchedPC, NativePC); // keep static methods (generateCertificate)
    window.RTCPeerConnection = PatchedPC;
  }

  // ---- 2. WebAudio speaker taps ------------------------------------------
  if (mode.includes('webaudio') && window.AudioNode) {
    const nativeConnect = AudioNode.prototype.connect;
    const nativeDisconnect = AudioNode.prototype.disconnect;
    const taps = new WeakMap(); // app AudioContext -> MediaStreamAudioDestinationNode

    function tapFor(appCtx) {
      if (typeof appCtx.createMediaStreamDestination !== 'function') return null; // OfflineAudioContext
      let tap = taps.get(appCtx);
      if (!tap) {
        tap = appCtx.createMediaStreamDestination();
        taps.set(appCtx, tap);
        ensureGraph();
        ctx.createMediaStreamSource(tap.stream).connect(tapBus);
        tapCount++;
      }
      return tap;
    }

    AudioNode.prototype.connect = function (target, ...rest) {
      const result = nativeConnect.call(this, target, ...rest);
      try {
        if (target instanceof AudioDestinationNode && this.context !== ctx) {
          const tap = tapFor(this.context);
          if (tap) nativeConnect.call(this, tap);
        }
      } catch (_) {}
      return result;
    };

    AudioNode.prototype.disconnect = function (target, ...rest) {
      try {
        if (target instanceof AudioDestinationNode) {
          const tap = taps.get(this.context);
          if (tap) nativeDisconnect.call(this, tap);
        }
      } catch (_) {}
      return nativeDisconnect.call(this, target, ...rest);
    };
  }

  // ---- Recorder -----------------------------------------------------------
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  window.__notetaker = {
    start() {
      ensureGraph();
      ctx.resume();
      recorder = new MediaRecorder(dest.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 32000,
      });
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        pending.push(
          e.data.arrayBuffer().then((buf) => window.__notetakerChunk(toBase64(new Uint8Array(buf))))
        );
      };
      recorder.start(5000);
      return true;
    },
    stop() {
      return new Promise((resolve) => {
        if (!recorder || recorder.state === 'inactive') return resolve(true);
        recorder.onstop = () => Promise.all(pending).then(() => resolve(true));
        recorder.stop();
      });
    },
    /** How many audio sources this frame has captured (used to pick the frame to record in). */
    sourceCount() {
      return seenTracks.size + tapCount;
    },
    mode,
  };
})();
