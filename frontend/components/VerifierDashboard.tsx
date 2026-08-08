"use client";
/**
 * components/VerifierDashboard.tsx  —  Authentica
 * =================================================
 * Allows anyone to verify a blurred video's authenticity:
 *   1. Drop / select the blurred video file
 *   2. Browser computes its SHA-256 hash locally
 *   3. isVerified(hash) is called on the VideoRegistry contract
 *   4. If found: getRecord(hash) shows full on-chain details
 *
 * No proof.json needed — the video hash IS the lookup key.
 */

import React, { useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePublicClient, useChainId } from "wagmi";
import { VIDEO_REGISTRY_ABI, getContractAddress, type VideoRecord } from "@/utils/web3Config";

// ── Helpers ───────────────────────────────────────────────────────────────────
function short(h: string, n = 6) {
  return `${h.slice(0, n + 2)}…${h.slice(-n)}`;
}
function fmtDate(ts: bigint) {
  return new Date(Number(ts) * 1000).toLocaleString();
}
function fmtBytes(bytes: number) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Compute SHA-256 of an ArrayBuffer, return hex string (no 0x prefix). */
async function sha256hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Stage =
  | { kind: "idle" }
  | { kind: "hashing"; fileName: string; fileSize: number }
  | { kind: "querying"; hash: string; fileName: string; fileSize: number }
  | { kind: "found";   hash: string; record: VideoRecord; fileName: string; fileSize: number }
  | { kind: "notfound"; hash: string; fileName: string; fileSize: number }
  | { kind: "error";  msg: string };

