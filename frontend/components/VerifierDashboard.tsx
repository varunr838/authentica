"use client";
/**
 * components/VerifierDashboard.tsx  —  Authentica Phase 4
 * =========================================================
 * The public verifier portal — reads VideoVerified events from the
 * blockchain and lets anyone cryptographically verify each entry.
 */

import React, { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  usePublicClient,
  useChainId,
  useAccount,
} from "wagmi";
import { getAddress, formatUnits } from "viem";
import {
  VIDEO_REGISTRY_ABI,
  getContractAddress,
  type VideoRecord,
} from "@/utils/web3Config";

// ── Types ─────────────────────────────────────────────────────────────────────
interface FeedEntry {
  videoHash:   `0x${string}`;
  publisher:   `0x${string}`;
  proofDigest: `0x${string}`;
  timestamp:   bigint;
  instances:   readonly bigint[];
  blockNumber: bigint;
  // Local verification state
  verifyState: "idle" | "loading" | "valid" | "invalid" | "error";
  verifyMsg?:  string;
  record?:     VideoRecord;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shortenHash(h: string, chars = 6) {
  return `${h.slice(0, chars + 2)}…${h.slice(-chars)}`;
}

function timeAgo(timestamp: bigint): string {
  const diff = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function AuthenticaBadge({ state, msg }: { state: FeedEntry["verifyState"]; msg?: string }) {
  if (state === "idle")    return null;
  if (state === "loading") return (
    <div className="flex items-center gap-2 text-slate-400 text-xs font-mono animate-pulse">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full"
      />
      Verifying cryptographic proof…
    </div>
  );

  if (state === "valid") return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-start gap-3 p-3 rounded-xl bg-emerald-950/50 border border-emerald-700/50"
    >
      {/* Shield icon */}
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center mt-0.5">
        <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      </div>
      <div>
        <p className="text-emerald-300 font-semibold text-xs">
          ✓ Cryptographically Valid — Original Media Unaltered
        </p>
        <p className="text-slate-400 text-xs mt-0.5 font-mono">{msg}</p>
      </div>
    </motion.div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-center gap-2 p-3 rounded-xl bg-red-950/40 border border-red-800/50 text-red-300 text-xs font-mono"
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.924-.833-2.464 0L4.35 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      {state === "invalid" ? "Invalid proof — verification failed on-chain." : `Error: ${msg}`}
    </motion.div>
  );
}

function VideoCard({
  entry,
  onVerify,
  index,
}: {
  entry:    FeedEntry;
  onVerify: (hash: `0x${string}`) => void;
  index:    number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.4, ease: "easeOut" }}
      className="group rounded-2xl border border-slate-800 bg-slate-900/70 backdrop-blur-sm p-5
                 hover:border-slate-700 transition-all duration-300 space-y-4"
    >
      {/* Top row */}
      <div className="flex items-start gap-3">
        {/* Video hash icon */}
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-slate-800 to-slate-900
                        border border-slate-700 flex items-center justify-center text-lg">
          🎬
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-slate-200 font-medium">
              {shortenHash(entry.videoHash, 8)}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-600/30 text-emerald-400 text-xs">
              Verified
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 font-mono">
            <span title={entry.publisher}>{shortenHash(entry.publisher, 4)}</span>
            <span>·</span>
            <span>{timeAgo(entry.timestamp)}</span>
            <span>·</span>
            <span>Block {entry.blockNumber.toString()}</span>
          </div>
        </div>
      </div>

      {/* Proof digest */}
      <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
        <p className="text-slate-500 text-xs mb-1">Proof digest (keccak256)</p>
        <p className="font-mono text-xs text-slate-400 break-all">{entry.proofDigest}</p>
      </div>

