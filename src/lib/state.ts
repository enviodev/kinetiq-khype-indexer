/**
 * Shared entity accessors.
 *
 * Everything the protocol's own accounting exposes on chain is reproduced here from
 * events alone:
 *
 *   totalHypeBacking = totalStaked + totalRewards − totalClaimed − totalSlashing
 *   exchangeRate     = totalHypeBacking * 1e18 / kHYPE.totalSupply()
 *
 * which is exactly what `StakingAccountant.kHYPEToHYPE(1e18)` returns. Every handler
 * that moves one of those four accumulators — or mints/burns kHYPE — goes through
 * `updateStats` so the rate and its time series stay in lockstep with the inputs.
 */
import type {
  DailyProtocolStat,
  EvmOnEventContext,
  ProtocolStats,
  Staker,
  Validator,
} from "envio";
import {
  ONE_E18,
  PROTOCOL_ID,
  dayId,
  dayStart,
  padded,
} from "./constants.js";

type Ctx = EvmOnEventContext;
type Block = { readonly number: number; readonly timestamp: number };

function emptyStats(): ProtocolStats {
  return {
    id: PROTOCOL_ID,
    totalStaked: 0n,
    totalClaimed: 0n,
    totalRewards: 0n,
    totalSlashing: 0n,
    kHypeTotalSupply: 0n,
    totalHypeBacking: 0n,
    exchangeRate: ONE_E18,
    stakeReceivedCount: 0,
    stakeRecordedCount: 0,
    claimRecordedCount: 0,
    withdrawalQueuedCount: 0,
    withdrawalConfirmedCount: 0,
    instantUnstakeCount: 0,
    delegateCount: 0,
    validatorWithdrawalCount: 0,
    redelegationCount: 0,
    l1OperationAggregatedCount: 0,
    l1DelegationQueuedCount: 0,
    l1DelegationProcessedCount: 0,
    performanceUpdatedCount: 0,
    validatorPerformanceUpdatedCount: 0,
    metricsUpdatedCount: 0,
    rewardEventReportedCount: 0,
    slashingEventReportedCount: 0,
    rewardDistributionQueuedCount: 0,
    rewardDistributionCompletedCount: 0,
    behaviorCheckFailedCount: 0,
    pauseCount: 0,
    unpauseCount: 0,
    upgradeCount: 0,
    diamondCutCount: 0,
    totalStakeReceived: 0n,
    totalDelegated: 0n,
    totalValidatorWithdrawn: 0n,
    totalWithdrawalQueuedKHype: 0n,
    totalWithdrawalQueuedHype: 0n,
    totalWithdrawalFees: 0n,
    totalWithdrawalConfirmed: 0n,
    totalInstantUnstakeKHype: 0n,
    totalInstantUnstakeHypeOut: 0n,
    totalInstantUnstakeFee: 0n,
    totalInstantUnstakeFeeBurned: 0n,
    totalInstantUnstakeFeeTreasury: 0n,
    totalSpotWithdrawn: 0n,
    totalBufferRebalanced: 0n,
    totalRewardDistributionQueued: 0n,
    pendingWithdrawalCount: 0,
    pendingWithdrawalKHype: 0n,
    validatorCount: 0,
    activeValidatorCount: 0,
    stakerCount: 0,
    pausedContractCount: 0,
    whitelistEnabled: false,
    minStakeAmount: 0n,
    unstakeFeeRateBps: 0n,
    quickWithdrawalDelay: 0n,
    treasury: undefined,
    lastBlock: 0n,
    lastTimestamp: 0n,
  };
}

/** kHYPE → HYPE, scaled 1e18. Matches StakingAccountant.kHYPEToHYPE(1e18). */
export function exchangeRate(backing: bigint, totalSupply: bigint): bigint {
  if (totalSupply <= 0n) return ONE_E18;
  return (backing * ONE_E18) / totalSupply;
}

/**
 * Read the singleton, apply `mutate`, recompute the derived accounting, and write
 * it back. Pass `snapshot: true` when the mutation could move the exchange rate —
 * that writes one `ExchangeRateSnapshot` row for the block.
 */
export async function updateStats(
  context: Ctx,
  block: Block,
  mutate: (stats: ProtocolStats) => ProtocolStats,
  options: { snapshot?: boolean } = {},
): Promise<ProtocolStats> {
  const current = await context.ProtocolStats.getOrCreate(emptyStats());
  const mutated = mutate({ ...current });

  const totalHypeBacking =
    mutated.totalStaked +
    mutated.totalRewards -
    mutated.totalClaimed -
    mutated.totalSlashing;

  const next: ProtocolStats = {
    ...mutated,
    totalHypeBacking,
    exchangeRate: exchangeRate(totalHypeBacking, mutated.kHypeTotalSupply),
    lastBlock: BigInt(block.number),
    lastTimestamp: BigInt(block.timestamp),
  };
  context.ProtocolStats.set(next);

  if (options.snapshot) {
    context.ExchangeRateSnapshot.set({
      id: padded(block.number),
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
      exchangeRate: next.exchangeRate,
      totalHypeBacking: next.totalHypeBacking,
      totalSupply: next.kHypeTotalSupply,
      totalStaked: next.totalStaked,
      totalClaimed: next.totalClaimed,
      totalRewards: next.totalRewards,
      totalSlashing: next.totalSlashing,
    });
  }

  await closeDay(context, block, next);
  return next;
}

