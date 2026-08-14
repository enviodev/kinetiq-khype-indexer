/**
 * ValidatorManager — 0x4b797A93DfC3D18Cf98B7322a2b142FA8007508f
 *
 * Validator lifecycle plus the reward/slashing accumulators. Σ RewardEventReported
 * equals `totalRewards()` and Σ SlashingEventReported equals `totalSlashing()`,
 * which is currently 0 — SlashingEventReported has never fired. It is registered
 * anyway: it is a live code path, and the first slash in the protocol's history is
 * exactly the event you do not want to be missing a handler for.
 */
import { indexer } from "envio";
import { logId } from "../lib/constants.js";
import {
  recordConfigChange,
  recordProtocolChange,
  recordRole,
  recordUpgrade,
} from "../lib/records.js";
import { loadValidator, updateDay, updateStats } from "../lib/state.js";

indexer.onEvent(
  { contract: "ValidatorManager", event: "ValidatorActivated" },
  async ({ event, context }) => {
    const { validator } = event.params;
    const block = event.block;
    const entity = await loadValidator(context, validator, block);
    const wasActive = entity.isActive;

    context.Validator.set({
      ...entity,
      isActive: true,
      activatedBlock: BigInt(block.number),
      activationCount: entity.activationCount + 1,
    });

    if (!wasActive) {
      await updateStats(context, block, (s) => ({
        ...s,
        activeValidatorCount: s.activeValidatorCount + 1,
      }));
    }
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "ValidatorDeactivated" },
  async ({ event, context }) => {
    const { validator } = event.params;
    const block = event.block;
    const entity = await loadValidator(context, validator, block);
    const wasActive = entity.isActive;

    context.Validator.set({
      ...entity,
      isActive: false,
      deactivatedBlock: BigInt(block.number),
      deactivationCount: entity.deactivationCount + 1,
    });

    if (wasActive) {
      await updateStats(context, block, (s) => ({
        ...s,
        activeValidatorCount: s.activeValidatorCount - 1,
      }));
    }
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "RewardEventReported" },
  async ({ event, context }) => {
    const { validator, amount } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      totalRewards: entity.totalRewards + amount,
      rewardEventCount: entity.rewardEventCount + 1,
    });

    context.ValidatorRewardEvent.set({
      id: logId(event),
      validator_id: validator,
      kind: "Reward",
      amount,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
    });

    await updateStats(
      context,
      block,
      (s) => ({
        ...s,
        totalRewards: s.totalRewards + amount,
        rewardEventReportedCount: s.rewardEventReportedCount + 1,
      }),
      { snapshot: true },
    );

    await updateDay(context, block, (d) => ({
      ...d,
      rewardsReported: d.rewardsReported + amount,
    }));
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "SlashingEventReported" },
  async ({ event, context }) => {
    const { validator, amount } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      totalSlashing: entity.totalSlashing + amount,
      slashingEventCount: entity.slashingEventCount + 1,
    });

    context.ValidatorRewardEvent.set({
      id: logId(event),
      validator_id: validator,
      kind: "Slashing",
      amount,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
    });

    await updateStats(
      context,
      block,
      (s) => ({
        ...s,
        totalSlashing: s.totalSlashing + amount,
        slashingEventReportedCount: s.slashingEventReportedCount + 1,
      }),
      { snapshot: true },
    );
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "ValidatorPerformanceUpdated" },
  async ({ event, context }) => {
    const { validator, timestamp, blockNumber } = event.params;
    const block = event.block;

    const entity = await loadValidator(context, validator, block);
    context.Validator.set({
      ...entity,
      performanceUpdateCount: entity.performanceUpdateCount + 1,
      lastPerformanceTimestamp: timestamp,
    });

    context.ValidatorPerformanceReport.set({
      id: logId(event),
      validator_id: validator,
      reportedTimestamp: timestamp,
      reportedBlockNumber: blockNumber,
      blockNumber: BigInt(block.number),
      timestamp: BigInt(block.timestamp),
    });

    await updateStats(context, block, (s) => ({
      ...s,
      validatorPerformanceUpdatedCount: s.validatorPerformanceUpdatedCount + 1,
    }));
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "DelegationUpdated" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      `delegation:${event.params.stakingManager}`,
      event.params.newDelegation,
      event.params.oldDelegation,
    );
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "RoleGranted" },
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
  { contract: "ValidatorManager", event: "RoleRevoked" },
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
  { contract: "ValidatorManager", event: "Upgraded" },
  async ({ event, context }) => {
    await recordUpgrade(context, event, event.params.implementation);
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "AdminChanged" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "AdminChanged", {
      detail: `${event.params.previousAdmin} -> ${event.params.newAdmin}`,
    });
  },
);

indexer.onEvent(
  { contract: "ValidatorManager", event: "Initialized" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "Initialized", {
      detail: `version ${event.params.version}`,
    });
  },
);
