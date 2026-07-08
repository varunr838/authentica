"use client";
/**
 * components/PublisherDashboard.tsx  —  Authentica Phase 4
 * ==========================================================
 * The private publisher UI — local-only, dark, cryptographic aesthetic.
 * Flow: Drag & Drop → Apply Blur & Generate ZKP → Publish to Ledger
 */

import React, { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useChainId, useWriteContract } from "wagmi";
import { parseEther, toHex } from "viem";
import {
  VIDEO_REGISTRY_ABI,
  getContractAddress,
  exportUrl,
  type PipelineStep,
  type JobStatus,
} from "@/utils/web3Config";
import { uploadVideo, triggerProcess, pollStatus } from "@/utils/backendApi";

// ── Step definitions ──────────────────────────────────────────────────────────
const STEPS: { id: PipelineStep; label: string; sub: string }[] = [
  { id: "uploading",   label: "Upload",         sub: "Transferring to local backend"         },
  { id: "processing",  label: "Blur & Quantize", sub: "OpenCV + ONNX PixelationFilter"       },
  { id: "proving",     label: "Generate ZKP",   sub: "EZKL Halo2 proof (this takes a while)" },
  { id: "publishing",  label: "Publish to Ledger", sub: "Signing on-chain tx via MetaMask"   },
  { id: "done",        label: "Verified",        sub: "Immutably anchored on blockchain"      },
];

const STEP_ORDER: PipelineStep[] = [
  "idle", "uploading", "processing", "proving", "publishing", "done",
];

function stepIndex(s: PipelineStep) {
  return STEP_ORDER.indexOf(s);
}

// ── Small components ──────────────────────────────────────────────────────────
function GlowIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex items-center justify-center w-10 h-10">
      <div className="absolute inset-0 rounded-full bg-cyan-500/20 blur-md" />
      <div className="relative text-cyan-400">{children}</div>
    </div>
  );
}

