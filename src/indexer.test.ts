/**
 * Two kinds of test:
 *
 *  1. PINNED REAL-DATA tests at fixed blocks, one on each side of the EIP-2535
 *     facet cut at block 31,872,097. These hit HyperSync and assert the exact
 *     number of logs each block contains, so a signature that stops decoding shows
 *     up as a short count rather than as a quietly empty table. The post-cut block
 *     31,907,253 is the one that matters most: it contains the
 *     `RewardDistributionQueued` whose *verified ABI form has never been emitted*,
 *     so this test is what stands between the project and 1,532 missing rows.
 *
 *  2. SIMULATED handler tests for the arithmetic and the lifecycle guards — no
 *     network, deterministic.
 */
import { describe, it } from "vitest";
import { createTestIndexer, TestHelpers } from "envio";

const { Addresses } = TestHelpers;

const CHAIN = 999;
const PROTOCOL_ID = "kinetiq";
const KHYPE = "0xfD739d4e423301CE9385c1fb8850539D657C296D";
const STAKING_MANAGER = "0x393D0B87Ed38fc779FD9611144aE649BA6082109";
const ONE_E18 = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type ProcessResult = Awaited<
  ReturnType<ReturnType<typeof createTestIndexer>["process"]>
>;

function eventsProcessed(result: ProcessResult): number {
  return result.changes.reduce((total, change) => total + change.eventsProcessed, 0);
}

function block(startBlock: number, endBlock = startBlock) {
  return { chains: { [CHAIN]: { startBlock, endBlock } } };
}

// ---------------------------------------------------------------------------
// Pinned — pre-diamond-cut era
// ---------------------------------------------------------------------------

describe("pinned: pre-diamond-cut era", () => {
  it("decodes the protocol's first stake at block 8,399,072", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process(block(8_399_072));

    // Transfer(mint) + L1DelegationQueued + Delegate + StakeRecorded + StakeReceived.
    // A wrong `uint8` on OperationType alone would drop this to 4.
    t.expect(eventsProcessed(result), "all five logs in the block decode").toBe(5);

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(
      {
        stakeReceived: stats.stakeReceivedCount,
        stakeRecorded: stats.stakeRecordedCount,
        delegate: stats.delegateCount,
        l1DelegationQueued: stats.l1DelegationQueuedCount,
      },
      "one of each staking event",
    ).toEqual({
      stakeReceived: 1,
      stakeRecorded: 1,
      delegate: 1,
      l1DelegationQueued: 1,
    });

    // 0.01 kHYPE minted against 0.01 HYPE staked.
    const staked = 10_000_000_000_000_000n;
    t.expect(stats.totalStaked, "Σ StakeRecorded.amount").toBe(staked);
    t.expect(stats.kHypeTotalSupply, "Σ mints − Σ burns").toBe(staked);
    t.expect(stats.totalStakeReceived, "Σ StakeReceived.amount").toBe(staked);

    // No rewards and no claims yet, so backing == supply and the rate is exactly 1.
    t.expect(stats.totalHypeBacking).toBe(staked);
    t.expect(stats.exchangeRate, "first stake prices kHYPE at 1.0 HYPE").toBe(
      ONE_E18,
    );

    const token = await indexer.Token.getOrThrow(KHYPE);
    t.expect(
      { supply: token.totalSupply, mints: token.mintCount },
      "the mint is counted once and moves supply by its full value",
    ).toEqual({ supply: staked, mints: 1n });

    const snapshot = await indexer.ExchangeRateSnapshot.getOrThrow("000008399072");
    t.expect(snapshot.exchangeRate).toBe(ONE_E18);
    t.expect(snapshot.blockNumber).toBe(8_399_072n);
  });

  it("opens a withdrawal request keyed per user at block 8,401,073", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process(block(8_401_073));
    // Transfer + L1DelegationQueued + ValidatorWithdrawal + WithdrawalQueued
    t.expect(eventsProcessed(result)).toBe(4);

    const requests = await indexer.WithdrawalRequest.getAll();
    t.expect(requests, "exactly one request queued").toHaveLength(1);

    const request = requests[0]!;
    t.expect(request.status).toBe("Queued");
    t.expect(request.withdrawalId, "the protocol's first withdrawal nonce").toBe(0n);
    t.expect(
      request.id,
      "the key carries the user — withdrawalId is a per-user nonce",
    ).toBe(`${request.user_id}-0`);
    t.expect(request.confirmationCount).toBe(0);

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.pendingWithdrawalCount).toBe(1);
    t.expect(stats.pendingWithdrawalKHype).toBe(request.kHypeAmount);
  });
});