function emptyDay(timestamp: number, stats: ProtocolStats): DailyProtocolStat {
  return {
    id: dayId(timestamp),
    date: dayId(timestamp),
    dayStartTimestamp: dayStart(timestamp),
    mintVolume: 0n,
    burnVolume: 0n,
    stakeCount: 0,
    stakeVolume: 0n,
    withdrawalQueuedCount: 0,
    withdrawalQueuedVolume: 0n,
    withdrawalConfirmedCount: 0,
    withdrawalConfirmedVolume: 0n,
    instantUnstakeCount: 0,
    instantUnstakeVolume: 0n,
    rewardsReported: 0n,
    exchangeRateOpen: stats.exchangeRate,
    exchangeRateClose: stats.exchangeRate,
    totalSupplyClose: stats.kHypeTotalSupply,
    totalStakedClose: stats.totalStaked,
  };
}

/** Roll the day bucket's closing values forward. */
async function closeDay(
  context: Ctx,
  block: Block,
  stats: ProtocolStats,
): Promise<void> {
  const existing = await context.DailyProtocolStat.get(dayId(block.timestamp));
  const day = existing ?? emptyDay(block.timestamp, stats);
  context.DailyProtocolStat.set({
    ...day,
    exchangeRateClose: stats.exchangeRate,
    totalSupplyClose: stats.kHypeTotalSupply,
    totalStakedClose: stats.totalStaked,
  });
}

/**
 * Apply a counter/volume patch to the current UTC day bucket. Reads the singleton
 * only when the bucket has to be created, so the hot Transfer path stays at one
 * entity read.
 */
export async function updateDay(
  context: Ctx,
  block: Block,
  mutate: (day: DailyProtocolStat) => DailyProtocolStat,
): Promise<void> {
  const existing = await context.DailyProtocolStat.get(dayId(block.timestamp));
  const day =
    existing ??
    emptyDay(
      block.timestamp,
      await context.ProtocolStats.getOrCreate(emptyStats()),
    );
  context.DailyProtocolStat.set(mutate({ ...day }));
}

function emptyValidator(id: string, block: Block): Validator {
  return {
    id,
    isActive: false,
    activatedBlock: undefined,
    deactivatedBlock: undefined,
    activationCount: 0,
    deactivationCount: 0,
    totalDelegated: 0n,
    totalWithdrawn: 0n,
    netDelegated: 0n,
    delegateCount: 0,
    withdrawalCount: 0,
    redelegationsIn: 0,
    redelegationsOut: 0,
    totalRewards: 0n,
    totalSlashing: 0n,
    rewardEventCount: 0,
    slashingEventCount: 0,
    rewardDistributionCount: 0,
    totalRewardDistributionQueued: 0n,
    lastReportedBalance: undefined,
    lastPerformanceScore: undefined,
    lastReportedReward: undefined,
    lastReportedSlashing: undefined,
    lastMetricsBlock: undefined,
    metricsCount: 0,
    performanceUpdateCount: 0,
    lastPerformanceTimestamp: undefined,
    behaviorCheckFailureCount: 0,
    lastBehaviorFailureReason: undefined,
    l1PendingAmount: 0n,
    firstSeenBlock: BigInt(block.number),
    lastActiveBlock: BigInt(block.number),
  };
}

/**
 * Load a validator, creating it (and bumping `validatorCount`) the first time the
 * address is seen. Returns a mutable copy — `set` it yourself.
 */
export async function loadValidator(
  context: Ctx,
  address: string,
  block: Block,
): Promise<Validator> {
  const existing = await context.Validator.get(address);
  if (existing !== undefined) {
    return { ...existing, lastActiveBlock: BigInt(block.number) };
  }
  const created = emptyValidator(address, block);
  context.Validator.set(created);
  await updateStats(context, block, (s) => ({
    ...s,
    validatorCount: s.validatorCount + 1,
  }));
  return { ...created };
}

function emptyStaker(id: string, block: Block): Staker {
  return {
    id,
    totalStaked: 0n,
    stakeCount: 0,
    totalWithdrawalRequestedKHype: 0n,
    withdrawalRequestCount: 0,
    withdrawalConfirmedCount: 0,
    totalWithdrawalConfirmed: 0n,
    totalInstantUnstakedKHype: 0n,
    instantUnstakeCount: 0,
    firstActionBlock: BigInt(block.number),
    lastActionBlock: BigInt(block.number),
  };
}

/** Same contract as `loadValidator`, for staker addresses. */
export async function loadStaker(
  context: Ctx,
  address: string,
  block: Block,
): Promise<Staker> {
  const existing = await context.Staker.get(address);
  if (existing !== undefined) {
    return { ...existing, lastActionBlock: BigInt(block.number) };
  }
  const created = emptyStaker(address, block);
  context.Staker.set(created);
  await updateStats(context, block, (s) => ({
    ...s,
    stakerCount: s.stakerCount + 1,
  }));
  return { ...created };
}
