/**
 * StakingManager — 0x393D0B87Ed38fc779FD9611144aE649BA6082109
 *
 * An EIP-2535 diamond since block 31,872,097. The cut was additive: no existing
 * signature changed topic0, so a genesis-start indexer using today's signatures
 * recovers the whole history. Eight signatures only exist after the cut and are
 * marked as such in config.yaml.
 *
 * Two lifecycle entities here have terminal states that a late or duplicate event
 * must never roll back — see `WithdrawalConfirmed` and `RewardDistributionCompleted`.
 */
import { indexer } from "envio";
import { logId, padded } from "../lib/constants.js";
import {
  recordConfigChange,
  recordProtocolChange,
  recordRole,
  recordUpgrade,
} from "../lib/records.js";
import {
  loadStaker,
  loadValidator,
  updateDay,
  updateStats,
} from "../lib/state.js";

// ---------------------------------------------------------------------------
// Staking
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "StakeReceived" },
  async ({ event, context }) => {
    const { staker, amount } = event.params;
    const block = event.block;

    const entity = await loadStaker(context, staker, block);
    context.Staker.set({
      ...entity,
      totalStaked: entity.totalStaked + amount,
      stakeCount: entity.stakeCount + 1,
    });

    context.StakeEvent.set({
      id: logId(event),
      staker_id: staker,
      amount,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    // Note: totalStaked on ProtocolStats is driven by StakingAccountant's
    // StakeRecorded, not by this event — that is the accumulator the contract
    // itself exposes, and the two counts must come out equal.
    await updateStats(context, block, (s) => ({
      ...s,
      stakeReceivedCount: s.stakeReceivedCount + 1,
      totalStakeReceived: s.totalStakeReceived + amount,
    }));

    await updateDay(context, block, (d) => ({
      ...d,
      stakeCount: d.stakeCount + 1,
      stakeVolume: d.stakeVolume + amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "WithdrawalQueued" },
  async ({ event, context }) => {
    const { user, withdrawalId, kHYPEAmount, hypeAmount, feeAmount } =
      event.params;
    const block = event.block;

    // withdrawalId is a PER-USER nonce — two different users both hold id 0 —
    // so the key has to carry the user or every user's queue collapses onto one
    // another's rows.
    const id = `${user}-${withdrawalId}`;
    const existing = await context.WithdrawalRequest.get(id);

    const staker = await loadStaker(context, user, block);
    context.Staker.set({
      ...staker,
      totalWithdrawalRequestedKHype:
        staker.totalWithdrawalRequestedKHype + kHYPEAmount,
      withdrawalRequestCount: staker.withdrawalRequestCount + 1,
    });

    if (existing === undefined) {
      context.WithdrawalRequest.set({
        id,
        withdrawalId,
        user_id: user,
        status: "Queued",
        kHypeAmount: kHYPEAmount,
        hypeAmount,
        feeAmount,
        queuedBlock: BigInt(block.number),
        queuedTimestamp: BigInt(block.timestamp),
        queuedTxHash: event.transaction.hash,
        confirmedAmount: undefined,
        confirmedBlock: undefined,
        confirmedTimestamp: undefined,
        confirmedTxHash: undefined,
        latencyBlocks: undefined,
        latencySeconds: undefined,
        confirmationCount: 0,
        queueEventCount: 1,
      });
    } else {
      // A repeat queue for a nonce we have already seen. Whatever it means, it
      // must not overwrite a settled request: record that it happened and leave
      // the existing row's terminal state alone.
      context.log.warn(
        `duplicate WithdrawalQueued for ${id} (status ${existing.status}) at block ${block.number}`,
      );
      context.WithdrawalRequest.set({
        ...existing,
        queueEventCount: existing.queueEventCount + 1,
      });
    }

    await updateStats(context, block, (s) => ({
      ...s,
      withdrawalQueuedCount: s.withdrawalQueuedCount + 1,
      totalWithdrawalQueuedKHype: s.totalWithdrawalQueuedKHype + kHYPEAmount,
      totalWithdrawalQueuedHype: s.totalWithdrawalQueuedHype + hypeAmount,
      totalWithdrawalFees: s.totalWithdrawalFees + feeAmount,
      pendingWithdrawalCount:
        s.pendingWithdrawalCount + (existing === undefined ? 1 : 0),
      pendingWithdrawalKHype:
        s.pendingWithdrawalKHype + (existing === undefined ? kHYPEAmount : 0n),
    }));

    await updateDay(context, block, (d) => ({
      ...d,
      withdrawalQueuedCount: d.withdrawalQueuedCount + 1,
      withdrawalQueuedVolume: d.withdrawalQueuedVolume + kHYPEAmount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "WithdrawalConfirmed" },
  async ({ event, context }) => {
    const { user, withdrawalId, amount } = event.params;
    const block = event.block;
    const id = `${user}-${withdrawalId}`;
    const existing = await context.WithdrawalRequest.get(id);

    const staker = await loadStaker(context, user, block);
    context.Staker.set({
      ...staker,
      withdrawalConfirmedCount: staker.withdrawalConfirmedCount + 1,
      totalWithdrawalConfirmed: staker.totalWithdrawalConfirmed + amount,
    });

    // Confirmed is terminal. Reconcile rather than set: a duplicate finalisation
    // is counted and otherwise ignored, so it can never rewrite the settlement
    // block, latency or amount of the confirmation that actually settled.
    const alreadyConfirmed = existing?.status === "Confirmed";

    if (existing === undefined) {
      // Confirmation with no queue row on file. Record what the event carries and
      // leave the queue-side fields pointing at this block so nothing is invented.
      context.log.warn(
        `WithdrawalConfirmed with no queued request: ${id} at block ${block.number}`,
      );
      context.WithdrawalRequest.set({
        id,
        withdrawalId,
        user_id: user,
        status: "Confirmed",
        kHypeAmount: 0n,
        hypeAmount: 0n,
        feeAmount: 0n,
        queuedBlock: BigInt(block.number),
        queuedTimestamp: BigInt(block.timestamp),
        queuedTxHash: event.transaction.hash,
        confirmedAmount: amount,
        confirmedBlock: BigInt(block.number),
        confirmedTimestamp: BigInt(block.timestamp),
        confirmedTxHash: event.transaction.hash,
        latencyBlocks: 0n,
        latencySeconds: 0n,
        confirmationCount: 1,
        queueEventCount: 0,
      });
    } else if (alreadyConfirmed) {
      context.WithdrawalRequest.set({
        ...existing,
        confirmationCount: existing.confirmationCount + 1,
      });
    } else {
      context.WithdrawalRequest.set({
        ...existing,
        status: "Confirmed",
        confirmedAmount: amount,
        confirmedBlock: BigInt(block.number),
        confirmedTimestamp: BigInt(block.timestamp),
        confirmedTxHash: event.transaction.hash,
        latencyBlocks: BigInt(block.number) - existing.queuedBlock,
        latencySeconds: BigInt(block.timestamp) - existing.queuedTimestamp,
        confirmationCount: existing.confirmationCount + 1,
      });
    }

    const settledNow = !alreadyConfirmed && existing !== undefined;
    await updateStats(context, block, (s) => ({
      ...s,
      withdrawalConfirmedCount: s.withdrawalConfirmedCount + 1,
      totalWithdrawalConfirmed: s.totalWithdrawalConfirmed + amount,
      pendingWithdrawalCount: s.pendingWithdrawalCount - (settledNow ? 1 : 0),
      pendingWithdrawalKHype:
        s.pendingWithdrawalKHype - (settledNow ? existing.kHypeAmount : 0n),
    }));

    await updateDay(context, block, (d) => ({
      ...d,
      withdrawalConfirmedCount: d.withdrawalConfirmedCount + 1,
      withdrawalConfirmedVolume: d.withdrawalConfirmedVolume + amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "InstantUnstakeExecuted" },
  async ({ event, context }) => {
    const {
      user,
      kHYPEAmount,
      hypeReceived,
      kHYPEFee,
      feeRateBps,
      kHYPEFeeBurned,
      kHYPEFeeToTreasury,
    } = event.params;
    const block = event.block;

    const staker = await loadStaker(context, user, block);
    context.Staker.set({
      ...staker,
      totalInstantUnstakedKHype: staker.totalInstantUnstakedKHype + kHYPEAmount,
      instantUnstakeCount: staker.instantUnstakeCount + 1,
    });

    context.InstantUnstake.set({
      id: logId(event),
      user_id: user,
      kHypeAmount: kHYPEAmount,
      hypeReceived,
      kHypeFee: kHYPEFee,
      feeRateBps,
      kHypeFeeBurned: kHYPEFeeBurned,
      kHypeFeeToTreasury: kHYPEFeeToTreasury,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      instantUnstakeCount: s.instantUnstakeCount + 1,
      totalInstantUnstakeKHype: s.totalInstantUnstakeKHype + kHYPEAmount,
      totalInstantUnstakeHypeOut: s.totalInstantUnstakeHypeOut + hypeReceived,
      totalInstantUnstakeFee: s.totalInstantUnstakeFee + kHYPEFee,
      totalInstantUnstakeFeeBurned:
        s.totalInstantUnstakeFeeBurned + kHYPEFeeBurned,
      totalInstantUnstakeFeeTreasury:
        s.totalInstantUnstakeFeeTreasury + kHYPEFeeToTreasury,
    }));

    await updateDay(context, block, (d) => ({
      ...d,
      instantUnstakeCount: d.instantUnstakeCount + 1,
      instantUnstakeVolume: d.instantUnstakeVolume + kHYPEAmount,
    }));
  },
);

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "Delegate" },
  async ({ event, context }) => {
    const { validator, amount } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      totalDelegated: entity.totalDelegated + amount,
      netDelegated: entity.netDelegated + amount,
      delegateCount: entity.delegateCount + 1,
    });

    context.DelegationEvent.set({
      id: logId(event),
      action: "Delegate",
      validator_id: validator,
      counterpartyValidator: undefined,
      user: undefined,
      amount,
      operationType: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      delegateCount: s.delegateCount + 1,
      totalDelegated: s.totalDelegated + amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "ValidatorWithdrawal" },
  async ({ event, context }) => {
    const { validator, amount } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      totalWithdrawn: entity.totalWithdrawn + amount,
      netDelegated: entity.netDelegated - amount,
      withdrawalCount: entity.withdrawalCount + 1,
    });

    context.DelegationEvent.set({
      id: logId(event),
      action: "ValidatorWithdrawal",
      validator_id: validator,
      counterpartyValidator: undefined,
      user: undefined,
      amount,
      operationType: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      validatorWithdrawalCount: s.validatorWithdrawalCount + 1,
      totalValidatorWithdrawn: s.totalValidatorWithdrawn + amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "L1DelegationQueued" },
  async ({ event, context }) => {
    const { validator, amount, operationType } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set(entity);

    context.DelegationEvent.set({
      id: logId(event),
      action: "L1DelegationQueued",
      validator_id: validator,
      counterpartyValidator: undefined,
      user: undefined,
      amount,
      operationType: Number(operationType),
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      l1DelegationQueuedCount: s.l1DelegationQueuedCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "L1DelegationProcessed" },
  async ({ event, context }) => {
    const { validator, amount, operationType } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set(entity);

    context.DelegationEvent.set({
      id: logId(event),
      action: "L1DelegationProcessed",
      validator_id: validator,
      counterpartyValidator: undefined,
      user: undefined,
      amount,
      operationType: Number(operationType),
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      l1DelegationProcessedCount: s.l1DelegationProcessedCount + 1,
    }));
  },
);

/**
 * UNVERIFIED SEMANTICS. The signature
 * `RedelegationRequested(address,address,address,uint256,uint256,uint256)` is
 * keccak-confirmed against the observed topic0, but no Kinetiq source declares
 * this event, so the parameter *names* are recovered, not documented.
 *
 * What is evidenced from the logs themselves: all three addresses are indexed;
 * the first is disjoint from the validator set on every sample and varies per
 * caller (a user), while the second and third are members of the known validator
 * set. The from → to direction is inferred from that, not documented.
 *
 * The three uint256s are deliberately left as amount0/1/2 and are NOT applied to
 * any validator's delegated balance — guessing which one is the moved stake would
 * silently corrupt `netDelegated`, which does reconcile. They are stored verbatim
 * so the meaning can be settled later without a resync.
 */
indexer.onEvent(
  { contract: "StakingManager", event: "RedelegationRequested" },
  async ({ event, context }) => {
    const { user, fromValidator, toValidator, amount0 } = event.params;
    const block = event.block;

    const from = await loadValidator(context, fromValidator, block);
    context.Validator.set({
      ...from,
      redelegationsOut: from.redelegationsOut + 1,
    });
    const to = await loadValidator(context, toValidator, block);
    context.Validator.set({ ...to, redelegationsIn: to.redelegationsIn + 1 });

    const base = logId(event);
    context.DelegationEvent.set({
      id: `${base}_out`,
      action: "RedelegationOut",
      validator_id: fromValidator,
      counterpartyValidator: toValidator,
      user,
      amount: amount0,
      operationType: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });
    context.DelegationEvent.set({
      id: `${base}_in`,
      action: "RedelegationIn",
      validator_id: toValidator,
      counterpartyValidator: fromValidator,
      user,
      amount: amount0,
      operationType: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      redelegationCount: s.redelegationCount + 1,
    }));
  },
);

// ---------------------------------------------------------------------------
// HyperCore (L1) operations
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "L1OperationAggregated" },
  async ({ event, context }) => {
    const { validator, addedAmount, newTotalAmount, operationType } =
      event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({ ...entity, l1PendingAmount: newTotalAmount });

    context.L1Operation.set({
      id: logId(event),
      validator_id: validator,
      addedAmount,
      newTotalAmount,
      operationType: Number(operationType),
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });

    await updateStats(context, block, (s) => ({
      ...s,
      l1OperationAggregatedCount: s.l1OperationAggregatedCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "L1OperationsQueued" },
  async ({ event, context }) => {
    const { validators, amounts } = event.params;
    const block = event.block;
    const totalAmount = amounts.reduce((sum, a) => sum + a, 0n);

    context.L1OperationBatch.set({
      id: logId(event),
      kind: "Queued",
      validatorCount: validators.length,
      totalAmount,
      processedCount: undefined,
      remainingCount: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "L1OperationsBatchProcessed" },
  async ({ event, context }) => {
    const { processedCount, remainingCount } = event.params;
    const block = event.block;

    context.L1OperationBatch.set({
      id: logId(event),
      kind: "Processed",
      validatorCount: 0,
      totalAmount: 0n,
      processedCount,
      remainingCount,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });
  },
);

// ---------------------------------------------------------------------------
// Treasury / buffer movements
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "SpotWithdrawn" },
  async ({ event, context }) => {
    const block = event.block;
    context.TreasuryMovement.set({
      id: logId(event),
      kind: "SpotWithdrawn",
      amount: event.params.amount,
      rebalanceId: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });
    await updateStats(context, block, (s) => ({
      ...s,
      totalSpotWithdrawn: s.totalSpotWithdrawn + event.params.amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "BufferRebalanceWithdrawal" },
  async ({ event, context }) => {
    const block = event.block;
    context.TreasuryMovement.set({
      id: logId(event),
      kind: "BufferRebalanceWithdrawal",
      amount: event.params.amount,
      rebalanceId: undefined,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });
    await updateStats(context, block, (s) => ({
      ...s,
      totalBufferRebalanced: s.totalBufferRebalanced + event.params.amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "BufferRebalanceCompleted" },
  async ({ event, context }) => {
    const block = event.block;
    context.TreasuryMovement.set({
      id: logId(event),
      kind: "BufferRebalanceCompleted",
      amount: event.params.amount,
      rebalanceId: event.params.rebalanceId,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      txHash: event.transaction.hash,
    });
  },
);

// ---------------------------------------------------------------------------
// Reward distribution (post-cut only)
//
// THE TRAP: the currently verified source declares a six-parameter
// RewardDistributionQueued whose topic0 has never appeared on chain. The
// three-parameter form registered in config.yaml is what actually fires, 1,532
// times. An indexer generated from Kinetiq's own ABI produces zero rows here and
// looks correct doing it.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "RewardDistributionQueued" },
  async ({ event, context }) => {
    const { distributionId, validator, amount } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      rewardDistributionCount: entity.rewardDistributionCount + 1,
      totalRewardDistributionQueued:
        entity.totalRewardDistributionQueued + amount,
    });

    const id = padded(distributionId);
    const existing = await context.RewardDistribution.get(id);
    if (existing === undefined) {
      context.RewardDistribution.set({
        id,
        distributionId,
        validator_id: validator,
        amount,
        rewardShare: undefined,
        status: "Queued",
        queuedBlock: BigInt(block.number),
        queuedTimestamp: BigInt(block.timestamp),
        completedBlock: undefined,
        completedTimestamp: undefined,
        completionCount: 0,
        queueEventCount: 1,
      });
    } else {
      // Completed is terminal; a re-queue of a settled id is recorded, not applied.
      context.RewardDistribution.set({
        ...existing,
        queueEventCount: existing.queueEventCount + 1,
      });
    }

    await updateStats(context, block, (s) => ({
      ...s,
      rewardDistributionQueuedCount: s.rewardDistributionQueuedCount + 1,
      totalRewardDistributionQueued: s.totalRewardDistributionQueued + amount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "RewardDistributionCompleted" },
  async ({ event, context }) => {
    const { distributionId, rewardShare } = event.params;
    const block = event.block;
    const id = padded(distributionId);
    const existing = await context.RewardDistribution.get(id);

    if (existing === undefined) {
      context.log.warn(
        `RewardDistributionCompleted with no queued distribution: ${id} at block ${block.number}`,
      );
      context.RewardDistribution.set({
        id,
        distributionId,
        validator_id: undefined,
        amount: 0n,
        rewardShare,
        status: "Completed",
        queuedBlock: undefined,
        queuedTimestamp: undefined,
        completedBlock: BigInt(block.number),
        completedTimestamp: BigInt(block.timestamp),
        completionCount: 1,
        queueEventCount: 0,
      });
    } else if (existing.status === "Completed") {
      context.RewardDistribution.set({
        ...existing,
        completionCount: existing.completionCount + 1,
      });
    } else {
      context.RewardDistribution.set({
        ...existing,
        status: "Completed",
        rewardShare,
        completedBlock: BigInt(block.number),
        completedTimestamp: BigInt(block.timestamp),
        completionCount: existing.completionCount + 1,
      });
    }

    await updateStats(context, block, (s) => ({
      ...s,
      rewardDistributionCompletedCount: s.rewardDistributionCompletedCount + 1,
    }));
  },
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "AddressWhitelisted" },
  async ({ event, context }) => {
    recordConfigChange(context, event, "whitelisted", event.params.account);
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "WhitelistEnabled" },
  async ({ event, context }) => {
    recordConfigChange(context, event, "whitelistEnabled", "true");
    await updateStats(context, event.block, (s) => ({
      ...s,
      whitelistEnabled: true,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "WhitelistDisabled" },
  async ({ event, context }) => {
    recordConfigChange(context, event, "whitelistEnabled", "false");
    await updateStats(context, event.block, (s) => ({
      ...s,
      whitelistEnabled: false,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "MinStakeAmountUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "minStakeAmount",
      event.params.newMinStakeAmount.toString(),
    );
    await updateStats(context, event.block, (s) => ({
      ...s,
      minStakeAmount: event.params.newMinStakeAmount,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "UnstakeFeeRateUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "unstakeFeeRate",
      event.params.newRate.toString(),
    );
    await updateStats(context, event.block, (s) => ({
      ...s,
      unstakeFeeRateBps: event.params.newRate,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "QuickWithdrawalDelayUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "quickWithdrawalDelay",
      event.params.newDelay.toString(),
    );
    await updateStats(context, event.block, (s) => ({
      ...s,
      quickWithdrawalDelay: event.params.newDelay,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "TreasuryUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "treasury",
      event.params.newTreasury,
      event.params.oldTreasury,
    );
    await updateStats(context, event.block, (s) => ({
      ...s,
      treasury: event.params.newTreasury,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "OracleManagerUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "oracleManager",
      event.params.oracleManager,
    );
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "RewardShareTrackerUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "rewardShareTracker",
      event.params.newRewardShareTracker,
    );
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "InstantUnstakePoolUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "instantUnstakePool",
      event.params.poolAddress,
    );
  },
);

// ---------------------------------------------------------------------------
// Diamond / proxy change alarm
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "StakingManager", event: "DiamondCut" },
  async ({ event, context }) => {
    const cuts = event.params.facetCuts;
    const selectorCount = cuts.reduce((n, c) => n + c.selectors.length, 0);
    recordProtocolChange(context, event, "DiamondCut", {
      selectorCount,
      detail: cuts
        .map((c) => `${c.facet}:action=${c.action}:${c.selectors.length}sel`)
        .join(","),
    });
    await updateStats(context, event.block, (s) => ({
      ...s,
      diamondCutCount: s.diamondCutCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "FacetAdded" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "FacetAdded", {
      facet: event.params.facet,
      selectorCount: event.params.selectors.length,
    });
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "FacetRegistrySet" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "FacetRegistrySet", {
      detail: `${event.params.oldRegistry} -> ${event.params.newRegistry}`,
    });
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "Upgraded" },
  async ({ event, context }) => {
    await recordUpgrade(context, event, event.params.implementation);
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "AdminChanged" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "AdminChanged", {
      detail: `${event.params.previousAdmin} -> ${event.params.newAdmin}`,
    });
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "Initialized" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "Initialized", {
      detail: `version ${event.params.version}`,
    });
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "RoleGranted" },
  async ({ event, context }) => {
    await recordRole(
      context,
      event,
      event.params.role,
      event.params.account,
      true,
    );
  },
);

indexer.onEvent(
  { contract: "StakingManager", event: "RoleRevoked" },
  async ({ event, context }) => {
    await recordRole(
      context,
      event,
      event.params.role,
      event.params.account,
      false,
    );
  },
);
