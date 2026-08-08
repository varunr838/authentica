const { ethers } = require("ethers");
const fs = require("fs");
const abi = ["function verifyProof(bytes calldata proof, uint256[] calldata instances) public returns (bool)"];
const iface = new ethers.Interface(abi);
const calldata = fs.readFileSync("calldata.txt", "utf-8").trim();
const decoded = iface.decodeFunctionData("verifyProof", "0x" + calldata);
console.log("Proof length:", decoded.proof.length);
console.log("Instances length:", decoded.instances.length);
console.log("First instance:", BigInt(decoded.instances[0]).toString(16));