// ---------------------------------------------------------------------------
// Pinned — the facet cut, and the post-cut era
// ---------------------------------------------------------------------------

describe("pinned: diamond cut and post-cut era", () => {
  it("records the facet cut at block 31,873,622", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process(block(31_873_622));
    // FacetRegistrySet + 7 × FacetAdded + 7 × DiamondCut
    t.expect(
      eventsProcessed(result),
      "the tuple-array DiamondCut signature decodes",
    ).toBe(15);

    const changes = await indexer.ProtocolChangeEvent.getAll();
    const byKind = changes.reduce<Record<string, number>>((acc, change) => {
      acc[change.kind] = (acc[change.kind] ?? 0) + 1;
      return acc;
    }, {});
    t.expect(byKind).toEqual({
      DiamondCut: 7,
      FacetAdded: 7,
      FacetRegistrySet: 1,
    });

    const facets = changes.filter((c) => c.kind === "FacetAdded");
    t.expect(
      facets.every((f) => (f.selectorCount ?? 0) > 0),
      "every added facet reports at least one bytes4 selector",
    ).toBe(true);

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.diamondCutCount).toBe(7);
  });

  it("decodes the three-parameter RewardDistributionQueued at block 31,907,253", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process(block(31_907_253));
    // ValidatorPerformanceUpdated + L1OperationAggregated + RewardDistributionQueued
    // + RewardEventReported + PerformanceUpdated.
    //
    // The verified ABI's six-parameter RewardDistributionQueued hashes to a topic0
    // that has never appeared on this contract. Registering it instead of the
    // three-parameter form makes this block yield 4 events, not 5, and leaves
    // RewardDistribution permanently empty.
    t.expect(eventsProcessed(result), "the reward distribution decodes").toBe(5);

    const distributions = await indexer.RewardDistribution.getAll();
    t.expect(distributions, "one reward distribution queued").toHaveLength(1);

    const distribution = distributions[0]!;
    t.expect(distribution.status).toBe("Queued");
    t.expect(distribution.amount, "the single data word is the amount").toBeGreaterThan(
      0n,
    );
    t.expect(distribution.validator_id).toBeDefined();

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.rewardDistributionQueuedCount).toBe(1);
    t.expect(stats.rewardEventReportedCount).toBe(1);
    // The two oracle contracts report the same round; their counts must track.
    t.expect(stats.performanceUpdatedCount).toBe(1);
    t.expect(stats.validatorPerformanceUpdatedCount).toBe(1);
    t.expect(stats.totalRewards, "rewards raise the backing").toBeGreaterThan(0n);
  });

  it("decodes a post-cut instant unstake at block 34,318,796", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process(block(34_318_796));
    // 3 × Transfer + ClaimRecorded + InstantUnstakeExecuted
    t.expect(eventsProcessed(result)).toBe(5);

    const unstakes = await indexer.InstantUnstake.getAll();
    t.expect(unstakes).toHaveLength(1);

    const unstake = unstakes[0]!;
    // 0.1 kHYPE in; the seven-word event carries the whole fee split.
    t.expect(unstake.kHypeAmount).toBe(100_000_000_000_000_000n);
    t.expect(
      unstake.kHypeFee,
      "fee splits into the burned and treasury legs",
    ).toBe(unstake.kHypeFeeBurned + unstake.kHypeFeeToTreasury);
    t.expect(unstake.hypeReceived).toBeGreaterThan(0n);

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.instantUnstakeCount).toBe(1);
    t.expect(stats.claimRecordedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Simulated — accounting
// ---------------------------------------------------------------------------

describe("exchange rate", () => {
  it("reconstructs (staked + rewards − claimed − slashing) / supply", async (t) => {
    const indexer = createTestIndexer();
    const user = Addresses.mockAddresses[0]!;
    const validator = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: ZERO_ADDRESS, to: user, value: 100n * ONE_E18 },
            },
            {
              contract: "StakingAccountant",
              event: "StakeRecorded",
              params: { manager: STAKING_MANAGER, amount: 100n * ONE_E18 },
            },
            {
              contract: "ValidatorManager",
              event: "RewardEventReported",
              params: { validator, amount: 5n * ONE_E18 },
            },
            {
              contract: "StakingAccountant",
              event: "ClaimRecorded",
              params: { manager: STAKING_MANAGER, amount: 20n * ONE_E18 },
            },
          ],
        },
      },
    });

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.totalHypeBacking, "100 + 5 − 20 − 0").toBe(85n * ONE_E18);
    t.expect(stats.exchangeRate, "85 HYPE backing 100 kHYPE = 0.85").toBe(
      850_000_000_000_000_000n,
    );
  });

  it("prices kHYPE at 1.0 while the protocol holds no stake", async (t) => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "StakingManager",
              event: "SpotWithdrawn",
              params: { amount: ONE_E18 },
            },
          ],
        },
      },
    });

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(
      stats.exchangeRate,
      "a zero supply must not divide by zero",
    ).toBe(ONE_E18);
  });
});

