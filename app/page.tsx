"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  Activity,
  StopCircle,
  X,
  Download,
  PenTool,
  Trash2,
  Type,
  ChevronRight,
  Eraser,
  WifiOff,
  MessageCircle,
} from "lucide-react";

// ─── Session ID ──────────────────────────────────────────────────────────────
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
type DrawMode = "draw" | "text" | "erase";

interface ConversationMessage {
  role: "user" | "arix";
  text: string;
  timestamp: number;
}

export default function Home() {
  const [isLive, setIsLive] = useState(false);
  const [showExtensionPopup, setShowExtensionPopup] = useState(false);
  const [showWhiteboard, setShowWhiteboard] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>("draw");
  const [drawColor, setDrawColor] = useState<string>("#1f2937");
  const [textInput, setTextInput] = useState({
    visible: false,
    x: 0,
    y: 0,
    value: "",
  });
  const [isToolbarOpen, setIsToolbarOpen] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [arixState, setArixState] = useState<ArixState>("idle");
  const arixStateRef = useRef<ArixState>("idle");

  const [conversationHistory, setConversationHistory] = useState<
    ConversationMessage[]
  >([]);

  // Chat
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<
    { role: "user" | "arix"; text: string }[]
  >([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatMessageCount, setChatMessageCount] = useState(0);
  const chatWsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Live WS + audio
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitForAudioActiveRef = useRef(false);

  // visualizer
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const [micVolume, setMicVolume] = useState<number[]>(Array(20).fill(0));

  // Whiteboard
  const showWhiteboardRef = useRef(false);
  const whiteboardDirtyRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  useEffect(() => {
    showWhiteboardRef.current = showWhiteboard;
  }, [showWhiteboard]);

  // ─── Load/save history ────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(`arix_history_${getSessionId()}`);
    if (saved) {
      try {
        setConversationHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  useEffect(() => {
    if (conversationHistory.length > 0) {
      localStorage.setItem(
        `arix_history_${getSessionId()}`,
        JSON.stringify(conversationHistory)
      );
    }
  }, [conversationHistory]);

  // ─── Extension popup ───────────────────────────────────────────────────────
  useEffect(() => {
    const check = () => {
      setShowExtensionPopup(
        document.documentElement.getAttribute("data-arix-extension-installed") !==
          "true"
      );
    };
    check();
    const t = setTimeout(check, 200);
    return () => {
      clearTimeout(t);
      stopLiveSession();
    };
  }, []);

  // ─── Whiteboard setup ─────────────────────────────────────────────────────
  useEffect(() => {
    if (showWhiteboard && canvasRef.current && !ctxRef.current) {
      const canvas = canvasRef.current;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight - 80;
      canvas.style.width = "100%";
      canvas.style.height = `${canvas.height}px`;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.lineCap = "round";
        ctx.strokeStyle = drawColor;
        ctx.lineWidth = 4;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctxRef.current = ctx;
      }
    }
  }, [showWhiteboard, drawColor]);

  useEffect(() => {
    const handleResize = () => {
      if (!showWhiteboard || !canvasRef.current || !ctxRef.current) return;
      const oldData = canvasRef.current.toDataURL("image/png");

      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current!;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight - 80;
        canvas.style.width = "100%";
        canvas.style.height = `${canvas.height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.lineCap = "round";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        ctxRef.current = ctx;
      };
      img.src = oldData;
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [showWhiteboard]);

  useEffect(() => {
    if (!ctxRef.current) return;
    if (drawMode === "erase") {
      ctxRef.current.strokeStyle = "#ffffff";
      ctxRef.current.lineWidth = 20;
    } else {
      ctxRef.current.strokeStyle = drawColor;
      ctxRef.current.lineWidth = 4;
    }
  }, [drawColor, drawMode]);

  const getCoordinates = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    if (!canvasRef.current) return { offsetX: 0, offsetY: 0 };
    if ("touches" in e) {
      const rect = canvasRef.current.getBoundingClientRect();
      return {
        offsetX: e.touches[0].clientX - rect.left,
        offsetY: e.touches[0].clientY - rect.top,
      };
    }
    return {
      offsetX: e.nativeEvent.offsetX,
      offsetY: e.nativeEvent.offsetY,
    };
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawMode !== "text") return;
    const { offsetX, offsetY } = getCoordinates(e);
    if (textInput.visible && textInput.value.trim()) handleTextSubmit();
    setTextInput({ visible: true, x: offsetX, y: offsetY, value: "" });
  };

  const startDrawing = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    if (drawMode === "text" || !ctxRef.current) return;
    const { offsetX, offsetY } = getCoordinates(e);
    ctxRef.current.beginPath();
    ctxRef.current.moveTo(offsetX, offsetY);
    setIsDrawing(true);
  };

  const draw = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    if (!isDrawing || (drawMode !== "draw" && drawMode !== "erase") || !ctxRef.current) return;
    const { offsetX, offsetY } = getCoordinates(e);
    ctxRef.current.lineTo(offsetX, offsetY);
    ctxRef.current.stroke();
    whiteboardDirtyRef.current = true;
  };

  const stopDrawing = () => {
    ctxRef.current?.closePath();
    setIsDrawing(false);
  };

  const handleTextSubmit = (e?: React.FormEvent | React.FocusEvent) => {
    if (e) e.preventDefault();
    if (textInput.value.trim() && ctxRef.current) {
      ctxRef.current.font = "bold 24px sans-serif";
      ctxRef.current.fillStyle = drawColor;
      ctxRef.current.fillText(textInput.value, textInput.x, textInput.y + 12);
      whiteboardDirtyRef.current = true;
    }
    setTextInput({ visible: false, x: 0, y: 0, value: "" });
  };

  const clearBoard = () => {
    if (!canvasRef.current || !ctxRef.current) return;
    ctxRef.current.fillStyle = "#ffffff";
    ctxRef.current.fillRect(
      0,
      0,
      canvasRef.current.width,
      canvasRef.current.height
    );
    whiteboardDirtyRef.current = true;
  };

  // ─── TTS for chat only ─────────────────────────────────────────────────────
  const speak = (text: string) => {
    if (!text.trim()) return;
    window.speechSynthesis.cancel();

    const doSpeak = () => {
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 1.03;
      utt.pitch = 1.0;
      utt.volume = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const v =
        voices.find(
          (v) =>
            (v.name.includes("Google") || v.name.includes("Microsoft")) &&
            v.lang.startsWith("en")
        ) ||
        voices.find((v) => v.lang.startsWith("en")) ||
        voices[0];

      if (v) utt.voice = v;
      utt.onerror = (e) => console.error("[TTS]", e);
      window.speechSynthesis.speak(utt);
    };

    if (!window.speechSynthesis.getVoices().length) {
      const prev = window.speechSynthesis.onvoiceschanged;
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.onvoiceschanged = prev ?? null;
        doSpeak();
      };
    } else {
      doSpeak();
    }
  };

  // ─── Chat ──────────────────────────────────────────────────────────────────
  const openChat = () => {
    setShowChat(true);

    if (chatWsRef.current?.readyState === WebSocket.OPEN) return;

    const sessionId = getSessionId();
    const wsBase =
      process.env.NEXT_PUBLIC_WS_URL ||
      "wss://arix-backend-103963879704.us-central1.run.app";
    const wsUrl = `${wsBase.replace(/\/ws\/.*$/, "").replace(/\/$/, "")}/ws/chat?session_id=${sessionId}`;

    const ws = new WebSocket(wsUrl);
    chatWsRef.current = ws;

    ws.onopen = () => console.log("[CHAT] Connected");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "text_response" && msg.data) {
          setChatMessages((prev) => [...prev, { role: "arix", text: msg.data }]);
          setConversationHistory((prev) => [
            ...prev,
            { role: "arix", text: msg.data, timestamp: Date.now() },
          ]);
          setChatMessageCount((c) => c + 1);
          setIsChatLoading(false);
          speak(msg.data);
          setTimeout(
            () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }),
            100
          );
        } else if (msg.type === "error") {
          setIsChatLoading(false);
          console.error("[CHAT] Error:", msg.message);
        }
      } catch (e) {
        console.error("[CHAT] Parse error", e);
        setIsChatLoading(false);
      }
    };

    ws.onclose = () => console.log("[CHAT] Disconnected");
    ws.onerror = (e) => {
      console.error("[CHAT] Error", e);
      setIsChatLoading(false);
    };
  };

  const sendChatMessage = () => {
    const text = chatInput.trim();
    if (!text || isChatLoading) return;

    const ws = chatWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      openChat();
      setLiveError("Chat connecting... try again in a moment.");
      setTimeout(() => setLiveError(null), 2500);
      return;
    }

    setChatMessages((prev) => [...prev, { role: "user", text }]);
    setConversationHistory((prev) => [
      ...prev,
      { role: "user", text, timestamp: Date.now() },
    ]);
    setChatMessageCount((c) => c + 1);
    setChatInput("");
    setIsChatLoading(true);
    ws.send(JSON.stringify({ text }));

    setTimeout(
      () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }),
      100
    );
  };

  useEffect(() => {
    return () => {
      chatWsRef.current?.close();
    };
  }, []);

  // ─── Visualizer ────────────────────────────────────────────────────────────
  const startVisualizer = (stream: MediaStream, ctx: AudioContext) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
    analyserRef.current = analyser;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current) return;
      analyser.getByteFrequencyData(data);

      const bars = 20;
      const chunk = Math.floor(data.length / bars);
      const arr = Array.from({ length: bars }, (_, i) => {
        const start = i * chunk;
        const end = start + chunk;
        let sum = 0;
        for (let j = start; j < end; j++) sum += data[j] || 0;
        return sum / chunk / 255;
      });

      setMicVolume(arr);
      rafRef.current = requestAnimationFrame(tick);
    };

    tick();
  };

  // ─── Audio playback ────────────────────────────────────────────────────────
  const playNextAudioChunk = () => {
    if (!audioContextRef.current || audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;

      if (waitForAudioActiveRef.current) {
        setArixState("listening");
        arixStateRef.current = "listening";
        waitForAudioActiveRef.current = false;
      }
      return;
    }

    isPlayingRef.current = true;
    const chunk = audioQueueRef.current.shift()!;

    const buf = audioContextRef.current.createBuffer(1, chunk.length, 24000);
    buf.getChannelData(0).set(chunk);

    const src = audioContextRef.current.createBufferSource();
    src.buffer = buf;
    src.connect(audioContextRef.current.destination);
    src.onended = playNextAudioChunk;
    src.start();
  };

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.data?.type === "ARIX_SCREEN_CAPTURED" &&
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        wsRef.current.send(
          JSON.stringify({ type: "image_input", image: e.data.dataUrl })
        );
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // ─── Stop live ─────────────────────────────────────────────────────────────
  const stopLiveSession = () => {
    setIsLive(false);
    setArixState("idle");
    arixStateRef.current = "idle";
    waitForAudioActiveRef.current = false;

    window.speechSynthesis.cancel();

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    setMicVolume(Array(20).fill(0));

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    isSpeakingRef.current = false;

    scriptProcessorRef.current?.disconnect();
    scriptProcessorRef.current = null;

    micSourceRef.current?.disconnect();
    micSourceRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    if (wsRef.current) {
      if ((wsRef.current as any).visualCaptureLoop) {
        clearInterval((wsRef.current as any).visualCaptureLoop);
      }
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close(1000, "client-stop");
      }
      wsRef.current = null;
    }

    recordingContextRef.current?.close();
    recordingContextRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    audioQueueRef.current = [];
    isPlayingRef.current = false;
    whiteboardDirtyRef.current = false;
  };

  const setupAudioProcessing = (ws: WebSocket, stream: MediaStream) => {
    const recCtx = recordingContextRef.current;
    if (!recCtx) return;

    const micSource = recCtx.createMediaStreamSource(stream);
    micSourceRef.current = micSource;

    const processor = recCtx.createScriptProcessor(4096, 1, 1);
    scriptProcessorRef.current = processor;

    const silenceGain = recCtx.createGain();
    silenceGain.gain.value = 0;

    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (arixStateRef.current === "speaking") return;

      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(float32[i] * 32767))
        );
      }

      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }

      ws.send(JSON.stringify({ type: "audio_input", audio: btoa(binary) }));
    };

    micSource.connect(processor);
    processor.connect(silenceGain);
    silenceGain.connect(recCtx.destination);
  };

  // ─── Toggle live ───────────────────────────────────────────────────────────
  const toggleLive = async () => {
    if (isLive) {
      stopLiveSession();
      return;
    }

    try {
      setIsLive(true);
      setArixState("listening");
      arixStateRef.current = "listening";
      setLiveError(null);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      audioContextRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)({ sampleRate: 24000 });

      try {
        recordingContextRef.current = new AudioContext({ sampleRate: 16000 });
        if (recordingContextRef.current.state === "suspended") {
          await recordingContextRef.current.resume();
        }
      } catch {
        stopLiveSession();
        setLiveError("🎵 Audio context failed.");
        setTimeout(() => setLiveError(null), 5000);
        return;
      }

      startVisualizer(stream, recordingContextRef.current);

      const sessionId = getSessionId();
      const wsBase =
        process.env.NEXT_PUBLIC_WS_URL ||
        "wss://arix-backend-103963879704.us-central1.run.app";
      const wsUrl = `${wsBase.replace(/\/ws\/.*$/, "").replace(/\/$/, "")}/ws/live?session_id=${sessionId}`;

      const connectLiveSocket = (reconnect = false) => {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        let opened = false;

        ws.onopen = () => {
          opened = true;

          setArixState("listening");
          arixStateRef.current = "listening";

          const savedHistory =
            conversationHistory.length > 0
              ? conversationHistory
              : (() => {
                  const saved = localStorage.getItem(`arix_history_${sessionId}`);
                  if (!saved) return [];
                  try {
                    return JSON.parse(saved) as ConversationMessage[];
                  } catch {
                    return [];
                  }
                })();

          if (savedHistory.length > 0) {
            const lastFew = savedHistory.slice(-6);
            const contextMsg = lastFew
              .map((m) => `${m.role === "user" ? "User" : "Arix"}: ${m.text}`)
              .join("\n");

            ws.send(
              JSON.stringify({
                type: "context_sync",
                text: `[CONTEXT]\n${contextMsg}\n[/CONTEXT]\nContinue naturally from here.`,
              })
            );
          }

          setupAudioProcessing(ws, stream);

          const visualCaptureLoop = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              clearInterval(visualCaptureLoop);
              return;
            }

            if (showWhiteboardRef.current && canvasRef.current && whiteboardDirtyRef.current) {
              ws.send(
                JSON.stringify({
                  type: "image_input",
                  image: canvasRef.current.toDataURL("image/jpeg", 0.6),
                })
              );
              whiteboardDirtyRef.current = false;
            }
          }, 2500);

          (ws as any).visualCaptureLoop = visualCaptureLoop;
        };

        ws.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);

            if (msg.type === "capture_screen_request") {
              if (!showExtensionPopup) {
                window.postMessage({ type: "ARIX_CAPTURE_SCREEN" }, "*");
              }
            } else if (msg.type === "audio" && msg.data) {
              setArixState("speaking");
              arixStateRef.current = "speaking";

              const bytes = new Uint8Array(
                [...window.atob(msg.data)].map((c) => c.charCodeAt(0))
              );
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
            } else if (msg.type === "turn_complete") {
              waitForAudioActiveRef.current = true;

              const wait = () => {
                if (!waitForAudioActiveRef.current) return;

                if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
                  setArixState("listening");
                  arixStateRef.current = "listening";
                  isSpeakingRef.current = false;

                  if (silenceTimerRef.current) {
                    clearTimeout(silenceTimerRef.current);
                    silenceTimerRef.current = null;
                  }

                  if (recordingContextRef.current?.state === "suspended") {
                    recordingContextRef.current.resume();
                  }

                  waitForAudioActiveRef.current = false;
                } else {
                  setTimeout(wait, 100);
                }
              };

              wait();
            } else if (msg.type === "live_text" && msg.data) {
              setConversationHistory((prev) => [
                ...prev,
                { role: "arix", text: msg.data, timestamp: Date.now() },
              ]);
            } else if (msg.type === "error") {
              setLiveError(msg.message || "Live session error");
            }
          } catch (e) {
            console.error("[LIVE] message parse error", e);
          }
        };

        ws.onclose = (event) => {
          if ((ws as any).visualCaptureLoop) {
            clearInterval((ws as any).visualCaptureLoop);
          }

          if (!opened) {
            setLiveError("⚠️ Backend connect වෙන්නේ නෑ.");
            stopLiveSession();
            setTimeout(() => setLiveError(null), 5000);
            return;
          }

          if (event.code === 1000 || !isLive) {
            stopLiveSession();
            return;
          }

          setTimeout(() => {
            if (streamRef.current) connectLiveSocket(true);
          }, 1000);
        };

        ws.onerror = (e) => {
          console.error("[LIVE] websocket error", e);
        };
      };

      connectLiveSocket(false);
    } catch (err) {
      console.error("Session start error:", err);
      stopLiveSession();
      setLiveError("🎤 Microphone access deny කළා.");
      setTimeout(() => setLiveError(null), 5000);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#F5F5F7] font-sans relative overflow-hidden">
      <AnimatePresence>
        {showExtensionPopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="bg-white rounded-[2rem] shadow-2xl overflow-hidden max-w-sm w-full relative border border-gray-100"
            >
              <button
                onClick={() => setShowExtensionPopup(false)}
                className="absolute top-4 right-4 z-10 p-2 bg-black/20 hover:bg-black/40 text-white rounded-full transition-all"
              >
                <X size={18} strokeWidth={2.5} />
              </button>

              <div className="relative h-56 w-full bg-gradient-to-br from-blue-100 to-purple-100 overflow-hidden">
                <img
                  src="/extension_promo.png"
                  alt="Arix Extension"
                  className="w-full h-full object-cover absolute"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-white via-white/10 to-transparent" />
              </div>

              <div className="px-8 pb-8 pt-4 text-center bg-white">
                <h2 className="text-2xl font-black text-gray-900 mb-2">
                  Upgrade Your AI Tutor
                </h2>
                <p className="text-gray-500 mb-6 text-sm leading-relaxed">
                  Install the Arix Chrome Extension to interact with your screen!
                </p>
                <button
                  onClick={() => setShowExtensionPopup(false)}
                  className="w-full flex justify-center items-center gap-2 bg-gradient-to-r from-[#7ba2e8] to-[#608ee1] text-white py-4 px-6 rounded-2xl font-bold shadow-lg hover:-translate-y-1 transition-all"
                >
                  <Download size={22} /> Download Arix Extension
                </button>
                <button
                  onClick={() => setShowExtensionPopup(false)}
                  className="mt-4 text-sm text-gray-400 hover:text-gray-600"
                >
                  Maybe Later
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-400/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[40%] bg-purple-400/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.button
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        whileHover={{ scale: 1.05, y: -2 }}
        whileTap={{ scale: 0.95 }}
        onClick={openChat}
        className="absolute top-8 left-8 flex items-center gap-2 bg-white/80 backdrop-blur-md text-gray-800 font-semibold text-sm px-5 py-2.5 rounded-xl shadow-sm border border-gray-200/50 hover:shadow-md transition-all z-10"
      >
        <MessageCircle size={18} className="text-blue-500" />
        Chat{" "}
        {chatMessageCount > 0 && (
          <span className="bg-blue-500 text-white text-xs rounded-full px-1.5 py-0.5">
            {chatMessageCount}
          </span>
        )}
      </motion.button>

      <motion.button
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        whileHover={{ scale: 1.05, y: -2 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setShowWhiteboard(true)}
        className="absolute top-8 right-8 flex items-center gap-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg hover:-translate-y-1 transition-all z-10"
      >
        <PenTool size={18} /> Open Whiteboard
      </motion.button>

      <AnimatePresence>
        {showWhiteboard && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col"
          >
            <div className="bg-white w-full h-full flex flex-col">
              <div className="flex justify-between items-center py-4 px-6 bg-white border-b border-gray-100 shadow-sm">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                    <PenTool size={20} className="text-blue-500" />
                    AI Whiteboard
                  </h2>
                  <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full animate-pulse">
                    Visible to Arix
                  </span>
                </div>
                <button
                  onClick={() => {
                    setShowWhiteboard(false);
                    ctxRef.current = null;
                  }}
                  className="px-4 py-2 bg-gray-100 text-gray-700 flex items-center gap-2 rounded-xl font-semibold hover:bg-gray-200 transition-colors"
                >
                  <X size={16} /> Close
                </button>
              </div>

              <div className="flex-1 relative overflow-hidden">
                <motion.div
                  initial={false}
                  animate={{ x: isToolbarOpen ? 0 : -80 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center z-30"
                >
                  <div className="w-20 bg-white rounded-r-3xl shadow-lg border border-gray-100 p-4 flex flex-col items-center gap-4 py-6">
                    {[
                      ["draw", <PenTool size={20} />],
                      ["text", <Type size={20} />],
                      ["erase", <Eraser size={20} />],
                    ].map(([mode, icon]) => (
                      <button
                        key={mode as string}
                        onClick={() => setDrawMode(mode as DrawMode)}
                        className={`p-3 flex justify-center rounded-xl transition-all ${
                          drawMode === mode
                            ? mode === "erase"
                              ? "bg-gray-800 text-white"
                              : "bg-blue-100 text-blue-600"
                            : "text-gray-500 hover:bg-gray-100"
                        }`}
                      >
                        {icon as React.ReactNode}
                      </button>
                    ))}

                    <div className="w-full h-px bg-gray-100" />

                    {["#1f2937", "#ef4444", "#3b82f6", "#10b981", "#f59e0b"].map(
                      (color) => (
                        <button
                          key={color}
                          onClick={() => {
                            setDrawColor(color);
                            setDrawMode("draw");
                          }}
                          className={`w-8 h-8 rounded-full shadow-sm transition-transform ${
                            drawColor === color && drawMode !== "erase"
                              ? "scale-125 ring-2 ring-offset-2 ring-blue-400"
                              : "hover:scale-110"
                          }`}
                          style={{ backgroundColor: color }}
                        />
                      )
                    )}

                    <div className="w-full h-px bg-gray-100" />

                    <button
                      onClick={clearBoard}
                      className="p-3 text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>

                  <button
                    onClick={() => setIsToolbarOpen(!isToolbarOpen)}
                    className="absolute -right-10 top-1/2 -translate-y-1/2 bg-white w-10 h-16 rounded-r-2xl shadow-lg border border-gray-100 flex items-center justify-center hover:bg-gray-50"
                  >
                    <ChevronRight
                      size={24}
                      className={`text-gray-400 transition-transform ${
                        isToolbarOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </motion.div>

                <canvas
                  ref={canvasRef}
                  onClick={handleCanvasClick}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  onTouchStart={startDrawing}
                  onTouchMove={draw}
                  onTouchEnd={stopDrawing}
                  className="absolute inset-0 bg-white cursor-crosshair touch-none w-full h-full"
                />

                {textInput.visible && (
                  <form
                    onSubmit={handleTextSubmit}
                    className="absolute z-20"
                    style={{ left: textInput.x, top: textInput.y - 14 }}
                  >
                    <input
                      type="text"
                      autoFocus
                      className="bg-transparent text-[24px] font-bold outline-none border-b-2 px-1 min-w-[200px]"
                      style={{ color: drawColor, borderColor: drawColor }}
                      value={textInput.value}
                      onChange={(e) =>
                        setTextInput({ ...textInput, value: e.target.value })
                      }
                      onBlur={handleTextSubmit}
                      placeholder="Type here..."
                    />
                  </form>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="text-center mb-24 z-10 w-full px-6 flex flex-col items-center justify-center min-h-[45vh]">
        <AnimatePresence mode="wait">
          {!isLive ? (
            <motion.div
              key="intro"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
              transition={{ duration: 0.5 }}
              className="flex flex-col items-center"
            >
              <h1 className="text-[4.5rem] md:text-[6rem] font-black text-transparent bg-clip-text bg-gradient-to-br from-gray-900 via-gray-800 to-gray-600 tracking-tight uppercase leading-[1.1]">
                Arix AI
              </h1>
              <div className="mt-4 px-4 py-1.5 rounded-full bg-blue-100/50 border border-blue-200 text-blue-800 text-sm font-semibold flex items-center gap-2">
                🧠 Your AI Tutor with Memory
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="orb"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5, filter: "blur(10px)" }}
              transition={{ duration: 0.8, type: "spring" }}
              className="relative flex flex-col items-center justify-center mt-10"
            >
              <div className="relative flex items-center justify-center w-48 h-48 sm:w-64 sm:h-64">
                <motion.div
                  animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  className="absolute w-full h-full rounded-full bg-[#7ba2e8] blur-3xl opacity-30"
                />
                <motion.div
                  animate={{
                    borderRadius: [
                      "60% 40% 30% 70%/60% 30% 70% 40%",
                      "30% 70% 70% 30%/30% 30% 70% 70%",
                      "60% 40% 30% 70%/60% 30% 70% 40%",
                    ],
                    rotate: [0, 360],
                  }}
                  transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                  className="absolute w-44 h-44 bg-gradient-to-tr from-[#7ba2e8] via-purple-400 to-[#9cbffc] shadow-[0_0_50px_rgba(123,162,232,0.6)]"
                >
                  <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/40 to-transparent" />
                </motion.div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="absolute -bottom-8 text-gray-600 font-semibold flex items-center gap-2"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
                {arixState === "speaking"
                  ? "Arix is speaking..."
                  : arixState === "listening"
                  ? "Listening to you..."
                  : "Idle"}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.7 }}
        className="absolute bottom-8 sm:bottom-12 flex w-[90%] max-w-4xl flex-col items-center z-20"
      >
        <div className="w-full flex flex-col items-center gap-6">
          <AnimatePresence>
            {liveError && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-700 rounded-2xl px-5 py-3 shadow-lg text-sm font-semibold max-w-md w-full"
              >
                <WifiOff size={18} className="text-red-500 shrink-0" />
                <span className="flex-1">{liveError}</span>
                <button
                  onClick={() => setLiveError(null)}
                  className="p-1 rounded-lg hover:bg-red-100"
                >
                  <X size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {isLive && (
              <motion.div
                initial={{ opacity: 0, scaleY: 0 }}
                animate={{ opacity: 1, scaleY: 1 }}
                exit={{ opacity: 0, scaleY: 0 }}
                className="flex items-end justify-center gap-0.5 h-16 w-full max-w-xs"
                style={{ transformOrigin: "bottom" }}
              >
                {micVolume.map((vol, i) => {
                  const dist = Math.abs(i - 10) / 10;
                  return (
                    <div
                      key={i}
                      style={{
                        height: `${Math.max(4, vol * 56 * (1 - dist * 0.3))}px`,
                        opacity: 0.4 + vol * 0.6,
                        background: "linear-gradient(to top, #7ba2e8, #c4b5fd)",
                        transition: "height 60ms ease-out",
                        borderRadius: "9999px",
                        width: "6px",
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={toggleLive}
            className={`group relative flex items-center justify-center gap-3 px-10 py-5 rounded-[2rem] shadow-xl text-xl font-bold tracking-wide transition-all duration-300 overflow-hidden ${
              isLive
                ? "bg-red-500 text-white ring-4 ring-red-500/20"
                : "bg-white text-gray-800 hover:text-[#7ba2e8] border border-gray-200 shadow-[0_10px_30px_rgba(0,0,0,0.05)]"
            }`}
          >
            {isLive && (
              <span className="absolute inset-0 bg-red-400 opacity-20 blur-xl animate-pulse" />
            )}
            {isLive ? (
              <>
                <StopCircle size={28} className="fill-white/20" />
                <span>Stop Live Session</span>
              </>
            ) : (
              <>
                <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#7ba2e8] to-[#9cbffc] flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                  <Mic size={20} className="text-white" />
                </div>
                <span>Start Live Session</span>
                <Activity
                  size={24}
                  className="text-gray-300 group-hover:text-[#7ba2e8]/50 ml-2"
                />
              </>
            )}
          </motion.button>

          <button
            onClick={openChat}
            className="text-sm font-semibold text-blue-500 hover:text-blue-600 underline underline-offset-2 transition-colors"
          >
            Try Text Chat (with Voice)
          </button>
        </div>

        <p className="mt-4 text-xs text-gray-400 select-none">
          Arix AI can make mistakes. Consider verifying important information.
        </p>
      </motion.div>

      <AnimatePresence>
        {showChat && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.97 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-6 right-6 w-[95vw] sm:w-96 max-h-[85vh] bg-white rounded-3xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden z-50"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-400 to-indigo-500 flex items-center justify-center">
                  <span className="text-white text-xs font-black">A</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-800">Arix AI</p>
                  <p className="text-[11px] text-green-500 font-semibold">
                    Memory enabled ✨
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowChat(false)}
                className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {chatMessages.length === 0 && (
                <div className="text-center text-gray-400 text-sm mt-8">
                  <p className="text-2xl mb-2">👋</p>
                  <p>Ask Arix anything — Arix remembers our conversation!</p>
                </div>
              )}

              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-br-sm"
                        : "bg-gray-100 text-gray-800 rounded-bl-sm"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}

              {isChatLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        animate={{ y: [0, -4, 0] }}
                        transition={{
                          duration: 0.6,
                          repeat: Infinity,
                          delay: i * 0.15,
                        }}
                        className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block"
                      />
                    ))}
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <div className="px-4 py-3 border-t border-gray-100 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
                placeholder="Ask Arix..."
                className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all"
              />
              <button
                onClick={sendChatMessage}
                disabled={isChatLoading || !chatInput.trim()}
                className="px-4 py-2 bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:from-blue-600 hover:to-indigo-600 transition-all shadow-md"
              >
                Send
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}