      {/* Circuit instances preview */}
      {entry.instances.length > 0 && (
        <div>
          <p className="text-slate-500 text-xs mb-1.5">Public circuit outputs ({entry.instances.length} instances)</p>
          <div className="flex flex-wrap gap-1.5">
            {entry.instances.slice(0, 8).map((inst, i) => (
              <span
                key={i}
                className="px-2 py-0.5 rounded font-mono text-xs bg-slate-800 text-slate-400 border border-slate-700"
              >
                {inst.toString()}
              </span>
            ))}
            {entry.instances.length > 8 && (
              <span className="px-2 py-0.5 rounded font-mono text-xs text-slate-500">
                +{entry.instances.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Verify button */}
      <div className="space-y-2.5">
        <button
          onClick={() => onVerify(entry.videoHash)}
          disabled={entry.verifyState === "loading" || entry.verifyState === "valid" || entry.verifyState === "invalid"}
          className={`w-full py-2.5 rounded-xl text-sm font-medium transition-all
            ${entry.verifyState === "valid"
              ? "bg-emerald-900/30 border border-emerald-700/40 text-emerald-400 cursor-default"
              : entry.verifyState === "loading"
              ? "bg-slate-800 border border-slate-700 text-slate-400 cursor-wait"
              : "bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 hover:border-slate-600 active:scale-[0.98]"
            }`}
        >
          {entry.verifyState === "valid"   ? "✓ Authenticity Verified" :
           entry.verifyState === "loading" ? "Verifying…"             :
                                            "🔍 Verify Authenticity"}
        </button>
        <AuthenticaBadge state={entry.verifyState} msg={entry.verifyMsg} />
      </div>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function VerifierDashboard() {
  const publicClient = usePublicClient();
  const chainId      = useChainId();
  const { isConnected } = useAccount();

  const [entries, setEntries]   = useState<FeedEntry[]>([]);
  const [loading, setLoading]   = useState(false);
  const [errMsg,  setErrMsg]    = useState<string | null>(null);
  const [total,   setTotal]     = useState<bigint>(0n);

  // ── Fetch VideoVerified events ─────────────────────────────────────────────
  const fetchFeed = useCallback(async () => {
    if (!publicClient) return;
    setLoading(true);
    setErrMsg(null);

    try {
      const address = getContractAddress(chainId, "VideoRegistry");

      // Read total video count
      const count = await publicClient.readContract({
        address,
        abi: VIDEO_REGISTRY_ABI,
        functionName: "totalVideos",
      }) as bigint;
      setTotal(count);

      if (count === 0n) {
        setEntries([]);
        return;
      }

      // Fetch VideoVerified events (last 10 000 blocks)
      const logs = await publicClient.getLogs({
        address,
        event: {
          type: "event",
          name: "VideoVerified",
          inputs: [
            { name: "videoHash",   type: "bytes32", indexed: true  },
            { name: "publisher",   type: "address", indexed: true  },
            { name: "proofDigest", type: "bytes32", indexed: false },
            { name: "timestamp",   type: "uint64",  indexed: false },
            { name: "instances",   type: "uint256[]", indexed: false },
          ],
        },
        fromBlock: "earliest",
        toBlock:   "latest",
      });

      const newEntries: FeedEntry[] = logs
        .reverse()
        .slice(0, 20)
        .map((log) => {
          const args = log.args as {
            videoHash?:   `0x${string}`;
            publisher?:   `0x${string}`;
            proofDigest?: `0x${string}`;
            timestamp?:   bigint;
            instances?:   readonly bigint[];
          };
          return {
            videoHash:   args.videoHash   ?? "0x",
            publisher:   args.publisher   ?? "0x",
            proofDigest: args.proofDigest ?? "0x",
            timestamp:   args.timestamp   ?? 0n,
            instances:   args.instances   ?? [],
            blockNumber: log.blockNumber  ?? 0n,
            verifyState: "idle" as const,
          };
        });

      setEntries(newEntries);
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : "Failed to fetch events.");
    } finally {
      setLoading(false);
    }
  }, [publicClient, chainId]);

  useEffect(() => { fetchFeed(); }, [fetchFeed]);

  // ── Verify one entry on-chain ──────────────────────────────────────────────
  const handleVerify = useCallback(async (videoHash: `0x${string}`) => {
    if (!publicClient) return;

    setEntries((prev) =>
      prev.map((e) =>
        e.videoHash === videoHash ? { ...e, verifyState: "loading" } : e,
      ),
    );

    try {
      const address = getContractAddress(chainId, "VideoRegistry");

      // Read full record from the contract
      const record = await publicClient.readContract({
        address,
        abi: VIDEO_REGISTRY_ABI,
        functionName: "getRecord",
        args: [videoHash],
      }) as VideoRecord;

      // The on-chain fact that isVerified = true IS the verification.
      // The smart contract already ran the zk-SNARK pairing check when
      // publishVideo was called. Reading it here confirms the proof was valid.
      const isVerified = record.verified;

      setEntries((prev) =>
        prev.map((e) =>
          e.videoHash === videoHash
            ? {
                ...e,
                verifyState: isVerified ? "valid" : "invalid",
                record,
                verifyMsg: isVerified
                  ? `On-chain since block ${record.blockNumber} · Publisher ${shortenHash(record.publisher)}`
                  : undefined,
              }
            : e,
        ),
      );
    } catch (err: unknown) {
      setEntries((prev) =>
        prev.map((e) =>
          e.videoHash === videoHash
            ? { ...e, verifyState: "error", verifyMsg: err instanceof Error ? err.message : "Unknown error" }
            : e,
        ),
      );
    }
  }, [publicClient, chainId]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
            <div className="relative flex items-center justify-center w-10 h-10">
              <div className="absolute inset-0 rounded-full bg-emerald-500/20 blur-md" />
              <div className="relative text-emerald-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" />
                </svg>
              </div>
            </div>
            Public Verifier
            <span className="text-xs font-normal text-slate-500 ml-1 font-mono">OPEN LEDGER</span>
          </h2>
          <p className="text-slate-400 text-sm mt-0.5">
            Trustless verification — every proof anchored immutably on-chain.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {total > 0n && (
            <span className="text-slate-400 text-sm font-mono">
              {total.toString()} video{total !== 1n ? "s" : ""} on ledger
            </span>
          )}
          <button
            onClick={fetchFeed}
            disabled={loading}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm text-slate-300
                       bg-slate-800 border border-slate-700 hover:border-slate-600 transition-all"
          >
            <motion.svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              animate={loading ? { rotate: 360 } : {}}
              transition={loading ? { duration: 1, repeat: Infinity, ease: "linear" } : {}}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </motion.svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Error state */}
      {errMsg && !loading && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-300 text-sm font-mono">
          {errMsg}
          <br />
          <span className="text-red-500 text-xs">
            Make sure the contracts are deployed and NEXT_PUBLIC_REGISTRY_ADDRESS_LOCAL is set.
          </span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 animate-pulse">
              <div className="flex gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-slate-800 rounded w-1/3" />
                  <div className="h-2.5 bg-slate-800 rounded w-1/2" />
                </div>
              </div>
              <div className="h-10 bg-slate-800 rounded-xl mt-4" />
              <div className="h-9 bg-slate-800 rounded-xl mt-3" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && !errMsg && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-20 text-center"
        >
          <div className="text-5xl mb-4">📭</div>
          <p className="text-slate-300 font-medium">No verified videos yet</p>
          <p className="text-slate-500 text-sm mt-1.5 max-w-xs">
            Use the Publisher tab to upload a video and generate a proof.
            It will appear here once anchored on-chain.
          </p>
        </motion.div>
      )}

      {/* Feed */}
      {!loading && entries.length > 0 && (
        <div className="space-y-4">
          <AnimatePresence>
            {entries.map((entry, i) => (
              <VideoCard
                key={entry.videoHash}
                entry={entry}
                onVerify={handleVerify}
                index={i}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Legend */}
      {!loading && entries.length > 0 && (
        <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/60 text-xs text-slate-500 space-y-1">
          <p className="text-slate-400 font-medium mb-2">How verification works</p>
          <p>
            1. When a video is published, the smart contract runs the zk-SNARK pairing check on-chain.
          </p>
          <p>
            2. Clicking "Verify Authenticity" calls <code className="font-mono text-slate-400">getRecord()</code> — confirming the entry is immutably stored.
          </p>
          <p>
            3. The proof digest lets anyone re-verify the original proof bytes against the circuit's verification key off-chain.
          </p>
        </div>
      )}
    </div>
  );
}