function StatusBadge({ step }: { step: PipelineStep }) {
  const map: Record<PipelineStep, { label: string; cls: string }> = {
    idle:       { label: "Ready",      cls: "bg-slate-700 text-slate-300" },
    uploading:  { label: "Uploading",  cls: "bg-amber-500/20 text-amber-300 animate-pulse" },
    processing: { label: "Processing", cls: "bg-blue-500/20  text-blue-300  animate-pulse" },
    proving:    { label: "Proving",    cls: "bg-violet-500/20 text-violet-300 animate-pulse" },
    publishing: { label: "Publishing", cls: "bg-cyan-500/20  text-cyan-300  animate-pulse" },
    done:       { label: "Complete",   cls: "bg-emerald-500/20 text-emerald-300" },
    error:      { label: "Error",      cls: "bg-red-500/20 text-red-300" },
  };
  const { label, cls } = map[step];
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${cls}`}>
      {step !== "idle" && step !== "done" && step !== "error" && (
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
      )}
      {label}
    </span>
  );
}

// ── Drag-and-drop zone ────────────────────────────────────────────────────────
function DropZone({
  onFile,
  disabled,
}: {
  onFile: (f: File) => void;
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  return (
    <motion.div
      className={`relative rounded-2xl border-2 border-dashed transition-all cursor-pointer
        ${dragging ? "border-cyan-400 bg-cyan-950/30" : "border-slate-600 hover:border-cyan-600 bg-slate-900/50"}
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
      `}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={disabled ? undefined : handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      whileHover={disabled ? {} : { scale: 1.005 }}
      transition={{ duration: 0.15 }}
    >
      {/* Animated corner accents */}
      {["top-3 left-3", "top-3 right-3", "bottom-3 left-3", "bottom-3 right-3"].map((pos, i) => (
        <div key={i} className={`absolute ${pos} w-3 h-3 border-cyan-500/60`}
          style={{
            borderTopWidth:    i < 2 ? 2 : 0,
            borderBottomWidth: i >= 2 ? 2 : 0,
            borderLeftWidth:   i % 2 === 0 ? 2 : 0,
            borderRightWidth:  i % 2 === 1 ? 2 : 0,
          }} />
      ))}

      <div className="flex flex-col items-center justify-center gap-4 p-14 text-center">
        <motion.div
          animate={dragging ? { scale: 1.2, rotate: 5 } : { scale: 1, rotate: 0 }}
          className="text-5xl"
        >
          🎬
        </motion.div>
        <div>
          <p className="text-slate-200 font-medium text-lg">
            {dragging ? "Release to upload" : "Drop raw video here"}
          </p>
          <p className="text-slate-500 text-sm mt-1">
            MP4, MOV, AVI, MKV — click to browse
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        disabled={disabled}
      />
    </motion.div>
  );
}

// ── Pipeline progress timeline ────────────────────────────────────────────────
function PipelineTimeline({ current }: { current: PipelineStep }) {
  const curIdx = stepIndex(current);

  return (
    <div className="space-y-3">
      {STEPS.map((step, i) => {
        const stepIdx  = stepIndex(step.id);
        const isDone   = curIdx > stepIdx;
        const isActive = curIdx === stepIdx;
        const isPending = curIdx < stepIdx;

        return (
          <motion.div
            key={step.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.07 }}
            className={`flex items-start gap-4 p-3.5 rounded-xl transition-all
              ${isActive ? "bg-cyan-950/40 border border-cyan-800/60" : "bg-transparent"}
            `}
          >
            {/* Step indicator */}
            <div className="flex-shrink-0 mt-0.5">
              {isDone ? (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center"
                >
                  <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </motion.div>
              ) : isActive ? (
                <div className="w-7 h-7 rounded-full border border-cyan-500/60 bg-cyan-950/60 flex items-center justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                    className="w-3.5 h-3.5 border-2 border-cyan-400 border-t-transparent rounded-full"
                  />
                </div>
              ) : (
                <div className="w-7 h-7 rounded-full border border-slate-700 bg-slate-900 flex items-center justify-center">
                  <span className="text-slate-600 text-xs font-mono">{i + 1}</span>
                </div>
              )}
            </div>

            {/* Step label */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${
                isDone    ? "text-emerald-300" :
                isActive  ? "text-cyan-200"    :
                            "text-slate-500"
              }`}>{step.label}</p>
              {isActive && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="text-xs text-slate-400 mt-0.5 font-mono"
                >
                  {step.sub}
                </motion.p>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Result card ───────────────────────────────────────────────────────────────
function ResultCard({ status, jobId }: { status: JobStatus; jobId: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="rounded-2xl border border-emerald-800/60 bg-emerald-950/30 p-5 space-y-3"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
          <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <div>
          <p className="text-emerald-300 font-semibold text-sm">Pipeline Complete</p>
          <p className="text-slate-400 text-xs">Proof generated and anchored on-chain</p>
        </div>
      </div>

      <div className="space-y-1.5 font-mono text-xs">
        {[
          ["Video Hash", status.video_hash ?? "—"],
          ["Tx Hash",    status.tx_hash    ?? "Skipped"],
          ["Block",      status.block_number?.toString() ?? "—"],
          ["Gas Used",   status.gas_used?.toString()     ?? "—"],
          ["Frames",     status.frame_count?.toString()  ?? "—"],
        ].map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0">{label}:</span>
            <span className="text-slate-200 truncate">{value}</span>
          </div>
        ))}
      </div>

      <a
        href={exportUrl(jobId)}
        className="inline-flex items-center gap-2 mt-2 px-4 py-2 rounded-lg
          bg-emerald-500/10 border border-emerald-600/40 text-emerald-300
          text-xs font-medium hover:bg-emerald-500/20 transition-colors"
        download
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        Download Export (blurred video + proof.json)
      </a>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function PublisherDashboard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();

  const [file, setFile]         = useState<File | null>(null);
  const [jobId, setJobId]       = useState<string | null>(null);
  const [step, setStep]         = useState<PipelineStep>("idle");
  const [result, setResult]     = useState<JobStatus | null>(null);
  const [errMsg, setErrMsg]     = useState<string | null>(null);
  const [withChain, setWithChain] = useState(true);

  const isRunning = !["idle", "done", "error"].includes(step);

  // ── Poll backend status ────────────────────────────────────────────────────
  const pollUntilDone = useCallback(async (id: string) => {
    const MAX_POLLS = 240;     // 20 min at 5 s intervals
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await pollStatus(id);

      if (s.status === "processing") setStep("processing");
      if (s.status === "publishing") setStep("publishing");

      if (s.status === "done") {
        setResult(s);
        setStep("done");
        return;
      }
      if (s.status === "failed") {
        throw new Error(s.error ?? "Pipeline failed");
      }

      // Heuristic: "processing" covers both blur and proof stages
      // Show "proving" after 30 s in processing state
      if (s.status === "processing" && i >= 6) {
        setStep("proving");
      }
    }
    throw new Error("Timed out waiting for pipeline.");
  }, []);

  // ── Start pipeline ─────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!file) return;
    setErrMsg(null);
    setResult(null);

    try {
      // 1. Upload
      setStep("uploading");
      const { job_id } = await uploadVideo(file);
      setJobId(job_id);

      // 2. Process
      setStep("processing");
      await triggerProcess(job_id, withChain && isConnected);

      // 3. Poll to completion
      await pollUntilDone(job_id);
    } catch (e: unknown) {
      setStep("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  }, [file, isConnected, withChain, pollUntilDone]);

  const handleReset = () => {
    setFile(null);
    setJobId(null);
    setStep("idle");
    setResult(null);
    setErrMsg(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
            <GlowIcon>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </GlowIcon>
            Publisher
            <span className="text-xs font-normal text-slate-500 ml-1 font-mono">LOCAL ONLY</span>
          </h2>
          <p className="text-slate-400 text-sm mt-0.5">
            Apply privacy filter and generate a cryptographic proof of authenticity.
          </p>
        </div>
        <StatusBadge step={step} />
      </div>

      {/* Drop zone (visible when idle or error) */}
      <AnimatePresence mode="wait">
        {(step === "idle" || step === "error") && (
          <motion.div
            key="dropzone"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <DropZone onFile={setFile} disabled={false} />

            {/* Selected file chip */}
            {file && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="mt-3 flex items-center gap-3 p-3 rounded-xl bg-slate-800/60 border border-slate-700"
              >
                <span className="text-2xl">🎥</span>
                <div className="flex-1 min-w-0">
                  <p className="text-slate-200 text-sm font-medium truncate">{file.name}</p>
                  <p className="text-slate-500 text-xs">{(file.size / 1e6).toFixed(2)} MB</p>
                </div>
                <button
                  onClick={() => setFile(null)}
                  className="text-slate-500 hover:text-slate-300 transition-colors"
                >
                  ✕
                </button>
              </motion.div>
            )}

            {/* Options row */}
            <div className="mt-3 flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer group">
                <div
                  onClick={() => setWithChain((v) => !v)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${
                    withChain ? "bg-cyan-600" : "bg-slate-700"
                  }`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    withChain ? "translate-x-4" : "translate-x-0.5"
                  }`} />
                </div>
                <span className="text-slate-400 text-sm group-hover:text-slate-300 transition-colors">
                  Publish to blockchain
                </span>
              </label>
              {withChain && !isConnected && (
                <span className="text-amber-400 text-xs">⚠ Connect wallet first</span>
              )}
            </div>

            {/* Error message */}
            {errMsg && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-3 p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-sm font-mono"
              >
                {errMsg}
              </motion.div>
            )}

            {/* Action button */}
            <motion.button
              onClick={handleStart}
              disabled={!file || isRunning}
              className={`mt-4 w-full py-3.5 rounded-xl font-semibold text-sm transition-all
                ${file
                  ? "bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-lg shadow-cyan-900/40"
                  : "bg-slate-800 text-slate-600 cursor-not-allowed"
                }`}
              whileHover={file ? { scale: 1.01 } : {}}
              whileTap={file ? { scale: 0.99 } : {}}
            >
              {file ? "⚡ Apply Blur & Generate ZKP" : "Select a video to continue"}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pipeline timeline (visible when running or done) */}
      <AnimatePresence>
        {step !== "idle" && step !== "error" && (
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-300 text-sm font-medium">Pipeline Progress</p>
              {result && (
                <button
                  onClick={handleReset}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  ← New video
                </button>
              )}
            </div>
            <PipelineTimeline current={step} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Result card */}
      <AnimatePresence>
        {result && jobId && (
          <ResultCard status={result} jobId={jobId} />
        )}
      </AnimatePresence>
    </div>
  );
}
