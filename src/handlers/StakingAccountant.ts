/**
 * StakingAccountant — 0x9209648Ec9D448EF57116B73A2f081835643dc7A
 *
 * The protocol's own accounting. Both accumulators are single-line increments in
 * the contract (`totalStaked += amount; emit StakeRecorded(...)`), so the running
 * sums here are exactly the values `totalStaked()` and `totalClaimed()` return —
 * which is what makes the replayed exchange rate checkable to the wei.
 */
import { indexer } from "envio";
import {
  recordConfigChange,
  recordProtocolChange,
  recordRole,
  recordUpgrade,
} from "../lib/records.js";
import { updateStats } from "../lib/state.js";

indexer.onEvent(
  { contract: "StakingAccountant", event: "StakeRecorded" },
  async ({ event, context }) => {
    await updateStats(
      context,
      event.block,
      (s) => ({
        ...s,
        totalStaked: s.totalStaked + event.params.amount,
        stakeRecordedCount: s.stakeRecordedCount + 1,
      }),
      { snapshot: true },
    );
  },
);

indexer.onEvent(
  { contract: "StakingAccountant", event: "ClaimRecorded" },
  async ({ event, context }) => {
    await updateStats(
      context,
      event.block,
      (s) => ({
        ...s,
        totalClaimed: s.totalClaimed + event.params.amount,
        claimRecordedCount: s.claimRecordedCount + 1,
      }),
      { snapshot: true },
    );
  },
);

indexer.onEvent(
  { contract: "StakingAccountant", event: "StakingManagerAuthorized" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "authorizedManager",
      `${event.params.manager} (token ${event.params.token})`,
    );
  },
);

indexer.onEvent(
  { contract: "StakingAccountant", event: "RoleGranted" },
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
  { contract: "StakingAccountant", event: "RoleRevoked" },
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
  { contract: "StakingAccountant", event: "Upgraded" },
  async ({ event, context }) => {
    await recordUpgrade(context, event, event.params.implementation);
  },
);

indexer.onEvent(
  { contract: "StakingAccountant", event: "AdminChanged" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "AdminChanged", {
      detail: `${event.params.previousAdmin} -> ${event.params.newAdmin}`,
    });
  },
);

indexer.onEvent(
  { contract: "StakingAccountant", event: "Initialized" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "Initialized", {
      detail: `version ${event.params.version}`,
    });
  },
);