describe("token surface scope", () => {
  // Regression guard for the P6 finding: kHYPE reaches HyperEVM from HyperCore via
  // system transactions that this event stream does not carry. Those are always
  // plain bridge->user transfers, never mints or burns. So supply stays exact, but
  // any per-account balance or whole-token transfer count derived from these events
  // would be short by every Core->EVM movement — and would go negative for accounts
  // credited on HyperCore and later spending on HyperEVM. The fix is to not carry
  // that surface at all; this test fails if someone reintroduces it.
  it("tracks no per-account balance state, so a wallet-to-wallet transfer is a no-op", async (t) => {
    const indexer = createTestIndexer();
    const alice = Addresses.mockAddresses[0]!;
    const bob = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: ZERO_ADDRESS, to: alice, value: 100n },
            },
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: alice, to: bob, value: 100n },
            },
          ],
        },
      },
    });

    const token = await indexer.Token.getOrThrow(KHYPE);
    t.expect(
      {
        supply: token.totalSupply,
        minted: token.totalMinted,
        burned: token.totalBurned,
        mints: token.mintCount,
      },
      "only the mint moved supply; the wallet-to-wallet transfer changed nothing",
    ).toEqual({ supply: 100n, minted: 100n, burned: 0n, mints: 1n });

    t.expect(
      "Holder" in indexer,
      "no Holder entity: a balance ledger built from these events cannot be proven",
    ).toBe(false);
  });

  it("still reconstructs supply exactly when a bridge transfer is missing", async (t) => {
    // Simulate the real gap: a Core->EVM credit to bob is absent from the stream,
    // and bob then sends it on. Supply must be unaffected by both.
    const indexer = createTestIndexer();
    const alice = Addresses.mockAddresses[0]!;
    const bob = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: ZERO_ADDRESS, to: alice, value: 100n },
            },
            // (the bridge -> bob credit that HyperCore settles is not in the stream)
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: bob, to: alice, value: 500n },
            },
          ],
        },
      },
    });

    const token = await indexer.Token.getOrThrow(KHYPE);
    t.expect(
      token.totalSupply,
      "an unmatched send cannot corrupt supply, because supply counts only mints and burns",
    ).toBe(100n);
  });

  it("burns reduce supply and take the rate down with them", async (t) => {
    const indexer = createTestIndexer();
    const alice = Addresses.mockAddresses[0]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "StakingAccountant",
              event: "StakeRecorded",
              params: { manager: STAKING_MANAGER, amount: 100n * ONE_E18 },
            },
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: ZERO_ADDRESS, to: alice, value: 100n * ONE_E18 },
            },
            {
              contract: "KHYPE",
              event: "Transfer",
              params: { from: alice, to: ZERO_ADDRESS, value: 50n * ONE_E18 },
            },
          ],
        },
      },
    });

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    const token = await indexer.Token.getOrThrow(KHYPE);
    t.expect(token.totalSupply).toBe(50n * ONE_E18);
    t.expect(token.burnCount).toBe(1n);
    t.expect(
      stats.exchangeRate,
      "100 HYPE backing 50 kHYPE = 2.0 — burning without claiming repriced the token",
    ).toBe(2n * ONE_E18);
  });
});

