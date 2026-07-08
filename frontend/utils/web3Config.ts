/**
 * utils/web3Config.ts  —  Authentica Phase 4
 * ============================================
 * Wagmi v2 + Viem configuration for MetaMask connection.
 * Exports typed contract ABIs and a pre-configured wagmi config
 * that works with both local Hardhat and Sepolia testnet.
 */

import { createConfig, http } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export function exportUrl(jobId: string): string {
  return `${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000"}/export/${jobId}`;
}

// ── Chain configuration ────────────────────────────────────────────────────
export const SUPPORTED_CHAINS = [hardhat, sepolia] as const;

export const wagmiConfig = createConfig({
  chains: SUPPORTED_CHAINS,
  connectors: [injected()],           // MetaMask / browser wallet
  transports: {
    [hardhat.id]:  http("http://127.0.0.1:8545"),
    [sepolia.id]:  http(),            // Uses default Sepolia public RPC
  },
  ssr: false,
});

// ── Contract addresses ─────────────────────────────────────────────────────
// Update these after running `npm run deploy:local` or `npm run deploy:sepolia`
export const CONTRACT_ADDRESSES = {
  [hardhat.id]: {
    VideoRegistry: (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS_LOCAL  ?? "") as `0x${string}`,
    Verifier:      (process.env.NEXT_PUBLIC_VERIFIER_ADDRESS_LOCAL   ?? "") as `0x${string}`,
  },
  [sepolia.id]: {
    VideoRegistry: (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS_SEPOLIA ?? "") as `0x${string}`,
    Verifier:      (process.env.NEXT_PUBLIC_VERIFIER_ADDRESS_SEPOLIA  ?? "") as `0x${string}`,
  },
} as const;

export function getContractAddress(
  chainId: number,
  name: "VideoRegistry" | "Verifier",
): `0x${string}` {
  const addresses = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];
  if (!addresses) throw new Error(`No contracts configured for chain ${chainId}`);
  return addresses[name];
}

// ── VideoRegistry ABI ──────────────────────────────────────────────────────
// Key functions and events used by the frontend.
export const VIDEO_REGISTRY_ABI = [
  // ── Write ─────────────────────────────────────────────────────────────
  {
    name: "publishVideo",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "videoHash", type: "bytes32" },
      { name: "proof",     type: "bytes"   },
      { name: "instances", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    name: "setVerifier",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_newVerifier", type: "address" }],
    outputs: [],
  },
  // ── Read ──────────────────────────────────────────────────────────────
  {
    name: "isVerified",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "videoHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getRecord",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "videoHash", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "videoHash",   type: "bytes32"   },
          { name: "publisher",   type: "address"   },
          { name: "timestamp",   type: "uint64"    },
          { name: "blockNumber", type: "uint64"    },
          { name: "proofDigest", type: "bytes32"   },
          { name: "instances",   type: "uint256[]" },
          { name: "verified",    type: "bool"      },
        ],
      },
    ],
  },
  {
    name: "getHashes",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "offset", type: "uint256" },
      { name: "limit",  type: "uint256" },
    ],
    outputs: [{ name: "result", type: "bytes32[]" }],
  },
  {
    name: "totalVideos",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "verifier",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: "VideoVerified",
    type: "event",
    inputs: [
      { name: "videoHash",   type: "bytes32", indexed: true  },
      { name: "publisher",   type: "address", indexed: true  },
      { name: "proofDigest", type: "bytes32", indexed: false },
      { name: "timestamp",   type: "uint64",  indexed: false },
      { name: "instances",   type: "uint256[]", indexed: false },
    ],
  },
  {
    name: "VerifierUpdated",
    type: "event",
    inputs: [
      { name: "oldVerifier", type: "address", indexed: true },
      { name: "newVerifier", type: "address", indexed: true },
    ],
  },
] as const;

// ── Verifier ABI (minimal) ─────────────────────────────────────────────────
export const VERIFIER_ABI = [
  {
    name: "verify",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "proof",     type: "bytes"     },
      { name: "instances", type: "uint256[]" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

// ── Backend API config ─────────────────────────────────────────────────────
export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

// ── Types ──────────────────────────────────────────────────────────────────
export interface VideoRecord {
  videoHash:   `0x${string}`;
  publisher:   `0x${string}`;
  timestamp:   bigint;
  blockNumber: bigint;
  proofDigest: `0x${string}`;
  instances:   readonly bigint[];
  verified:    boolean;
}

export interface JobStatus {
  job_id:       string;
  status:       "pending" | "processing" | "publishing" | "done" | "failed";
  video_hash:   string | null;
  tx_hash:      string | null;
  block_number: number | null;
  gas_used:     number | null;
  frame_count:  number | null;
  error:        string | null;
}

export type PipelineStep =
  | "idle"
  | "uploading"
  | "processing"
  | "proving"
  | "publishing"
  | "done"
  | "error";
