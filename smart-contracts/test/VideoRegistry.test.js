// test/VideoRegistry.test.js  —  Authentica Phase 2
//
// Tests the VideoRegistry contract with a MockVerifier that returns
// configurable pass/fail results. This lets us test all business logic
// without needing a real zk-SNARK proof.

const { expect }         = require("chai");
const { ethers }         = require("hardhat");
const { loadFixture }    = require("@nomicfoundation/hardhat-network-helpers");

// ── Helpers ───────────────────────────────────────────────────────────────────
const DUMMY_HASH      = ethers.keccak256(ethers.toUtf8Bytes("authentica-test-video"));
const DUMMY_HASH_2    = ethers.keccak256(ethers.toUtf8Bytes("authentica-test-video-2"));
const DUMMY_PROOF     = ethers.toUtf8Bytes("fake-proof-bytes-for-testing");
const DUMMY_INSTANCES = [1n, 2n, 3n, 4n];

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Deploy a MockVerifier that always returns `true`, then a VideoRegistry
 * pointing at it. Returns all relevant contracts and signers.
 */
async function deployPassingFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  // Deploy mock verifier (always passes)
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const mockVerifier = await MockVerifier.deploy(true);   // shouldPass = true
  await mockVerifier.waitForDeployment();

  const Registry = await ethers.getContractFactory("VideoRegistry");
  const registry = await Registry.deploy(await mockVerifier.getAddress());
  await registry.waitForDeployment();

  return { registry, mockVerifier, owner, alice, bob };
}

/**
 * Deploy with a MockVerifier that always returns `false`.
 */