// ---------------------------------------------------------------------------
// Simulated — lifecycle guards
// ---------------------------------------------------------------------------

describe("withdrawal lifecycle", () => {
  it("never lets a duplicate confirmation rewrite a settled withdrawal", async (t) => {
    const indexer = createTestIndexer();
    const user = Addresses.mockAddresses[0]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "StakingManager",
              event: "WithdrawalQueued",
              params: {
                staking: STAKING_MANAGER,
                user,
                withdrawalId: 7n,
                kHYPEAmount: 10n * ONE_E18,
                hypeAmount: 10n * ONE_E18,
                feeAmount: 0n,
              },
            },
            {
              contract: "StakingManager",
              event: "WithdrawalConfirmed",
              params: { user, withdrawalId: 7n, amount: 10n * ONE_E18 },
            },
            // The late duplicate. Applied naively this overwrites the settlement.
            {
              contract: "StakingManager",
              event: "WithdrawalConfirmed",
              params: { user, withdrawalId: 7n, amount: 999n * ONE_E18 },
            },
          ],
        },
      },
    });

    const request = await indexer.WithdrawalRequest.getOrThrow(`${user}-7`);
    t.expect(
      {
        status: request.status,
        amount: request.confirmedAmount,
        confirmations: request.confirmationCount,
      },
      "Confirmed is terminal: the duplicate is counted, never applied",
    ).toEqual({
      status: "Confirmed",
      amount: 10n * ONE_E18,
      confirmations: 2,
    });

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(
      stats.pendingWithdrawalCount,
      "the queue drains once, not twice",
    ).toBe(0);
    t.expect(stats.pendingWithdrawalKHype).toBe(0n);
  });

  it("keeps two users' withdrawal nonce 0 apart", async (t) => {
    const indexer = createTestIndexer();
    const alice = Addresses.mockAddresses[0]!;
    const bob = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "StakingManager",
              event: "WithdrawalQueued",
              params: {
                staking: STAKING_MANAGER,
                user: alice,
                withdrawalId: 0n,
                kHYPEAmount: ONE_E18,
                hypeAmount: ONE_E18,
                feeAmount: 0n,
              },
            },
            {
              contract: "StakingManager",
              event: "WithdrawalQueued",
              params: {
                staking: STAKING_MANAGER,
                user: bob,
                withdrawalId: 0n,
                kHYPEAmount: 2n * ONE_E18,
                hypeAmount: 2n * ONE_E18,
                feeAmount: 0n,
              },
            },
            // Only alice's settles.
            {
              contract: "StakingManager",
              event: "WithdrawalConfirmed",
              params: { user: alice, withdrawalId: 0n, amount: ONE_E18 },
            },
          ],
        },
      },
    });

    const aliceRequest = await indexer.WithdrawalRequest.getOrThrow(`${alice}-0`);
    const bobRequest = await indexer.WithdrawalRequest.getOrThrow(`${bob}-0`);

    t.expect(
      { alice: aliceRequest.status, bob: bobRequest.status },
      "settling alice's nonce 0 must not settle bob's",
    ).toEqual({ alice: "Confirmed", bob: "Queued" });
    t.expect(bobRequest.kHypeAmount).toBe(2n * ONE_E18);

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.pendingWithdrawalCount).toBe(1);
    t.expect(stats.pendingWithdrawalKHype).toBe(2n * ONE_E18);
  });
});

