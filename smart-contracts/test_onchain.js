const { ethers } = require("hardhat");
const fs = require("fs");
async function main() {
  const p = JSON.parse(fs.readFileSync("../zkml-engine/artifacts/proof.json"));
  const proof = "0x" + p.proof;
  const instances = p.instances[0].map(x => "0x" + x);
  const hash = ethers.id("dummy");
  const Registry = await ethers.getContractFactory("VideoRegistry");
  const registry = Registry.attach("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
  try {
    const tx = await registry.publishVideo(hash, proof, instances);
    await tx.wait();
    console.log("SUCCESS!");
  } catch(e) {
    console.log("FAILED:", e.message);
  }
}
main();
