"use client";
/**
 * components/WalletButton.tsx
 * MetaMask connect/disconnect button with address display.
 */
import { useAccount, useConnect, useDisconnect, useChainId } from "wagmi";
import { injected } from "wagmi/connectors";
import { motion } from "framer-motion";

const CHAIN_NAMES: Record<number, string> = {
  1337:     "Hardhat",
  11155111: "Sepolia",
  1:        "Mainnet",
};

export default function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect }              = useConnect();
  const { disconnect }           = useDisconnect();
  const chainId                  = useChainId();
  const chainName                = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-slate-300 text-xs font-mono">
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
          <span className="text-slate-500 text-xs border-l border-slate-700 pl-2">{chainName}</span>
        </div>
        <button
          onClick={() => disconnect()}
          className="px-3 py-1.5 rounded-xl text-xs text-slate-400 border border-slate-700
                     hover:border-red-700 hover:text-red-400 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <motion.button
      onClick={() => connect({ connector: injected() })}
      className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                 bg-gradient-to-r from-cyan-600 to-blue-600
                 hover:from-cyan-500 hover:to-blue-500
                 text-white shadow-lg shadow-cyan-900/30 transition-all"
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.5 8.25H5.25a2.25 2.25 0 00-2.25 2.25v7.5A2.25 2.25 0 005.25 20.25h14.25a2.25 2.25 0 002.25-2.25v-7.5a2.25 2.25 0 00-2.25-2.25zm-14.25-1.5h15a.75.75 0 000-1.5H5.25a3.75 3.75 0 00-3.75 3.75v7.5a.75.75 0 001.5 0v-7.5A2.25 2.25 0 015.25 6.75z"/>
      </svg>
      Connect Wallet
    </motion.button>
  );
}