// ── Sub-components ────────────────────────────────────────────────────────────
function Spinner({ size = 4 }: { size?: number }) {
  return (
    <motion.div
      animate={{ rotate: 360 }}
      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
      style={{ width: size * 4, height: size * 4 }}
      className="border-2 border-current border-t-transparent rounded-full flex-shrink-0"
    />
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1.5 text-slate-600 hover:text-slate-300 transition-colors text-xs"
      title="Copy to clipboard"
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function InfoRow({ label, value, mono = true, copyable = false }: {
  label: string; value: string; mono?: boolean; copyable?: boolean;
}) {
  return (
    <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
      <p className="text-slate-500 text-xs mb-0.5">{label}</p>
      <p className={`text-slate-300 text-xs break-all ${mono ? "font-mono" : ""}`}>
        {value}{copyable && <CopyBtn text={value} />}
      </p>
    </div>
  );
}

// ── Drop Zone ─────────────────────────────────────────────────────────────────
function DropZone({ onFile }: { onFile: (f: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <motion.div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      animate={{ borderColor: dragging ? "rgb(139,92,246)" : "rgb(51,65,85)" }}
      className="relative flex flex-col items-center justify-center gap-4 py-14 px-6
                 rounded-2xl border-2 border-dashed cursor-pointer
                 bg-slate-950/40 hover:bg-slate-900/60 transition-colors text-center"
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />

      {/* Icon */}
      <div className={`relative w-16 h-16 rounded-2xl flex items-center justify-center transition-colors
                       ${dragging ? "bg-violet-900/40 border border-violet-600/50" : "bg-slate-800/60 border border-slate-700"}`}>
        <AnimatePresence>
          {dragging && (
            <motion.div
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              className="absolute inset-0 rounded-2xl bg-violet-500/10 blur-md"
            />
          )}
        </AnimatePresence>
        <svg className={`relative w-8 h-8 transition-colors ${dragging ? "text-violet-400" : "text-slate-500"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M15 10l4.553-2.277A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
        </svg>
      </div>

      <div>
        <p className="text-slate-200 font-medium text-sm">
          {dragging ? "Drop to verify" : "Drop blurred video here"}
        </p>
        <p className="text-slate-500 text-xs mt-1">or click to browse · MP4, MOV, AVI, MKV, WebM</p>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-600 font-mono">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        Hashed locally · never uploaded
      </div>
    </motion.div>
  );
}

// ── Result panels ─────────────────────────────────────────────────────────────
function FoundPanel({ record, hash, fileName, fileSize, onReset }: {
  record: VideoRecord; hash: string; fileName: string; fileSize: number; onReset: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* Big success banner */}
      <div className="relative overflow-hidden rounded-2xl border border-emerald-700/40 bg-emerald-950/30 p-5">
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-emerald-500/10 blur-2xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-600/40 flex items-center justify-center">
            <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <p className="text-emerald-300 font-bold text-base">✓ Authenticity Verified</p>
            <p className="text-slate-400 text-sm mt-0.5">
              This video was processed and certified by Authentica&apos;s zkML pipeline.
              The blurring was cryptographically proven on-chain.
            </p>
          </div>
        </div>
      </div>

      {/* File info */}
      <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/40 border border-slate-700/60">
        <div className="text-2xl">🎬</div>
        <div className="min-w-0">
          <p className="text-slate-200 text-sm font-medium truncate">{fileName}</p>
          <p className="text-slate-500 text-xs">{fmtBytes(fileSize)}</p>
        </div>
        <span className="ml-auto flex-shrink-0 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-600/30 text-emerald-400 text-xs font-medium">
          On Ledger
        </span>
      </div>

      {/* On-chain details */}
      <div className="space-y-2">
        <p className="text-xs text-slate-500 font-mono uppercase tracking-wider">On-Chain Record</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <InfoRow label="Block Number"    value={record.blockNumber.toString()} />
          <InfoRow label="Registered At"   value={fmtDate(record.timestamp)} mono={false} />
          <InfoRow label="Publisher"       value={record.publisher} copyable />
          <InfoRow label="Circuit Outputs" value={`${record.instances.length} public instances`} mono={false} />
        </div>
        <InfoRow label="Video Hash (SHA-256)" value={`0x${hash}`} copyable />
        <InfoRow label="Proof Digest (keccak256 of proof bytes)" value={record.proofDigest} copyable />
      </div>

      <button
        onClick={onReset}
        className="w-full py-2.5 rounded-xl border border-slate-700 text-slate-400 text-sm
                   hover:border-slate-600 hover:text-slate-200 transition-all"
      >
        ← Verify another video
      </button>
    </motion.div>
  );
}

function NotFoundPanel({ hash, fileName, fileSize, onReset }: {
  hash: string; fileName: string; fileSize: number; onReset: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl border border-red-800/40 bg-red-950/20 p-5">
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-red-500/10 blur-2xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-red-500/10 border border-red-700/40 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.924-.833-2.464 0L4.35 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div>
            <p className="text-red-300 font-bold text-base">Not Found on Blockchain</p>
            <p className="text-slate-400 text-sm mt-0.5">
              No record exists for this video&apos;s hash. It was either not processed by Authentica,
              or the file has been modified since processing.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/40 border border-slate-700/60">
        <div className="text-2xl">🎬</div>
        <div className="min-w-0">
          <p className="text-slate-200 text-sm font-medium truncate">{fileName}</p>
          <p className="text-slate-500 text-xs">{fmtBytes(fileSize)}</p>
        </div>
        <span className="ml-auto flex-shrink-0 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-700/30 text-red-400 text-xs font-medium">
          Unknown
        </span>
      </div>

      <InfoRow label="Computed SHA-256 Hash (not in registry)" value={`0x${hash}`} copyable />

      <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-700/50 text-xs text-slate-500 space-y-1">
        <p className="text-slate-400 font-medium">Why might this happen?</p>
        <p>• The video was not processed by the Authentica pipeline</p>
        <p>• The video file was modified or re-encoded after processing</p>
        <p>• The publisher used a different blockchain network</p>
      </div>

      <button onClick={onReset} className="w-full py-2.5 rounded-xl border border-slate-700 text-slate-400 text-sm hover:border-slate-600 hover:text-slate-200 transition-all">
        ← Try another video
      </button>
    </motion.div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function VerifierDashboard() {
  const publicClient = usePublicClient();
  const chainId      = useChainId();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const handleFile = useCallback(async (file: File) => {
    setStage({ kind: "hashing", fileName: file.name, fileSize: file.size });

    let hash: string;
    try {
      const buf = await file.arrayBuffer();
      hash = await sha256hex(buf);
    } catch {
      setStage({ kind: "error", msg: "Failed to compute SHA-256 of the file." });
      return;
    }

    setStage({ kind: "querying", hash, fileName: file.name, fileSize: file.size });

    if (!publicClient) {
      setStage({ kind: "error", msg: "No blockchain connection. Connect your wallet." });
      return;
    }

    try {
      const address  = getContractAddress(chainId, "VideoRegistry");
      const hashHex  = `0x${hash}` as `0x${string}`;

      const isVerified = await publicClient.readContract({
        address,
        abi:          VIDEO_REGISTRY_ABI,
        functionName: "isVerified",
        args:         [hashHex],
      }) as boolean;

      if (!isVerified) {
        setStage({ kind: "notfound", hash, fileName: file.name, fileSize: file.size });
        return;
      }

      const record = await publicClient.readContract({
        address,
        abi:          VIDEO_REGISTRY_ABI,
        functionName: "getRecord",
        args:         [hashHex],
      }) as VideoRecord;

      setStage({ kind: "found", hash, record, fileName: file.name, fileSize: file.size });
    } catch (e: unknown) {
      setStage({ kind: "error", msg: e instanceof Error ? e.message : "Blockchain query failed." });
    }
  }, [publicClient, chainId]);

  const reset = () => setStage({ kind: "idle" });

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
          <div className="relative w-9 h-9 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-emerald-500/20 blur-md" />
            <svg className="relative w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          Verify Authenticity
          <span className="text-xs font-normal text-slate-500 font-mono">OPEN LEDGER</span>
        </h2>
        <p className="text-slate-400 text-sm mt-0.5">
          Drop any blurred video to check if it was certified by Authentica&apos;s zkML pipeline.
        </p>
      </div>

      {/* Explainer pills */}
      {stage.kind === "idle" && (
        <div className="flex flex-wrap gap-2">
          {[
            { icon: "🔒", text: "File never leaves your device" },
            { icon: "⛓",  text: "Proof verified on-chain" },
            { icon: "⚡",  text: "Instant SHA-256 lookup" },
          ].map((p) => (
            <span key={p.text} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/60 border border-slate-700/60 text-xs text-slate-400">
              {p.icon} {p.text}
            </span>
          ))}
        </div>
      )}

      {/* State machine */}
      <AnimatePresence mode="wait">
        {/* Idle — show drop zone */}
        {stage.kind === "idle" && (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <DropZone onFile={handleFile} />
          </motion.div>
        )}

        {/* Hashing */}
        {stage.kind === "hashing" && (
          <motion.div key="hashing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center gap-4 py-16 rounded-2xl border border-slate-800 bg-slate-950/40">
            <Spinner size={8} />
            <div className="text-center">
              <p className="text-slate-200 font-medium text-sm">Computing SHA-256…</p>
              <p className="text-slate-500 text-xs mt-1 font-mono truncate max-w-xs">{stage.fileName}</p>
              <p className="text-slate-600 text-xs mt-0.5">{fmtBytes(stage.fileSize)}</p>
            </div>
            <p className="text-slate-600 text-xs">Processing locally — nothing is uploaded</p>
          </motion.div>
        )}

        {/* Querying */}
        {stage.kind === "querying" && (
          <motion.div key="querying" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center gap-4 py-16 rounded-2xl border border-slate-800 bg-slate-950/40">
            <Spinner size={8} />
            <div className="text-center space-y-1">
              <p className="text-slate-200 font-medium text-sm">Querying blockchain…</p>
              <p className="text-slate-500 text-xs font-mono">isVerified({short(`0x${stage.hash}`, 8)})</p>
            </div>
          </motion.div>
        )}

        {/* Found */}
        {stage.kind === "found" && (
          <motion.div key="found" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <FoundPanel
              record={stage.record}
              hash={stage.hash}
              fileName={stage.fileName}
              fileSize={stage.fileSize}
              onReset={reset}
            />
          </motion.div>
        )}

        {/* Not found */}
        {stage.kind === "notfound" && (
          <motion.div key="notfound" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <NotFoundPanel
              hash={stage.hash}
              fileName={stage.fileName}
              fileSize={stage.fileSize}
              onReset={reset}
            />
          </motion.div>
        )}

        {/* Error */}
        {stage.kind === "error" && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="space-y-4">
            <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-300 text-sm font-mono">
              ⚠ {stage.msg}
            </div>
            <button onClick={reset} className="w-full py-2.5 rounded-xl border border-slate-700 text-slate-400 text-sm hover:border-slate-600 hover:text-slate-200 transition-all">
              ← Try again
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
