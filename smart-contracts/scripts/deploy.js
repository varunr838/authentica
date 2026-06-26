// scripts/deploy.js  —  Authentica Phase 2
//
// Deployment order:
//   1. Deploy Verifier.sol      (the EZKL-generated zk-SNARK verifier)
//   2. Deploy VideoRegistry.sol (passing Verifier's address as constructor arg)
//   3. Write deployment addresses to deployments/<network>.json
//
// Usage:
//   npx hardhat run scripts/deploy.js --network localhost   # local test
//   npx hardhat run scripts/deploy.js --network sepolia     # testnet
//
// After deployment on Sepolia, verify source on Etherscan:
//   npx hardhat verify --network sepolia <VERIFIER_ADDRESS>
//   npx hardhat verify --network sepolia <REGISTRY_ADDRESS> <VERIFIER_ADDRESS>

const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Helpers ───────────────────────────────────────────────────────────────────
function separator(title) {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function fmt(label, value) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

async function saveDeployment(data) {
  const dir  = path.join(__dirname, "..", "deployments");
  const file = path.join(dir, `${network.name}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const merged = { ...existing, ...data };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  console.log(`\n  Deployment record saved → ${file}`);
}

// ── Main deployment ───────────────────────────────────────────────────────────
async function main() {
  separator("Authentica — Phase 2 Smart Contract Deployment");

  // ── Deployer info ────────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  const balance    = await ethers.provider.getBalance(deployer.address);

  fmt("Network:",        network.name);
  fmt("Chain ID:",       (await ethers.provider.getNetwork()).chainId.toString());
  fmt("Deployer:",       deployer.address);
  fmt("Balance:",        `${ethers.formatEther(balance)} ETH`);

  if (network.name === "sepolia" && balance < ethers.parseEther("0.01")) {
    console.warn("\n  ⚠  Low balance — get Sepolia ETH from https://sepoliafaucet.com");
  }

  // ── 1. Deploy Verifier ────────────────────────────────────────────────────
  separator("Step 1/2 — Deploy Verifier.sol");
  console.log("  ℹ  Note: This deploys the STUB verifier.");
  console.log("     Replace contracts/Verifier.sol with the EZKL-generated file,");
  console.log("     then re-run this script for a production deployment.\n");

  const VerifierFactory = await ethers.getContractFactory("Verifier");
  const verifier        = await VerifierFactory.deploy();
  await verifier.waitForDeployment();

  const verifierAddress = await verifier.getAddress();
  const verifierTx      = verifier.deploymentTransaction();
  const verifierReceipt = await verifierTx.wait();

  fmt("Verifier address:",  verifierAddress);
  fmt("Deploy tx hash:",    verifierTx.hash);
  fmt("Gas used:",          verifierReceipt.gasUsed.toString());

  // Sanity-check: real EZKL contract does NOT have isStub(), so we use try/catch
  try {
    const isStub = await verifier.isStub();
    if (isStub) {
      console.log("\n  ⚠  Stub verifier detected — verify() will always return false.");
      console.log("     Run `python ../zkml-engine/zk_compiler.py` and copy");
      console.log("     `../zkml-engine/artifacts/verifier.sol` → contracts/Verifier.sol");
    }
  } catch {
    console.log("\n  ✓  Real EZKL verifier deployed (isStub() not present).");
  }

  // ── 2. Deploy VideoRegistry ───────────────────────────────────────────────
  separator("Step 2/2 — Deploy VideoRegistry.sol");

  const RegistryFactory = await ethers.getContractFactory("VideoRegistry");
  const registry        = await RegistryFactory.deploy(verifierAddress);
  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();
  const registryTx      = registry.deploymentTransaction();
  const registryReceipt = await registryTx.wait();

  fmt("VideoRegistry address:", registryAddress);
  fmt("Deploy tx hash:",        registryTx.hash);
  fmt("Gas used:",              registryReceipt.gasUsed.toString());

  // Confirm the registry knows about the verifier
  const linkedVerifier = await registry.verifier();
  fmt("Linked verifier:",       linkedVerifier);
  console.assert(
    linkedVerifier.toLowerCase() === verifierAddress.toLowerCase(),
    "ERROR: Registry verifier mismatch!"
  );

  // ── 3. Save deployment record ─────────────────────────────────────────────
  separator("Deployment Summary");

  const deploymentData = {
    network:         network.name,
    deployedAt:      new Date().toISOString(),
    deployer:        deployer.address,
    verifier: {
      address:       verifierAddress,
      txHash:        verifierTx.hash,
      gasUsed:       verifierReceipt.gasUsed.toString(),
    },
    videoRegistry: {
      address:       registryAddress,
      txHash:        registryTx.hash,
      gasUsed:       registryReceipt.gasUsed.toString(),
      verifierArg:   verifierAddress,
    },
  };

  fmt("Verifier:",        verifierAddress);
  fmt("VideoRegistry:",   registryAddress);

  await saveDeployment(deploymentData);

  // ── 4. Explorer links ─────────────────────────────────────────────────────
  if (network.name === "sepolia") {
    separator("Block Explorer Links");
    const base = "https://sepolia.etherscan.io";
    console.log(`  Verifier:      ${base}/address/${verifierAddress}`);
    console.log(`  VideoRegistry: ${base}/address/${registryAddress}`);
    console.log(`\n  Verify source (run after deployment):`);
    console.log(`  npx hardhat verify --network sepolia ${verifierAddress}`);
    console.log(`  npx hardhat verify --network sepolia ${registryAddress} "${verifierAddress}"`);
  }

  separator("Done");
  console.log("  Phase 2 contracts deployed successfully.");
  console.log("  Next steps:");
  console.log("    1. Copy the real EZKL verifier.sol from zkml-engine/artifacts/");
  console.log("    2. Re-deploy to replace the stub with the real cryptographic verifier.");
  console.log("    3. Wire the VideoRegistry address into the Phase 3 FastAPI backend.");
  console.log("");
}

// ── Run ───────────────────────────────────────────────────────────────────────
main().catch((error) => {
  console.error("\n  ✗ Deployment failed:", error.message);
  process.exitCode = 1;
});