describe("reward distribution lifecycle", () => {
  it("never lets a duplicate completion rewrite a finished distribution", async (t) => {
    const indexer = createTestIndexer();
    const validator = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "StakingManager",
              event: "RewardDistributionQueued",
              params: { distributionId: 42n, validator, amount: 10n * ONE_E18 },
            },
            {
              contract: "StakingManager",
              event: "RewardDistributionCompleted",
              params: { distributionId: 42n, rewardShare: 5n * ONE_E18 },
            },
            {
              contract: "StakingManager",
              event: "RewardDistributionCompleted",
              params: { distributionId: 42n, rewardShare: 999n * ONE_E18 },
            },
          ],
        },
      },
    });

    const distribution = await indexer.RewardDistribution.getOrThrow(
      "000000000042",
    );
    t.expect({
      status: distribution.status,
      share: distribution.rewardShare,
      completions: distribution.completionCount,
      amount: distribution.amount,
    }).toEqual({
      status: "Completed",
      share: 5n * ONE_E18,
      completions: 2,
      amount: 10n * ONE_E18,
    });
  });
});

describe("validator lifecycle", () => {
  it("counts active validators once, however many times they are activated", async (t) => {
    const indexer = createTestIndexer();
    const one = Addresses.mockAddresses[0]!;
    const two = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "ValidatorManager",
              event: "ValidatorActivated",
              params: { validator: one },
            },
            // A repeat activation must not double-count.
            {
              contract: "ValidatorManager",
              event: "ValidatorActivated",
              params: { validator: one },
            },
            {
              contract: "ValidatorManager",
              event: "ValidatorActivated",
              params: { validator: two },
            },
            {
              contract: "ValidatorManager",
              event: "ValidatorDeactivated",
              params: { validator: two },
            },
            // As must a repeat deactivation.
            {
              contract: "ValidatorManager",
              event: "ValidatorDeactivated",
              params: { validator: two },
            },
          ],
        },
      },
    });

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(
      { active: stats.activeValidatorCount, total: stats.validatorCount },
      "one active of two known validators",
    ).toEqual({ active: 1, total: 2 });

    const first = await indexer.Validator.getOrThrow(one);
    t.expect({ isActive: first.isActive, activations: first.activationCount }).toEqual(
      { isActive: true, activations: 2 },
    );
  });

  it("tracks net delegated stake through delegate and withdrawal", async (t) => {
    const indexer = createTestIndexer();
    const validator = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "StakingManager",
              event: "Delegate",
              params: { staking: STAKING_MANAGER, validator, amount: 30n * ONE_E18 },
            },
            {
              contract: "StakingManager",
              event: "ValidatorWithdrawal",
              params: { staking: STAKING_MANAGER, validator, amount: 12n * ONE_E18 },
            },
          ],
        },
      },
    });

    const entity = await indexer.Validator.getOrThrow(validator);
    t.expect({
      delegated: entity.totalDelegated,
      withdrawn: entity.totalWithdrawn,
      net: entity.netDelegated,
    }).toEqual({
      delegated: 30n * ONE_E18,
      withdrawn: 12n * ONE_E18,
      net: 18n * ONE_E18,
    });
  });
});

describe("pause registry", () => {
  it("tracks the live paused set across pause and unpause", async (t) => {
    const indexer = createTestIndexer();
    const target = STAKING_MANAGER;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "PauserRegistry",
              event: "ContractPaused",
              params: { contractAddress: target },
            },
            {
              contract: "PauserRegistry",
              event: "ContractUnpaused",
              params: { contractAddress: target },
            },
          ],
        },
      },
    });

    const pausable = await indexer.PausableContract.getOrThrow(target);
    t.expect({
      paused: pausable.isPaused,
      pauses: pausable.pauseCount,
      unpauses: pausable.unpauseCount,
    }).toEqual({ paused: false, pauses: 1, unpauses: 1 });

    const stats = await indexer.ProtocolStats.getOrThrow(PROTOCOL_ID);
    t.expect(stats.pausedContractCount).toBe(0);
    t.expect(stats.pauseCount).toBe(1);
  });
});
