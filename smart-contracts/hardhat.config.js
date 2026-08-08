require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

// ── Environment variable helpers ─────────────────────────────────────────────
// Copy .env.example → .env and fill in your values.
const PRIVATE_KEY      = process.env.PRIVATE_KEY      || "0x" + "0".repeat(64);
const SEPOLIA_RPC_URL  = process.env.SEPOLIA_RPC_URL  || "https://rpc.sepolia.org";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

// ── Hardhat Configuration ────────────────────────────────────────────────────
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // ── Solidity compiler ──────────────────────────────────────────────────────
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,          // optimise for deployment cost vs. call cost balance
        details: {
          yul: true,
          yulDetails: {
            optimizerSteps: "u", // Required to compile large EZKL verifiers without stack too deep errors
          }
        }
      },
      viaIR: true,          // required for EZKL-generated verifiers (large contracts)
    },
  },

  // ── Networks ───────────────────────────────────────────────────────────────
  networks: {
    // Local Hardhat node  — `npx hardhat node` then deploy with --network localhost
    localhost: {
      url: "http://127.0.0.1:8545",
    },

    // Ethereum Sepolia testnet  — get free ETH from https://sepoliafaucet.com
    sepolia: {
      url:      SEPOLIA_RPC_URL,
      accounts: [PRIVATE_KEY],
      chainId:  11155111,
      gasPrice: "auto",
    },

    // Polygon Amoy testnet (optional alternative)
    amoy: {
      url:      process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      accounts: [PRIVATE_KEY],
      chainId:  80002,
    },
  },

  // ── Etherscan / block-explorer verification ────────────────────────────────
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY,
    },
  },

  // ── Gas reporter (optional — set REPORT_GAS=true in .env) ─────────────────
  gasReporter: {
    enabled:  process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || "",
    outputFile: "gas-report.txt",
    noColors: true,
  },

  // ── Paths ──────────────────────────────────────────────────────────────────
  paths: {
    sources:  "./contracts",
    tests:    "./test",
    cache:    "./cache",
    artifacts:"./artifacts",
  },

  // ── Mocha test timeout (proof-related tests can be slow) ──────────────────
  mocha: {
    timeout: 120_000,
  },
};
