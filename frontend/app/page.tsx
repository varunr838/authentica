"use client";
/**
 * app/page.tsx  —  Authentica Phase 4 — Main Dashboard
 * ======================================================
 * Full-page layout containing the Publisher and Verifier tabs.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import dynamic from "next/dynamic";
import WalletButton from "@/components/WalletButton";

// Lazy-load heavy components
const PublisherDashboard = dynamic(() => import("@/components/PublisherDashboard"), { ssr: false });
const VerifierDashboard  = dynamic(() => import("@/components/VerifierDashboard"),  { ssr: false });

type Tab = "publisher" | "verifier";

// ── Header ────────────────────────────────────────────────────────────────────
function Header({ activeTab, setTab }: { activeTab: Tab; setTab: (t: Tab) => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 backdrop-blur-xl bg-[#030712]/90">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-xl bg-cyan-500/20 blur-md" />
              <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-700
                              flex items-center justify-center text-lg shadow-lg">
                🔐
              </div>
            </div>
            <div>
              <span className="font-bold text-white text-lg tracking-tight">Authentica</span>
              <p className="text-slate-500 text-xs -mt-0.5 font-mono">zkML Media Protocol</p>
            </div>
          </div>

          {/* Tabs */}
          <nav className="hidden sm:flex items-center gap-1 p-1 rounded-xl bg-slate-900/80 border border-slate-800">
            {(["publisher", "verifier"] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setTab(tab)}
                className={`relative px-4 py-1.5 rounded-lg text-sm font-medium transition-all capitalize ${
                  activeTab === tab
                    ? "text-white tab-active border border-cyan-800/40"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {activeTab === tab && (
                  <motion.div
                    layoutId="tab-indicator"
                    className="absolute inset-0 rounded-lg bg-gradient-to-r from-cyan-950/60 to-blue-950/60"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  {tab === "publisher" ? "🔒" : "🌐"}
                  {tab}
                </span>
              </button>
            ))}
          </nav>

          {/* Wallet */}
          <WalletButton />
        </div>

        {/* Mobile tabs */}
        <div className="flex sm:hidden gap-1 pb-3 pt-1">
          {(["publisher", "verifier"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setTab(tab)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium capitalize transition-all ${
                activeTab === tab
                  ? "bg-cyan-950/50 border border-cyan-800/40 text-cyan-300"
                  : "text-slate-400 border border-transparent"
              }`}
            >
              {tab === "publisher" ? "🔒 Publish" : "🌐 Verify"}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

// ── Hero banner ───────────────────────────────────────────────────────────────
function HeroBanner() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-800/60 bg-slate-900/40 p-8 mb-8">
      {/* Grid background */}
      <div className="absolute inset-0 grid-bg opacity-60" />
      {/* Glow blobs */}
      <div className="absolute -top-20 -left-20 w-64 h-64 rounded-full bg-cyan-500/5 blur-3xl" />
      <div className="absolute -bottom-20 -right-20 w-64 h-64 rounded-full bg-violet-500/5 blur-3xl" />

      <div className="relative">
        <div className="flex items-center gap-2 mb-3">
          <span className="px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-600/30 text-cyan-400 text-xs font-mono">
            Phase 4 — UI
          </span>
          <span className="px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-600/30 text-violet-400 text-xs font-mono">
            zk-SNARKs + Blockchain
          </span>
        </div>

        <h1 className="text-3xl font-bold text-white mb-2 leading-tight">
          Prove it&apos;s real.{" "}
          <span className="gradient-text">Cryptographically.</span>
        </h1>
        <p className="text-slate-400 max-w-xl text-sm leading-relaxed">
          A zero-knowledge proof pipeline that verifies a privacy filter was applied correctly
          to video footage — without ever revealing the original content or model weights.
          The proof is anchored immutably on Ethereum.
        </p>

        {/* Stats row */}
        <div className="flex flex-wrap gap-6 mt-6">
          {[
            { label: "Proof System",   value: "Halo2 (EZKL)" },
            { label: "Curve",          value: "BN254" },
            { label: "Smart Contract", value: "Solidity 0.8.24" },
            { label: "Chain",          value: "EVM Compatible" },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-slate-500 text-xs font-mono">{label}</p>
              <p className="text-slate-200 text-sm font-medium mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [activeTab, setActiveTab] = useState<Tab>("publisher");

  return (
    <div className="min-h-screen bg-[#030712]">
      <Header activeTab={activeTab} setTab={setActiveTab} />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <HeroBanner />

        {/* Tab panel */}
        <AnimatePresence mode="wait">
          {activeTab === "publisher" ? (
            <motion.div
              key="publisher"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.22, ease: "easeInOut" }}
              className="relative rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-sm p-6 noise-bg"
            >
              <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-cyan-500/60 animate-pulse" />
              <PublisherDashboard />
            </motion.div>
          ) : (
            <motion.div
              key="verifier"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: "easeInOut" }}
              className="relative rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-sm p-6 noise-bg"
            >
              <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-emerald-500/60 animate-pulse" />
              <VerifierDashboard />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer */}
        <footer className="mt-12 border-t border-slate-800/60 pt-8 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600 font-mono">
          <div>
            Authentica — Phase 4 of 5{" "}
            <span className="text-slate-700">·</span>{" "}
            Built with Next.js + wagmi + EZKL + Hardhat
          </div>
          <div className="flex items-center gap-4">
            <span>zkml-engine/</span>
            <span>smart-contracts/</span>
            <span>local-backend/</span>
            <span className="text-cyan-700">frontend/</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
