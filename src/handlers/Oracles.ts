/**
 * OracleManager  — 0x192826e470bd65FDC2CB472eDd834D096233049b
 * DefaultOracle  — 0xefbcCc6E33DA1C1ef638cBc0F044968D0f590fED
 *
 * DefaultOracle.MetricsUpdated is the raw StakeHub feed: per-validator balance,
 * performance score, reward and slashing, 6,954 snapshots. Kinetiq's docs say
 * validator scores are "published on-chain and auditable" — this event is the only
 * place that history exists, and nothing queryable exposes it today.
 *
 * OracleManager.ValidatorBehaviorCheckFailed has a dead tail on purpose: it last
 * fired at block 14,213,280 (~2025-09). The signature did not change; the sanity
 * checker behind it was replaced. Expect zero recent rows and do not read that as
 * a decode failure.
 */
import { indexer } from "envio";
import { logId } from "../lib/constants.js";
import {
  recordConfigChange,
  recordProtocolChange,
  recordRole,
  recordUpgrade,
} from "../lib/records.js";
import { loadValidator, updateStats } from "../lib/state.js";

// ---------------------------------------------------------------------------
// DefaultOracle
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "DefaultOracle", event: "MetricsUpdated" },
  async ({ event, context }) => {
    const { validator, balance, performanceScore, reward, slashing, endBlock } =
      event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      lastReportedBalance: balance,
      lastPerformanceScore: performanceScore,
      lastReportedReward: reward,
      lastReportedSlashing: slashing,
      lastMetricsBlock: BigInt(block.number),
      metricsCount: entity.metricsCount + 1,
    });

    context.ValidatorMetricsSnapshot.set({
      id: logId(event),
      validator_id: validator,
      balance,
      performanceScore,
      reward,
      slashing,
      endBlock,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
    });

    await updateStats(context, block, (s) => ({
      ...s,
      metricsUpdatedCount: s.metricsUpdatedCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "DefaultOracle", event: "RoleGranted" },
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
  { contract: "DefaultOracle", event: "RoleRevoked" },
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

// ---------------------------------------------------------------------------
// OracleManager
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "OracleManager", event: "PerformanceUpdated" },
  async ({ event, context }) => {
    const { validator, timestamp } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({ ...entity, lastPerformanceTimestamp: timestamp });

    await updateStats(context, block, (s) => ({
      ...s,
      performanceUpdatedCount: s.performanceUpdatedCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "ValidatorBehaviorCheckFailed" },
  async ({ event, context }) => {
    const { validator, reason } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      behaviorCheckFailureCount: entity.behaviorCheckFailureCount + 1,
      lastBehaviorFailureReason: reason,
    });

    context.ValidatorBehaviorFailure.set({
      id: logId(event),
      validator_id: validator,
      reason,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
    });

    await updateStats(context, block, (s) => ({
      ...s,
      behaviorCheckFailedCount: s.behaviorCheckFailedCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "SanityCheckerUpdated" },
  async ({ event, context }) => {
    recordConfigChange(context, event, "sanityChecker", event.params.newChecker);
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "OracleAuthorized" },
  async ({ event, context }) => {
    recordConfigChange(context, event, "oracleAuthorized", event.params.oracle);
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "OracleActiveStateChanged" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      `oracleActive:${event.params.oracle}`,
      String(event.params.active),
    );
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "StakingManagerUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "stakingManager",
      event.params.newStakingManager,
    );
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "RewardShareTrackerUpdated" },
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
  { contract: "OracleManager", event: "RoleGranted" },
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
  { contract: "OracleManager", event: "RoleRevoked" },
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

indexer.onEvent(
  { contract: "OracleManager", event: "Upgraded" },
  async ({ event, context }) => {
    await recordUpgrade(context, event, event.params.implementation);
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "AdminChanged" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "AdminChanged", {
      detail: `${event.params.previousAdmin} -> ${event.params.newAdmin}`,
    });
  },
);

indexer.onEvent(
  { contract: "OracleManager", event: "Initialized" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "Initialized", {
      detail: `version ${event.params.version}`,
    });
  },
);
