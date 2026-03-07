"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Mic, Activity, History, StopCircle, X, Download, PenTool, 
  Trash2, Type, ChevronRight, Eraser, AlertCircle, WifiOff,
  RefreshCw, MessageSquare, Settings 
} from "lucide-react";

// Types
interface ChatMessage {
  role: "user" | "arix";
  text: string;
  timestamp?: number;
}

interface ConversationSummary {
  session_id: string;
  message_count: number;
  summary: string;
}

export default function Home() {
  // ─── Session Management ─────────────────────────────────────────────────
  const [sessionId, setSessionId] = useState<string>("");
  const [conversationSummary, setConversationSummary] = useState<ConversationSummary | null>(null);
  
  // Live Session States
  const [isLive, setIsLive] = useState(false);
  const [showExtensionPopup, setShowExtensionPopup] = useState(false);
  const [showWhiteboard, setShowWhiteboard] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState<"draw" | "text" | "erase">("draw");
  const [drawColor, setDrawColor] = useState<string>("#1f2937");
  const [textInput, setTextInput] = useState({ visible: false, x: 0, y: 0, value: "" });
  const [isToolbarOpen, setIsToolbarOpen] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [arixState, setArixState] = useState<"idle" | "listening" | "speaking" | "thinking">("idle");
  const [connectionState, setConnectionState] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");

  // Text Chat Mode
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatWsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // ─── Audio & WebSocket Refs ────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ─── Mic Audio Visualizer ──────────────────────────────────────────────────
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const [micVolume, setMicVolume] = useState<number[]>(Array(20).fill(0));

  // Whiteboard Refs
  const showWhiteboardRef = useRef(false);
  const whiteboardDirtyRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const waitForAudioActiveRef = useRef(false);

  // ─── Initialize Session ID ────────────────────────────────────────────────
  useEffect(() => {
    // Generate or retrieve session ID
    let stored = localStorage.getItem('arix_session_id');
    if (!stored) {
      stored = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('arix_session_id', stored);
    }
    setSessionId(stored);
    
    // Try to load previous messages from localStorage
    const savedMessages = localStorage.getItem(`arix_chat_${stored}`);
    if (savedMessages) {
      try {
        setChatMessages(JSON.parse(savedMessages));
      } catch (e) {
        console.error("Failed to load saved messages", e);
      }
    }
  }, []);

  // ─── Save messages to localStorage ────────────────────────────────────────
  useEffect(() => {
    if (sessionId && chatMessages.length > 0) {
      localStorage.setItem(`arix_chat_${sessionId}`, JSON.stringify(chatMessages));
    }
  }, [chatMessages, sessionId]);

  // Sync showWhiteboard state to ref
  useEffect(() => {
    showWhiteboardRef.current = showWhiteboard;
  }, [showWhiteboard]);

  // Initialize Canvas Context
  useEffect(() => {
    if (showWhiteboard && canvasRef.current) {
      if (!ctxRef.current) {
        const canvas = canvasRef.current;
        const width = window.innerWidth;
        const height = window.innerHeight - 80;

        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `100%`;
        canvas.style.height = `${height}px`;

        const context = canvas.getContext("2d");
        if (context) {
          context.lineCap = "round";
          context.strokeStyle = drawColor;
          context.lineWidth = 4;
          ctxRef.current = context;

          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
    }
  }, [showWhiteboard]);

  // Update brush settings
  useEffect(() => {
    if (ctxRef.current) {
      if (drawMode === "erase") {
        ctxRef.current.strokeStyle = "#ffffff";
        ctxRef.current.lineWidth = 20;
      } else {
        ctxRef.current.strokeStyle = drawColor;
        ctxRef.current.lineWidth = 4;
      }
    }
  }, [drawColor, drawMode]);

  // ─── Drawing Handlers ──────────────────────────────────────────────────────
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawMode === "text") {
      const { offsetX, offsetY } = getCoordinates(e);
      if (textInput.visible && textInput.value.trim() !== "") {
        handleTextSubmit();
      }
      setTextInput({ visible: true, x: offsetX, y: offsetY, value: "" });
    }
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (drawMode === "text") return;
    if (!ctxRef.current) return;
    const { offsetX, offsetY } = getCoordinates(e);
    ctxRef.current.beginPath();
    ctxRef.current.moveTo(offsetX, offsetY);
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || (drawMode !== "draw" && drawMode !== "erase") || !ctxRef.current) return;
    const { offsetX, offsetY } = getCoordinates(e);
    ctxRef.current.lineTo(offsetX, offsetY);
    ctxRef.current.stroke();
    whiteboardDirtyRef.current = true;
  };

  const stopDrawing = () => {
    if (!ctxRef.current || (drawMode !== "draw" && drawMode !== "erase")) return;
    ctxRef.current.closePath();
    setIsDrawing(false);
  };

  const handleTextSubmit = (e?: React.FormEvent | React.FocusEvent) => {
    if (e) e.preventDefault();
    if (textInput.value.trim() && ctxRef.current) {
      ctxRef.current.font = "bold 24px 'Geist Sans', sans-serif";
      ctxRef.current.fillStyle = drawColor;
      ctxRef.current.fillText(textInput.value, textInput.x, textInput.y + 12);
      whiteboardDirtyRef.current = true;
    }
    setTextInput({ visible: false, x: 0, y: 0, value: "" });
  };

  const clearBoard = () => {
    if (!canvasRef.current || !ctxRef.current) return;
    const canvas = canvasRef.current;
    ctxRef.current.fillStyle = "#ffffff";
    ctxRef.current.fillRect(0, 0, canvas.width, canvas.height);
    whiteboardDirtyRef.current = true;
  };

  const getCoordinates = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return { offsetX: 0, offsetY: 0 };
    const canvas = canvasRef.current;
    if ("touches" in e) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      return {
        offsetX: touch.clientX - rect.left,
        offsetY: touch.clientY - rect.top,
      };
    } else {
      return {
        offsetX: e.nativeEvent.offsetX,
        offsetY: e.nativeEvent.offsetY,
      };
    }
  };

  // ─── Extension Check ──────────────────────────────────────────────────────
  useEffect(() => {
    const checkExtensionInstalled = () => {
      if (document.documentElement.getAttribute("data-arix-extension-installed") === "true") {
        setShowExtensionPopup(false);
      } else {
        setShowExtensionPopup(true);
      }
    };

    checkExtensionInstalled();
    setTimeout(checkExtensionInstalled, 200);

    return () => {
      stopLiveSession();
    };
  }, []);

  // ─── TTS Function ─────────────────────────────────────────────────────────
  const speak = (text: string) => {
    window.speechSynthesis.cancel();

    const doSpeak = () => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v =>
        (v.name.includes("Google") || v.name.includes("Microsoft")) &&
        v.lang.startsWith("en")
      ) || voices.find(v => v.lang.startsWith("en")) || voices[0];
      if (preferred) utterance.voice = preferred;

      utterance.onerror = (e) => console.error("[TTS] Error:", e);
      window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.onvoiceschanged = null;
        doSpeak();
      };
    } else {
      doSpeak();
    }
  };

  // ─── Helper function to build WebSocket URL ──────────────────────────────
  const buildWebSocketUrl = (endpoint: string): string => {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL || "https://arix-backend-103963879704.us-central1.run.app";
    // Remove trailing slashes
    const cleanBase = baseUrl.replace(/\/+$/, "");
    // Convert https:// to wss:// (or http:// to ws://)
    const wsProtocol = cleanBase.startsWith('https') ? 'wss://' : 'ws://';
    const domain = cleanBase.replace(/^https?:\/\//, '');
    return `${wsProtocol}${domain}${endpoint}?session_id=${sessionId}`;
  };

  // ─── Enhanced Chat Functions ─────────────────────────────────────────────
  const openChat = () => {
    setShowChat(true);
    setChatError(null);

    // Unlock TTS
    const unlock = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(unlock);

    if (chatWsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = buildWebSocketUrl('/chat');
    
    console.log(`[CHAT] Connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    chatWsRef.current = ws;

    ws.onopen = () => {
      console.log("[CHAT] Connected with session:", sessionId);
      setChatError(null);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "text_response" && msg.data) {
          const newMessage: ChatMessage = {
            role: "arix",
            text: msg.data,
            timestamp: Date.now()
          };
          
          setChatMessages(prev => [...prev, newMessage]);
          setIsChatLoading(false);
          speak(msg.data);
          
          // Update conversation summary if available
          if (msg.conversation_summary) {
            setConversationSummary({
              session_id: sessionId,
              message_count: chatMessages.length + 1,
              summary: msg.conversation_summary
            });
          }
          
          setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
        } else if (msg.type === "error") {
          setChatError(msg.message);
          setIsChatLoading(false);
        }
      } catch (e) { 
        console.error("[CHAT] Parse error", e); 
      }
    };

    ws.onclose = (event) => {
      console.log(`[CHAT] Disconnected: ${event.code} ${event.reason}`);
      if (event.code !== 1000) {
        setChatError("Connection lost. Try again.");
      }
    };

    ws.onerror = (e) => { 
      console.error("[CHAT] Error", e); 
      setChatError("Failed to connect to chat server");
      setIsChatLoading(false); 
    };
  };

  const sendChatMessage = () => {
    const text = chatInput.trim();
    if (!text) return;

    if (!chatWsRef.current || chatWsRef.current.readyState !== WebSocket.OPEN) {
      openChat();
      setTimeout(() => sendChatMessage(), 1000);
      return;
    }

    // Add user message
    const userMessage: ChatMessage = {
      role: "user",
      text,
      timestamp: Date.now()
    };
    
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput("");
    setIsChatLoading(true);
    setArixState("thinking");

    // Get recent context (last 5 messages)
    const recentContext = chatMessages.slice(-5).map(m => 
      `${m.role === "user" ? "Student" : "Arix"}: ${m.text}`
    ).join("\n");

    // Send with context
    chatWsRef.current.send(JSON.stringify({ 
      text,
      context: recentContext,
      session_id: sessionId
    }));

    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  const clearChatHistory = () => {
    setChatMessages([]);
    localStorage.removeItem(`arix_chat_${sessionId}`);
    if (chatWsRef.current?.readyState === WebSocket.OPEN) {
      chatWsRef.current.close();
      chatWsRef.current = null;
    }
  };

  // ─── Audio Playback ─────────────────────────────────────────────────────
  const playNextAudioChunk = () => {
    if (!audioContextRef.current || audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      if (arixState === "speaking") {
        setArixState("listening");
      }
      return;
    }

    isPlayingRef.current = true;
    const chunk = audioQueueRef.current.shift()!;
    const audioBuffer = audioContextRef.current.createBuffer(1, chunk.length, 24000);
    audioBuffer.getChannelData(0).set(chunk);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);

    source.onended = () => {
      playNextAudioChunk();
    };
    source.start();
  };

  // ─── Extension Message Listener ────────────────────────────────────────────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "ARIX_SCREEN_CAPTURED") {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "realtime_input",
            image: event.data.dataUrl,
            session_id: sessionId
          }));
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [sessionId]);

  // ─── Stop Live Session ─────────────────────────────────────────────────────
  const stopLiveSession = () => {
    setIsLive(false);
    setArixState("idle");
    setConnectionState("disconnected");
    waitForAudioActiveRef.current = false;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    setMicVolume(Array(20).fill(0));

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (wsRef.current && (wsRef.current as any).visualCaptureLoop) {
      clearInterval((wsRef.current as any).visualCaptureLoop);
    }

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    if (recordingContextRef.current) {
      recordingContextRef.current.close();
      recordingContextRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    audioQueueRef.current = [];
    isPlayingRef.current = false;
    whiteboardDirtyRef.current = false;
  };

  // ─── Toggle Live Session ───────────────────────────────────────────────────
  const toggleLive = async () => {
    if (isLive) {
      stopLiveSession();
      return;
    }

    try {
      setConnectionState("connecting");
      setLiveError(null);
      
      console.log("Starting Live Voice Session with session:", sessionId);
      setIsLive(true);
      setArixState("listening");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });

      try {
        recordingContextRef.current = new AudioContext({ sampleRate: 16000 });
        if (recordingContextRef.current.state === 'suspended') {
          await recordingContextRef.current.resume();
        }
      } catch (error) {
        console.error("[AUDIO] Failed to create recording AudioContext:", error);
        stopLiveSession();
        setLiveError("Audio context creation failed. Browser compatibility issue.");
        setTimeout(() => setLiveError(null), 6000);
        return;
      }

      const wsUrl = buildWebSocketUrl('/ws/live');
      
      console.log(`[WS] Connecting to ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      let wasConnected = false;

      ws.onopen = () => {
        wasConnected = true;
        setConnectionState("connected");
        setLiveError(null);
        console.log("Connected to Arix Backend with session:", sessionId);

        const recCtx = recordingContextRef.current;
        if (!recCtx || recCtx.state !== 'running') {
          console.error("[AUDIO] recordingContextRef is null or not running");
          stopLiveSession();
          setLiveError("Audio context not ready. Try again.");
          setTimeout(() => setLiveError(null), 6000);
          return;
        }

        const micSource = recCtx.createMediaStreamSource(stream);
        micSourceRef.current = micSource;

        const analyser = recCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.75;
        analyserRef.current = analyser;
        micSource.connect(analyser);

        const BAR_COUNT = 20;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const drawWave = () => {
          rafRef.current = requestAnimationFrame(drawWave);
          analyser.getByteFrequencyData(dataArray);
          const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
            const binIndex = Math.floor(i * (dataArray.length / BAR_COUNT));
            return dataArray[binIndex] / 255;
          });
          setMicVolume(bars);
        };
        drawWave();

        const processor = recCtx.createScriptProcessor(4096, 1, 1);
        scriptProcessorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;

          const float32 = e.inputBuffer.getChannelData(0);
          const volume = float32.reduce((sum, val) => sum + Math.abs(val), 0) / float32.length;
          const isVoice = volume > 0.01;

          if (isVoice && !isSpeakingRef.current) {
            isSpeakingRef.current = true;
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            ws.send(JSON.stringify({ type: "activity_start" }));
          }

          if (isVoice) {
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = setTimeout(() => {
              if (isSpeakingRef.current) {
                isSpeakingRef.current = false;
                ws.send(JSON.stringify({ type: "activity_end" }));
              }
            }, 1500);
          }

          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }
          const bytes = new Uint8Array(int16.buffer);
          let binary = "";
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          ws.send(JSON.stringify({ type: "realtime_input", audio: btoa(binary) }));
        };

        micSource.connect(processor);
        processor.connect(recCtx.destination);

        const visualCaptureLoop = setInterval(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            clearInterval(visualCaptureLoop);
            return;
          }

          if (showWhiteboardRef.current && canvasRef.current && whiteboardDirtyRef.current) {
            const dataURL = canvasRef.current.toDataURL("image/jpeg", 0.5);
            ws.send(JSON.stringify({ 
              type: "realtime_input", 
              image: dataURL,
              session_id: sessionId 
            }));
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
            
            const binaryStr = window.atob(msg.data);
            const length = binaryStr.length;
            const bytes = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }

            const int16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
              float32[i] = int16[i] / 32768.0;
            }

            audioQueueRef.current.push(float32);

            if (audioContextRef.current?.state === "suspended") {
              await audioContextRef.current.resume();
            }

            if (!isPlayingRef.current) {
              playNextAudioChunk();
            }

          } else if (msg.type === "turn_complete") {
            console.log("✅ Turn complete");
            
            waitForAudioActiveRef.current = true;
            const waitForAudio = () => {
              if (!waitForAudioActiveRef.current) return;
              if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
                setArixState("listening");
                if (recordingContextRef.current?.state === 'suspended') {
                  recordingContextRef.current.resume();
                }
                waitForAudioActiveRef.current = false;
              } else {
                setTimeout(waitForAudio, 100);
              }
            };
            waitForAudio();
            
          } else if (msg.type === "live_text" && msg.data) {
            speak(msg.data);
          } else if (msg.type === "error") {
            setLiveError(msg.message);
          }
        } catch (e) {
          console.error("Failed to parse incoming message", e);
        }
      };

      ws.onclose = (event) => {
        console.log(`[WS] Closed — code: ${event.code}, wasConnected: ${wasConnected}`);
        setConnectionState("disconnected");
        
        if ((ws as any).visualCaptureLoop) clearInterval((ws as any).visualCaptureLoop);
        
        if (!wasConnected) {
          const baseUrl = process.env.NEXT_PUBLIC_WS_URL || "https://arix-backend-103963879704.us-central1.run.app";
          if (baseUrl.includes("localhost")) {
            setLiveError("⚠️ Backend not running! Run 'cd backend && python main.py'");
          } else {
            setLiveError("⚠️ Unable to reach backend. Check if Cloud Run service is running");
          }
        } else if (event.code !== 1000) {
          setLiveError("🔌 Connection lost. Reconnecting...");
          
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            if (isLive) {
              console.log("Attempting to reconnect...");
              toggleLive();
            }
          }, 3000);
        }
        
        stopLiveSession();
        setTimeout(() => setLiveError(null), 6000);
      };

      ws.onerror = () => {
        console.error("[WS] WebSocket error");
        setConnectionState("error");
      };
      
    } catch (err) {
      console.error("Error accessing microphone:", err);
      stopLiveSession();
      setLiveError("🎤 Microphone access denied. Allow in browser settings.");
      setTimeout(() => setLiveError(null), 6000);
    }
  };

  // Cleanup chat WS on unmount
  useEffect(() => {
    return () => { 
      chatWsRef.current?.close(); 
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  // ─── UI / JSX ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#F5F5F7] font-sans relative overflow-hidden">

      {/* Extension Promo Modal */}
      <AnimatePresence>
        {showExtensionPopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="bg-white rounded-4xl shadow-2xl overflow-hidden max-w-sm w-full relative border border-gray-100"
            >
              <button
                onClick={() => setShowExtensionPopup(false)}
                className="absolute top-4 right-4 z-10 p-2 bg-black/20 hover:bg-black/40 backdrop-blur-sm text-white rounded-full transition-all"
              >
                <X size={18} strokeWidth={2.5} />
              </button>

              <div className="relative h-56 w-full flex items-center justify-center overflow-hidden bg-linear-to-br from-blue-100 to-purple-100">
                <img src="/extension_promo.png" alt="Arix Extension Preview" className="w-[110%] h-[110%] object-cover absolute" />
                <div className="absolute inset-0 bg-linear-to-t from-white via-white/10 to-transparent"></div>
              </div>

              <div className="px-8 pb-8 pt-4 text-center relative z-10 bg-white">
                <h2 className="text-2xl font-black text-gray-900 mb-2 tracking-tight">Upgrade Your AI Tutor</h2>
                <p className="text-gray-500 mb-6 text-[15px] leading-relaxed font-medium">
                  Install the Arix Chrome Extension to seamlessly interact with your screen!
                </p>

                <button
                  onClick={() => setShowExtensionPopup(false)}
                  className="w-full flex justify-center items-center gap-2 bg-linear-to-r from-[#7ba2e8] to-[#608ee1] text-white py-4 px-6 rounded-2xl font-bold shadow-[0_10px_20px_rgba(123,162,232,0.3)] hover:shadow-[0_15px_25px_rgba(123,162,232,0.4)] hover:-translate-y-1 transition-all"
                >
                  <Download size={22} className="opacity-90" />
                  Download Extension
                </button>
                <button
                  onClick={() => setShowExtensionPopup(false)}
                  className="mt-6 text-sm font-semibold text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Maybe Later
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Decorative Background Elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-400/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[40%] bg-purple-400/20 blur-[120px] rounded-full pointer-events-none" />

      {/* Session Info */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-white/80 backdrop-blur-md px-4 py-2 rounded-full shadow-sm border border-gray-200/50 z-10 flex items-center gap-2"
      >
        <span className="w-2 h-2 rounded-full bg-green-500"></span>
        <span className="text-xs font-medium text-gray-600">
          Session: {sessionId.slice(0, 8)}...
        </span>
      </motion.div>

      {/* History Button */}
      <motion.button
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        whileHover={{ scale: 1.05, y: -2 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setShowChat(true)}
        className="absolute top-8 left-8 flex items-center gap-2 bg-white/80 backdrop-blur-md text-gray-800 font-semibold text-sm px-5 py-2.5 rounded-xl shadow-sm border border-gray-200/50 hover:shadow-md transition-all z-10"
      >
        <MessageSquare size={18} className="text-gray-600" />
        Chat ({chatMessages.length})
      </motion.button>

      {/* Open Whiteboard Button */}
      <motion.button
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
        whileHover={{ scale: 1.05, y: -2 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setShowWhiteboard(true)}
        className="absolute top-8 right-8 flex items-center gap-2 bg-linear-to-r from-blue-500 to-indigo-600 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg border border-blue-400/50 hover:shadow-xl hover:from-blue-600 hover:to-indigo-700 transition-all z-10"
      >
        <PenTool size={18} className="text-white" />
        Open Whiteboard
      </motion.button>

      {/* Whiteboard Modal */}
      <AnimatePresence>
        {showWhiteboard && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm p-6"
          >
            <div className="bg-white w-full h-full relative flex flex-col items-center justify-start rounded-2xl overflow-hidden">
              <div className="w-full flex justify-between items-center py-4 px-6 bg-white border-b border-gray-100 shadow-sm z-20">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                    <PenTool size={20} className="text-blue-500" />
                    AI Whiteboard
                  </h2>
                  <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full animate-pulse shadow-sm">
                    Visible to Arix
                  </span>
                </div>
                <button
                  onClick={() => { setShowWhiteboard(false); ctxRef.current = null; }}
                  className="px-4 py-2 bg-gray-100 text-gray-700 flex items-center gap-2 rounded-xl font-semibold hover:bg-gray-200 transition-colors"
                >
                  <X size={16} />
                  Close
                </button>
              </div>

              <div className="flex-1 w-full bg-gray-50 overflow-hidden relative flex">
                <motion.div
                  initial={false}
                  animate={{ x: isToolbarOpen ? 0 : -80 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center z-30"
                >
                  <div className="w-20 bg-white rounded-r-3xl shadow-[5px_0_15px_rgba(0,0,0,0.05)] border border-gray-100 p-4 flex flex-col items-center gap-4 py-6">
                    <div className="flex flex-col gap-2 w-full">
                      <button
                        onClick={() => setDrawMode("draw")}
                        className={`p-3 flex justify-center items-center rounded-xl transition-all ${drawMode === "draw" ? "bg-blue-100 text-blue-600 shadow-sm" : "text-gray-500 hover:bg-gray-100"}`}
                        title="Pen"
                      >
                        <PenTool size={20} />
                      </button>
                      <button
                        onClick={() => setDrawMode("text")}
                        className={`p-3 flex justify-center items-center rounded-xl transition-all ${drawMode === "text" ? "bg-blue-100 text-blue-600 shadow-sm" : "text-gray-500 hover:bg-gray-100"}`}
                        title="Text"
                      >
                        <Type size={20} />
                      </button>
                      <button
                        onClick={() => setDrawMode("erase")}
                        className={`p-3 flex justify-center items-center rounded-xl transition-all ${drawMode === "erase" ? "bg-gray-800 text-white shadow-sm" : "text-gray-500 hover:bg-gray-100"}`}
                        title="Eraser"
                      >
                        <Eraser size={20} />
                      </button>
                    </div>

                    <div className="w-full h-px bg-gray-100 my-1"></div>

                    <div className="flex flex-col gap-3 my-2">
                      {["#1f2937", "#ef4444", "#3b82f6", "#10b981", "#f59e0b"].map((color) => (
                        <button
                          key={color}
                          onClick={() => { setDrawColor(color); setDrawMode("draw"); }}
                          className={`w-8 h-8 rounded-full shadow-sm transition-transform ${drawColor === color && drawMode !== "erase" ? "scale-125 ring-2 ring-offset-2 ring-blue-400" : "hover:scale-110"}`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>

                    <div className="w-full h-px bg-gray-100 my-1"></div>

                    <button
                      onClick={clearBoard}
                      className="p-3 flex justify-center items-center rounded-xl text-red-500 hover:bg-red-50 transition-colors mt-2"
                      title="Clear"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>

                  <button
                    onClick={() => setIsToolbarOpen(!isToolbarOpen)}
                    className="absolute -right-10 top-1/2 -translate-y-1/2 bg-white w-10 h-16 rounded-r-2xl shadow-[5px_0_15px_rgba(0,0,0,0.05)] border-y border-r border-gray-100 flex items-center justify-center hover:bg-gray-50 transition-colors"
                  >
                    <ChevronRight size={24} className={`text-gray-400 transition-transform ${isToolbarOpen ? "rotate-180" : ""}`} />
                  </button>
                </motion.div>

                <div className="relative overflow-hidden bg-white touch-none w-full h-full">
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
                    className="absolute inset-0 cursor-crosshair touch-none"
                  />

                  {textInput.visible && (
                    <form onSubmit={handleTextSubmit} className="absolute z-20" style={{ left: textInput.x, top: textInput.y - 14 }}>
                      <input
                        type="text"
                        autoFocus
                        className={`bg-transparent text-[24px] font-bold outline-none border-b-2 px-1 py-0 min-w-50 ${drawColor === "#ffffff" ? "text-gray-800 border-blue-500" : ""}`}
                        style={{ color: drawColor !== "#ffffff" ? drawColor : "inherit", borderColor: drawColor !== "#ffffff" ? drawColor : "inherit" }}
                        value={textInput.value}
                        onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                        onBlur={handleTextSubmit}
                        placeholder="Type text..."
                      />
                    </form>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="text-center mb-24 z-10 w-full px-6 flex flex-col items-center justify-center min-h-[45vh]">
        <AnimatePresence mode="wait">
          {!isLive ? (
            <motion.div
              key="intro-text"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
              transition={{ duration: 0.5 }}
              className="flex flex-col items-center"
            >
              <h1 className="text-[4.5rem] md:text-[6rem] font-black text-transparent bg-clip-text bg-linear-to-br from-gray-900 via-gray-800 to-gray-600 tracking-tight uppercase leading-[1.1]">
                Arix AI
              </h1>
              <div className="mt-6 px-4 py-1.5 rounded-full bg-blue-100/50 border border-blue-200 text-blue-800 text-sm font-semibold tracking-wide shadow-sm flex items-center gap-2">
                ✨ Your AI Tutor with Memory
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="ai-orb"
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
                      "60% 40% 30% 70% / 60% 30% 70% 40%",
                      "30% 70% 70% 30% / 30% 30% 70% 70%",
                      "60% 40% 30% 70% / 60% 30% 70% 40%",
                    ],
                    rotate: [0, 360],
                  }}
                  transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                  className="absolute w-44 h-44 bg-linear-to-tr from-[#7ba2e8] via-purple-400 to-[#9cbffc] shadow-[0_0_50px_rgba(123,162,232,0.6)] flex items-center justify-center overflow-hidden"
                >
                  <div className="absolute inset-0 rounded-full bg-linear-to-b from-white/40 to-transparent" />
                  
                  {/* Thinking animation when Arix is processing */}
                  {arixState === "thinking" && (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                      className="absolute inset-0 rounded-full border-4 border-white/30 border-t-white/90"
                    />
                  )}
                  
                  {/* Inner glow */}
                  <div className="absolute inset-4 rounded-full bg-white/20 blur-md" />
                </motion.div>
              </div>

              {/* Status label with connection state */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="absolute -bottom-8 text-gray-600 font-semibold tracking-wide flex items-center gap-2 z-10"
              >
                <span className={`w-2.5 h-2.5 rounded-full ${
                  connectionState === "connected" 
                    ? "bg-green-500 animate-pulse" 
                    : connectionState === "connecting"
                    ? "bg-yellow-500 animate-pulse"
                    : "bg-red-500"
                } shadow-[0_0_10px_rgba(0,0,0,0.3)]`} />
                
                {arixState === "speaking" 
                  ? "Arix is speaking..." 
                  : arixState === "thinking"
                  ? "Arix is thinking..."
                  : connectionState === "connecting"
                  ? "Connecting..."
                  : connectionState === "connected"
                  ? "Listening to you..."
                  : "Ready to listen"}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Modern Input Container */}
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.7, ease: "easeOut" }}
        className="absolute bottom-8 sm:bottom-12 flex w-[90%] max-w-full sm:max-w-4xl flex-col items-center z-20"
      >
        <div className="w-full flex-col flex items-center justify-center gap-6 mt-10">

          {/* ── Error Toast ───────────────────────────────────────────────── */}
          <AnimatePresence>
            {liveError && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
                className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-700 rounded-2xl px-5 py-3 shadow-lg text-sm font-semibold max-w-md w-full"
              >
                <WifiOff size={18} className="shrink-0 text-red-500" />
                <span className="flex-1">{liveError}</span>
                <button
                  onClick={() => setLiveError(null)}
                  className="shrink-0 p-1 rounded-lg hover:bg-red-100 transition-colors"
                >
                  <X size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Chat Error Toast */}
          <AnimatePresence>
            {chatError && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
                className="flex items-center gap-3 bg-orange-50 border border-orange-200 text-orange-700 rounded-2xl px-5 py-3 shadow-lg text-sm font-semibold max-w-md w-full"
              >
                <AlertCircle size={18} className="shrink-0 text-orange-500" />
                <span className="flex-1">{chatError}</span>
                <button
                  onClick={() => setChatError(null)}
                  className="shrink-0 p-1 rounded-lg hover:bg-orange-100 transition-colors"
                >
                  <X size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Audio Visualizer (Shows only when Live) */}
          <AnimatePresence>
            {isLive && (
              <motion.div
                initial={{ opacity: 0, scaleY: 0 }}
                animate={{ opacity: 1, scaleY: 1 }}
                exit={{ opacity: 0, scaleY: 0 }}
                className="flex items-end justify-center gap-0.75 h-16 w-full max-w-xs px-2"
                style={{ transformOrigin: "bottom" }}
              >
                {micVolume.map((vol, i) => {
                  const center = micVolume.length / 2;
                  const distFromCenter = Math.abs(i - center) / center;
                  const height = Math.max(4, vol * 56 * (1 - distFromCenter * 0.3));
                  const opacity = 0.4 + vol * 0.6;
                  
                  const color = arixState === "speaking" 
                    ? "from-purple-500 to-pink-500"
                    : arixState === "thinking"
                    ? "from-yellow-500 to-orange-500"
                    : "from-[#7ba2e8] to-[#c4b5fd]";
                  
                  return (
                    <div
                      key={i}
                      style={{
                        height: `${height}px`,
                        opacity,
                        background: `linear-gradient(to top, ${color.split(' ')[0].replace('from-', '')}, ${color.split(' ')[1].replace('to-', '')})`,
                        transition: "height 60ms ease-out, opacity 60ms ease-out",
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

          {/* Main Live Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={toggleLive}
            disabled={connectionState === "connecting"}
            className={`group relative flex items-center justify-center gap-3 px-10 py-5 rounded-4xl shadow-xl text-xl font-bold tracking-wide transition-all duration-300 overflow-hidden ${
              isLive
                ? "bg-red-500 text-white shadow-[#ff4757]/30 ring-4 ring-red-500/20"
                : connectionState === "connecting"
                ? "bg-gray-400 text-white cursor-not-allowed"
                : "bg-white text-gray-800 hover:text-[#7ba2e8] border-[1.5px] border-gray-200 shadow-[0_10px_30px_rgba(0,0,0,0.05)]"
            }`}
          >
            {isLive && (
              <span className="absolute inset-0 bg-red-400 opacity-20 blur-xl animate-pulse"></span>
            )}

            {isLive ? (
              <>
                <StopCircle size={28} className="fill-white/20" />
                <span>Stop Live Session</span>
              </>
            ) : connectionState === "connecting" ? (
              <>
                <RefreshCw size={28} className="animate-spin" />
                <span>Connecting...</span>
              </>
            ) : (
              <>
                <div className="w-10 h-10 rounded-full bg-linear-to-tr from-[#7ba2e8] to-[#9cbffc] flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                  <Mic size={20} className="text-white fill-white/20" />
                </div>
                <span>Start Live Session</span>
                <Activity size={24} className="text-gray-300 group-hover:text-[#7ba2e8]/50 transition-colors ml-2" />
              </>
            )}
          </motion.button>

          {/* Try Text Chat Button */}
          <button
            onClick={openChat}
            className="mt-3 text-sm font-semibold text-blue-500 hover:text-blue-600 underline underline-offset-2 transition-colors flex items-center gap-1"
          >
            <MessageSquare size={14} />
            Try Text Chat (with Voice)
            {chatMessages.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full text-[10px] font-bold">
                {chatMessages.length}
              </span>
            )}
          </button>
        </div>

        {/* Footer tiny text */}
        <p className="mt-4 text-xs font-medium text-gray-400 select-none">
          Arix AI can make mistakes. Consider verifying important information.
        </p>
      </motion.div>

      {/* ── Text Chat Panel ──────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showChat && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.97 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-6 right-6 w-[95vw] sm:w-96 max-h-[85vh] bg-white rounded-3xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden z-50"
          >
            {/* Chat Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-linear-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-linear-to-tr from-blue-400 to-indigo-500 flex items-center justify-center">
                  <span className="text-white text-xs font-black">A</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-800">Arix AI</p>
                  <p className="text-[11px] text-green-500 font-semibold flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      chatWsRef.current?.readyState === WebSocket.OPEN 
                        ? "bg-green-500 animate-pulse" 
                        : "bg-gray-400"
                    }`} />
                    {chatWsRef.current?.readyState === WebSocket.OPEN ? "Connected" : "Disconnected"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={clearChatHistory}
                  className="p-1.5 rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
                  title="Clear history"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  onClick={() => setShowChat(false)}
                  className="p-1.5 rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-96 max-h-96">
              {chatMessages.length === 0 && (
                <div className="text-center text-gray-400 text-sm mt-8">
                  <p className="text-2xl mb-2">👋</p>
                  <p>Ask Arix anything — it will remember our conversation!</p>
                  <p className="text-xs mt-2 text-gray-300">Session: {sessionId.slice(0, 8)}...</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-linear-to-r from-blue-500 to-indigo-500 text-white rounded-br-sm"
                        : "bg-gray-100 text-gray-800 rounded-bl-sm"
                    }`}
                  >
                    {msg.text}
                    {msg.timestamp && (
                      <div className={`text-[10px] mt-1 ${
                        msg.role === "user" ? "text-blue-100" : "text-gray-400"
                      }`}>
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
              {isChatLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
                    {[0, 1, 2].map(i => (
                      <motion.span
                        key={i}
                        animate={{ y: [0, -4, 0] }}
                        transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
                        className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block"
                      />
                    ))}
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="px-4 py-3 border-t border-gray-100 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendChatMessage()}
                placeholder="Ask Arix..."
                className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all"
                disabled={isChatLoading}
              />
              <button
                onClick={sendChatMessage}
                disabled={isChatLoading || !chatInput.trim()}
                className="px-4 py-2 bg-linear-to-r from-blue-500 to-indigo-500 text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:from-blue-600 hover:to-indigo-600 transition-all shadow-md"
              >
                Send
              </button>
            </div>

            {/* Conversation summary */}
            {conversationSummary && (
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
                {conversationSummary.summary}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Button (optional) */}
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="absolute bottom-4 left-4 p-2 bg-white/80 backdrop-blur-sm rounded-full shadow-sm border border-gray-200/50 hover:bg-white transition-all"
        onClick={() => {
          console.log("Settings clicked");
        }}
      >
        <Settings size={18} className="text-gray-600" />
      </motion.button>
    </div>
  );
}