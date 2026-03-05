"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

interface HoloFaceProps {
    micVolume: number[];
    isLive: boolean;
}

export default function HoloFace({ micVolume }: HoloFaceProps) {
    const mountRef = useRef<HTMLDivElement>(null);
    const micVolumeRef = useRef<number[]>(micVolume);
    useEffect(() => { micVolumeRef.current = micVolume; }, [micVolume]);

    useEffect(() => {
        if (!mountRef.current) return;
        const el = mountRef.current;
        const W = el.clientWidth || window.innerWidth;
        const H = el.clientHeight || window.innerHeight;

        // ─── Renderer ───────────────────────────────────────────────────────────
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(W, H);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        el.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
        camera.position.z = 5.5;

        // ─── Draw face on offscreen canvas ──────────────────────────────────────
        const FW = 480, FH = 600;
        const off = document.createElement("canvas");
        off.width = FW; off.height = FH;
        const ctx = off.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, FW, FH);

        const cx = FW / 2, cy = FH / 2 - 20;

        // HEAD OVAL  ─────────────
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, 155, 185, 0, 0, Math.PI * 2);
        const hg = ctx.createRadialGradient(cx, cy - 20, 40, cx, cy, 165);
        hg.addColorStop(0, "rgba(160,210,255,0.90)");
        hg.addColorStop(0.45, "rgba(100,170,255,0.65)");
        hg.addColorStop(0.82, "rgba(50,130,240,0.30)");
        hg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = hg;
        ctx.fill();
        ctx.restore();

        // FOREHEAD HIGHLIGHT ─────
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy - 120, 70, 45, 0, 0, Math.PI * 2);
        const fg = ctx.createRadialGradient(cx, cy - 120, 5, cx, cy - 120, 70);
        fg.addColorStop(0, "rgba(220,240,255,0.70)");
        fg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = fg;
        ctx.fill();
        ctx.restore();

        // EYES ───────────────────
        const drawEye = (ex: number, ey: number) => {
            // Iris glow
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(ex, ey, 35, 20, 0, 0, Math.PI * 2);
            const eg = ctx.createRadialGradient(ex, ey, 3, ex, ey, 35);
            eg.addColorStop(0, "rgba(255,255,255,1.0)");
            eg.addColorStop(0.25, "rgba(200,235,255,0.95)");
            eg.addColorStop(0.6, "rgba(80,170,255,0.55)");
            eg.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = eg;
            ctx.fill();
            ctx.restore();
            // Upper lid line
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(ex - 35, ey + 2);
            ctx.quadraticCurveTo(ex, ey - 22, ex + 35, ey + 2);
            ctx.strokeStyle = "rgba(180,230,255,0.80)";
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.restore();
            // Lower lid
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(ex - 35, ey + 2);
            ctx.quadraticCurveTo(ex, ey + 16, ex + 35, ey + 2);
            ctx.strokeStyle = "rgba(120,190,255,0.45)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
        };
        drawEye(cx - 52, cy - 52);
        drawEye(cx + 52, cy - 52);

        // EYEBROWS ───────────────
        const drawBrow = (bx: number, by: number, sign: number) => {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(bx - sign * 42, by + 5);
            ctx.quadraticCurveTo(bx, by - 12, bx + sign * 42, by + 5);
            ctx.strokeStyle = "rgba(170,220,255,0.70)";
            ctx.lineWidth = 4;
            ctx.lineCap = "round";
            ctx.stroke();
            ctx.restore();
        };
        drawBrow(cx - 52, cy - 88, 1);
        drawBrow(cx + 52, cy - 88, -1);

        // NOSE ───────────────────
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy - 35);
        ctx.bezierCurveTo(cx - 14, cy - 5, cx - 24, cy + 30, cx - 18, cy + 48);
        ctx.bezierCurveTo(cx - 10, cy + 62, cx + 10, cy + 62, cx + 18, cy + 48);
        ctx.bezierCurveTo(cx + 24, cy + 30, cx + 14, cy - 5, cx, cy - 35);
        const ng = ctx.createLinearGradient(cx, cy - 35, cx, cy + 62);
        ng.addColorStop(0, "rgba(190,220,255,0.55)");
        ng.addColorStop(0.5, "rgba(140,200,255,0.60)");
        ng.addColorStop(1, "rgba(80,160,255,0.30)");
        ctx.fillStyle = ng;
        ctx.fill();
        ctx.restore();
        // Nose tip
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy + 55, 16, 11, 0, 0, Math.PI * 2);
        const ntg = ctx.createRadialGradient(cx, cy + 55, 1, cx, cy + 55, 16);
        ntg.addColorStop(0, "rgba(240,250,255,0.90)");
        ntg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = ntg;
        ctx.fill();
        ctx.restore();

        // MOUTH / LIPS ───────────
        const mY = cy + 105;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx - 48, mY);
        ctx.bezierCurveTo(cx - 26, mY - 14, cx - 8, mY - 16, cx, mY - 9);
        ctx.bezierCurveTo(cx + 8, mY - 16, cx + 26, mY - 14, cx + 48, mY);
        ctx.bezierCurveTo(cx + 30, mY + 18, cx - 30, mY + 18, cx - 48, mY);
        const mg = ctx.createRadialGradient(cx, mY + 4, 3, cx, mY + 4, 50);
        mg.addColorStop(0, "rgba(230,245,255,0.95)");
        mg.addColorStop(0.45, "rgba(150,210,255,0.75)");
        mg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = mg;
        ctx.fill();
        ctx.restore();

        // CHEEKBONES ─────────────
        const drawCheek = (chx: number) => {
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(chx, cy + 14, 52, 30, (chx < cx ? -0.3 : 0.3), 0, Math.PI * 2);
            const cg = ctx.createRadialGradient(chx, cy + 14, 3, chx, cy + 14, 52);
            cg.addColorStop(0, "rgba(140,200,255,0.50)");
            cg.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = cg;
            ctx.fill();
            ctx.restore();
        };
        drawCheek(cx - 112);
        drawCheek(cx + 112);

        // CHIN ───────────────────
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy + 160, 38, 26, 0, 0, Math.PI * 2);
        const chg = ctx.createRadialGradient(cx, cy + 160, 3, cx, cy + 160, 38);
        chg.addColorStop(0, "rgba(170,215,255,0.65)");
        chg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = chg;
        ctx.fill();
        ctx.restore();

        // NECK ───────────────────
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy + 210, 36, 55, 0, 0, Math.PI * 2);
        const neckG = ctx.createRadialGradient(cx, cy + 210, 5, cx, cy + 210, 36);
        neckG.addColorStop(0, "rgba(130,190,255,0.55)");
        neckG.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = neckG;
        ctx.fill();
        ctx.restore();

        // ─── Sample Particle Positions from Canvas ───────────────────────────────
        const imgData = ctx.getImageData(0, 0, FW, FH).data;
        const basePos: number[] = [];

        for (let y = 0; y < FH; y++) {
            for (let x = 0; x < FW; x++) {
                const idx = (y * FW + x) * 4;
                const brightness = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
                if (brightness < 8) continue;
                // Sample probability ∝ brightness
                if (Math.random() > brightness / 255 * 0.22) continue;
                // Normalize to world coords
                basePos.push(
                    (x - FW / 2) / (FW / 2) * 3.2,   // x: -3.2 to +3.2
                    -(y - FH / 2) / (FH / 2) * 4.0,  // y: -4.0 to +4.0
                    (Math.random() - 0.5) * 0.5        // z: depth
                );
            }
        }

        const N = basePos.length / 3;
        const origPos = new Float32Array(basePos);
        const currPos = new Float32Array(basePos);

        // ─── Face Particles ──────────────────────────────────────────────────────
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(currPos, 3));

        const mat = new THREE.PointsMaterial({
            color: new THREE.Color(0x38c8ff),
            size: 0.028,
            transparent: true,
            opacity: 0.88,
            sizeAttenuation: true,
        });
        const points = new THREE.Points(geo, mat);
        scene.add(points);

        // ─── Ambient Background Particles ────────────────────────────────────────
        const ambN = 800;
        const ambPos2 = new Float32Array(ambN * 3);
        for (let i = 0; i < ambN; i++) {
            ambPos2[i * 3] = (Math.random() - 0.5) * 16;
            ambPos2[i * 3 + 1] = (Math.random() - 0.5) * 12;
            ambPos2[i * 3 + 2] = (Math.random() - 0.5) * 8 - 3;
        }
        const ambGeo = new THREE.BufferGeometry();
        ambGeo.setAttribute("position", new THREE.BufferAttribute(ambPos2, 3));
        const ambMat = new THREE.PointsMaterial({
            color: new THREE.Color(0x1a7aaa),
            size: 0.016,
            transparent: true,
            opacity: 0.35,
        });
        scene.add(new THREE.Points(ambGeo, ambMat));

        // ─── Data stream rings ────────────────────────────────────────────────────
        const buildRing = (radius: number, y: number, opacity: number) => {
            const rGeo = new THREE.TorusGeometry(radius, 0.006, 6, 80);
            const rMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(0x20a8d8),
                transparent: true, opacity,
            });
            const ring = new THREE.Mesh(rGeo, rMat);
            ring.rotation.x = Math.PI / 2;
            ring.position.y = y;
            scene.add(ring);
            return ring;
        };
        const ring1 = buildRing(1.8, -2.4, 0.45);
        const ring2 = buildRing(1.3, -2.6, 0.30);
        const ring3 = buildRing(0.8, -2.8, 0.20);

        // ─── Animation Loop ───────────────────────────────────────────────────────
        let animId = 0;
        let time = 0;

        const animate = () => {
            animId = requestAnimationFrame(animate);
            time += 0.014;

            // Mic volume → speaking level
            const vol = micVolumeRef.current;
            const avgV = vol.reduce((a, b) => a + b, 0) / Math.max(vol.length, 1);
            const spk = Math.min(avgV * 3.5, 1.0);

            // Update face particle positions
            for (let i = 0; i < N; i++) {
                const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
                const ox = origPos[ix], oy = origPos[iy];

                // Idle micro-drift
                const driftX = Math.sin(time * 0.6 + i * 0.008) * 0.004;
                const driftY = Math.cos(time * 0.45 + i * 0.011) * 0.004;

                // Speaking scatter (push outward from face centre)
                const dist = Math.sqrt(ox * ox + oy * oy);
                const scaleS = spk * 0.18 * (dist / 3.0 + 0.3);
                const scatterX = ox * scaleS;
                const scatterY = oy * scaleS;
                const scatterZ = (Math.random() - 0.5) * spk * 0.15;

                currPos[ix] = ox + driftX + scatterX;
                currPos[iy] = oy + driftY + scatterY;
                currPos[iz] = origPos[iz] + scatterZ;
            }
            (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

            // Particle colour / size pulse
            mat.color.setHSL(0.55 - spk * 0.04, 1.0, 0.55 + spk * 0.18);
            mat.size = 0.024 + spk * 0.016;

            // Subtle head sway
            points.rotation.y = Math.sin(time * 0.28) * 0.07;
            points.rotation.x = Math.sin(time * 0.18) * 0.025 - 0.04;

            // Ring rotations
            ring1.rotation.z = time * 0.5;
            ring2.rotation.z = -time * 0.7;
            ring3.rotation.z = time * 1.1;

            renderer.render(scene, camera);
        };
        animate();

        // Resize
        const onResize = () => {
            const w = el.clientWidth, h = el.clientHeight;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        };
        window.addEventListener("resize", onResize);

        return () => {
            window.removeEventListener("resize", onResize);
            cancelAnimationFrame(animId);
            renderer.dispose();
            if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
        };
    }, []);

    return (
        <div
            ref={mountRef}
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 15,
                background:
                    "radial-gradient(ellipse at 50% 35%, #010f22 0%, #000a18 55%, #00030d 100%)",
            }}
        >
            {/* ── HUD corner brackets ───────────────────────────────────────── */}
            {(["tl", "tr", "bl", "br"] as const).map((pos) => (
                <div
                    key={pos}
                    style={{
                        position: "absolute",
                        width: 24, height: 24,
                        top: pos.startsWith("t") ? 18 : undefined,
                        bottom: pos.startsWith("b") ? 18 : undefined,
                        left: pos.endsWith("l") ? 18 : undefined,
                        right: pos.endsWith("r") ? 18 : undefined,
                        borderTop: pos.startsWith("t") ? "2px solid rgba(56,200,255,0.6)" : undefined,
                        borderBottom: pos.startsWith("b") ? "2px solid rgba(56,200,255,0.6)" : undefined,
                        borderLeft: pos.endsWith("l") ? "2px solid rgba(56,200,255,0.6)" : undefined,
                        borderRight: pos.endsWith("r") ? "2px solid rgba(56,200,255,0.6)" : undefined,
                        zIndex: 20,
                    }}
                />
            ))}

            {/* ── Top status bar ────────────────────────────────────────────── */}
            <div style={{
                position: "absolute", top: 20, left: 0, right: 0,
                display: "flex", justifyContent: "center",
                zIndex: 20, pointerEvents: "none",
            }}>
                <span style={{
                    fontSize: 11, fontFamily: "monospace",
                    letterSpacing: 5, color: "rgba(56,200,255,0.65)",
                    textTransform: "uppercase",
                }}>
                    ◉ ARIX · NEURAL SYNC · ACTIVE
                </span>
            </div>

            {/* ── Bottom HUD info ───────────────────────────────────────────── */}
            <div style={{
                position: "absolute", bottom: 110, left: 24, right: 24,
                display: "flex", justifyContent: "space-between",
                zIndex: 20, pointerEvents: "none",
            }}>
                <span style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(56,200,255,0.45)", letterSpacing: 2 }}>
                    PARTICLE · MESH · v2.0
                </span>
                <span style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(155,125,255,0.45)", letterSpacing: 2 }}>
                    GEMINI · LIVE · API
                </span>
            </div>
        </div>
    );
}