async function deployFailingFixture() {
  const [owner, alice] = await ethers.getSigners();

  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const mockVerifier = await MockVerifier.deploy(false);  // shouldPass = false

  const Registry = await ethers.getContractFactory("VideoRegistry");
  const registry = await Registry.deploy(await mockVerifier.getAddress());
  await registry.waitForDeployment();

  return { registry, mockVerifier, owner, alice };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("VideoRegistry", function () {

  // ── Deployment ──────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores the verifier address", async function () {
      const { registry, mockVerifier } = await loadFixture(deployPassingFixture);
      expect(await registry.verifier()).to.equal(await mockVerifier.getAddress());
    });

    it("starts with totalVideos = 0", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      expect(await registry.totalVideos()).to.equal(0n);
    });

    it("reverts if verifier address is zero", async function () {
      const Registry = await ethers.getContractFactory("VideoRegistry");
      await expect(Registry.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError({ interface: Registry.interface }, "ZeroAddress");
    });
  });

  // ── publishVideo (success path) ──────────────────────────────────────────────
  describe("publishVideo — valid proof", function () {
    it("emits VideoVerified with correct fields", async function () {
      const { registry, alice } = await loadFixture(deployPassingFixture);

      await expect(
        registry.connect(alice).publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES)
      )
        .to.emit(registry, "VideoVerified")
        .withArgs(
          DUMMY_HASH,
          alice.address,
          ethers.keccak256(DUMMY_PROOF),
          // timestamp — we match any uint64
          (ts) => ts > 0n,
          DUMMY_INSTANCES
        );
    });

    it("increments totalVideos", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES);
      expect(await registry.totalVideos()).to.equal(1n);
    });

    it("marks hash as verified", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES);
      expect(await registry.isVerified(DUMMY_HASH)).to.be.true;
    });

    it("stores full VideoRecord correctly", async function () {
      const { registry, owner } = await loadFixture(deployPassingFixture);
      const tx = await registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES);
      const receipt = await tx.wait();
      const block   = await ethers.provider.getBlock(receipt.blockNumber);

      const rec = await registry.getRecord(DUMMY_HASH);
      expect(rec.videoHash).to.equal(DUMMY_HASH);
      expect(rec.publisher).to.equal(owner.address);
      expect(rec.timestamp).to.equal(BigInt(block.timestamp));
      expect(rec.verified).to.be.true;
      expect(rec.instances).to.deep.equal(DUMMY_INSTANCES);
    });

    it("stores keccak256(proof) as proofDigest", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES);
      const rec = await registry.getRecord(DUMMY_HASH);
      expect(rec.proofDigest).to.equal(ethers.keccak256(DUMMY_PROOF));
    });
  });

  // ── publishVideo (failure paths) ──────────────────────────────────────────────
  describe("publishVideo — invalid inputs", function () {
    it("reverts with ZeroHash when videoHash is zero", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await expect(
        registry.publishVideo(ethers.ZeroHash, DUMMY_PROOF, DUMMY_INSTANCES)
      ).to.be.revertedWithCustomError(registry, "ZeroHash");
    });

    it("reverts with EmptyProof when proof is empty", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await expect(
        registry.publishVideo(DUMMY_HASH, "0x", DUMMY_INSTANCES)
      ).to.be.revertedWithCustomError(registry, "EmptyProof");
    });

    it("reverts with EmptyInstances when instances is empty", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await expect(
        registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, [])
      ).to.be.revertedWithCustomError(registry, "EmptyInstances");
    });

    it("reverts with VideoAlreadyRegistered on duplicate hash", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      await registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES);
      await expect(
        registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES)
      ).to.be.revertedWithCustomError(registry, "VideoAlreadyRegistered")
       .withArgs(DUMMY_HASH);
    });

    it("reverts with InvalidProof when verifier returns false", async function () {
      const { registry } = await loadFixture(deployFailingFixture);
      await expect(
        registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES)
      ).to.be.revertedWithCustomError(registry, "InvalidProof");
    });
  });

  // ── View functions ──────────────────────────────────────────────────────────
  describe("View functions", function () {
    it("isVerified returns false for unknown hash", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      expect(await registry.isVerified(DUMMY_HASH)).to.be.false;
    });

    it("getPublisher returns address(0) for unknown hash", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      expect(await registry.getPublisher(DUMMY_HASH)).to.equal(ethers.ZeroAddress);
    });

    it("getHashes returns paginated results", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      const proof2 = ethers.toUtf8Bytes("proof-2");

      await registry.publishVideo(DUMMY_HASH,   DUMMY_PROOF, DUMMY_INSTANCES);
      await registry.publishVideo(DUMMY_HASH_2, proof2,      DUMMY_INSTANCES);

      const page1 = await registry.getHashes(0, 1);
      expect(page1.length).to.equal(1);
      expect(page1[0]).to.equal(DUMMY_HASH);

      const page2 = await registry.getHashes(1, 1);
      expect(page2.length).to.equal(1);
      expect(page2[0]).to.equal(DUMMY_HASH_2);

      const all = await registry.getHashes(0, 10);
      expect(all.length).to.equal(2);
    });

    it("getHashes returns empty array for out-of-range offset", async function () {
      const { registry } = await loadFixture(deployPassingFixture);
      const result = await registry.getHashes(999, 10);
      expect(result.length).to.equal(0);
    });
  });

  // ── Admin functions ──────────────────────────────────────────────────────────
  describe("Admin", function () {
    it("owner can update the verifier", async function () {
      const { registry, owner } = await loadFixture(deployPassingFixture);

      // Deploy a second mock verifier
      const MockVerifier   = await ethers.getContractFactory("MockVerifier");
      const newMockVerifier = await MockVerifier.deploy(true);
      const newAddr         = await newMockVerifier.getAddress();

      await expect(registry.connect(owner).setVerifier(newAddr))
        .to.emit(registry, "VerifierUpdated");

      expect(await registry.verifier()).to.equal(newAddr);
    });

    it("non-owner cannot update verifier", async function () {
      const { registry, alice } = await loadFixture(deployPassingFixture);
      const MockVerifier = await ethers.getContractFactory("MockVerifier");
      const mock         = await MockVerifier.deploy(true);
      await expect(
        registry.connect(alice).setVerifier(await mock.getAddress())
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("owner can pause and unpause", async function () {
      const { registry, owner } = await loadFixture(deployPassingFixture);

      await registry.connect(owner).pause();
      await expect(
        registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await registry.connect(owner).unpause();
      await expect(
        registry.publishVideo(DUMMY_HASH, DUMMY_PROOF, DUMMY_INSTANCES)
      ).not.to.be.reverted;
    });

    it("setVerifier reverts on zero address", async function () {
      const { registry, owner } = await loadFixture(deployPassingFixture);
      await expect(
        registry.connect(owner).setVerifier(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });
});
