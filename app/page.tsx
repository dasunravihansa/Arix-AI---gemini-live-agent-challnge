"use client";

import { useEffect, useRef, useState } from "react";

function getSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem("arix_session_id");
  if (!id) {
    id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem("arix_session_id", id);
  }
  return id;
}

type ArixState = "idle" | "listening" | "speaking";

export default function Home() {
  const [isLive, setIsLive] = useState(false);
  const [arixState, setArixState] = useState<ArixState>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const arixStateRef = useRef<ArixState>("idle");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserSpeakingRef = useRef(false);

  const log = (msg: string) => {
    console.log(msg);
    setLogs((prev) => [msg, ...prev].slice(0, 40));
  };

  const stopSession = () => {
    setIsLive(false);
    setArixState("idle");
    arixStateRef.current = "idle";

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    processorRef.current?.disconnect();
    micSourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());

    processorRef.current = null;
    micSourceRef.current = null;
    streamRef.current = null;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close(1000, "client-stop");
    }
    wsRef.current = null;

    recordingContextRef.current?.close();
    audioContextRef.current?.close();
    recordingContextRef.current = null;
    audioContextRef.current = null;

    audioQueueRef.current = [];
    isPlayingRef.current = false;
  };

  const playNextAudioChunk = () => {
    if (!audioContextRef.current || audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      setArixState("listening");
      arixStateRef.current = "listening";
      log("🎤 playback finished -> listening");
      return;
    }

    isPlayingRef.current = true;
    const chunk = audioQueueRef.current.shift()!;
    const ctx = audioContextRef.current;

    const buffer = ctx.createBuffer(1, chunk.length, 24000);
    buffer.getChannelData(0).set(chunk);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      playNextAudioChunk();
    };
    source.start();
  };

  const startSession = async () => {
    try {
      setError("");
      setLogs([]);
      setIsLive(true);
      setArixState("listening");
      arixStateRef.current = "listening";

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      recordingContextRef.current = new AudioContext({ sampleRate: 16000 });

      const sessionId = getSessionId();
      const ws = new WebSocket(
        `wss://arix-backend-103963879704.us-central1.run.app/ws/live?session_id=${sessionId}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        log("✅ websocket connect");

        const recCtx = recordingContextRef.current!;
        const micSource = recCtx.createMediaStreamSource(stream);
        micSourceRef.current = micSource;

        const processor = recCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        const silentGain = recCtx.createGain();
        silentGain.gain.value = 0;

        processor.onaudioprocess = (e) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          if (arixStateRef.current === "speaking") return;

          const float32 = e.inputBuffer.getChannelData(0);
          const vol = float32.reduce((s, v) => s + Math.abs(v), 0) / float32.length;
          const isVoice = vol > 0.005;

          if (isVoice && !isUserSpeakingRef.current) {
            isUserSpeakingRef.current = true;
            wsRef.current.send(JSON.stringify({ type: "activity_start" }));
            log("🟢 activity_start");
          }

          if (isVoice) {
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = setTimeout(() => {
              if (isUserSpeakingRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                isUserSpeakingRef.current = false;
                wsRef.current.send(JSON.stringify({ type: "activity_end" }));
                log("🔴 activity_end");
              }
            }, 1200);
          }

          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }

          const bytes = new Uint8Array(int16.buffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }

          wsRef.current.send(JSON.stringify({
            type: "audio_input",
            audio: btoa(binary),
          }));
        };

        micSource.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(recCtx.destination);
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "audio" && msg.data) {
          setArixState("speaking");
          arixStateRef.current = "speaking";
          log("🔊 audio chunk received");

          const bytes = new Uint8Array([...atob(msg.data)].map((c) => c.charCodeAt(0)));
          const int16 = new Int16Array(bytes.buffer);
          const float32 = new Float32Array(int16.length);

          for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
          }

          audioQueueRef.current.push(float32);

          if (audioContextRef.current?.state === "suspended") {
            await audioContextRef.current.resume();
          }

          if (!isPlayingRef.current) {
            playNextAudioChunk();
          }
        }

        if (msg.type === "turn_complete") {
          log("✅ turn_complete");
          setTimeout(() => {
            if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
              setArixState("listening");
              arixStateRef.current = "listening";
              log("🎤 turn complete -> listening");
            }
          }, 300);
        }

        if (msg.type === "live_text" && msg.data) {
          log(`💬 ${msg.data}`);
        }

        if (msg.type === "error") {
          setError(msg.message || "Unknown error");
          log(`❌ ${msg.message}`);
        }
      };

      ws.onclose = (e) => {
        log(`❌ websocket closed: ${e.code}`);
        stopSession();
      };

      ws.onerror = () => {
        log("❌ websocket error");
        setError("WebSocket error");
      };
    } catch (e) {
      console.error(e);
      setError("Failed to start live session");
      stopSession();
    }
  };

  useEffect(() => {
    return () => stopSession();
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Arix Debug Live Test</h1>
      <p>Status: <b>{arixState}</b></p>

      {!isLive ? (
        <button onClick={startSession}>Start Live</button>
      ) : (
        <button onClick={stopSession}>Stop Live</button>
      )}

      {error && <p style={{ color: "red" }}>{error}</p>}

      <div style={{ marginTop: 20 }}>
        <h3>Logs</h3>
        <div style={{ background: "#111", color: "#0f0", padding: 12, borderRadius: 8 }}>
          {logs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
}