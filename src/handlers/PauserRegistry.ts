/**
 * PauserRegistry — 0x752E76ea71960Da08644614E626c9F9Ff5a50547
 *
 * This is the LIVE registry, read off `kHYPE.pauserRegistry()`. Kinetiq's published
 * contracts page names a different address, which has zero bytecode and has never
 * emitted a log — an indexer built from the docs would watch a dead address and
 * report a protocol that was never paused. It was, five times.
 */
import {
  indexer,
  type EvmOnEventContext,
  type PausableContract,
} from "envio";
import { logId } from "../lib/constants.js";
import {
  recordConfigChange,
  recordProtocolChange,
  recordRole,
  recordUpgrade,
} from "../lib/records.js";
import { updateStats } from "../lib/state.js";

type Block = { readonly number: number; readonly timestamp: number };

function emptyPausable(id: string, block: Block): PausableContract {
  return {
    id,
    isPaused: false,
    pauseCount: 0,
    unpauseCount: 0,
    lastChangeBlock: BigInt(block.number),
    lastChangeTimestamp: BigInt(block.timestamp),
  };
}

async function applyPause(
  context: EvmOnEventContext,
  event: {
    readonly chainId: number;
    readonly logIndex: number;
    readonly block: Block;
    readonly transaction: { readonly hash: string };
    readonly params: { readonly contractAddress: string };
  },
  paused: boolean,
): Promise<void> {
  const { contractAddress } = event.params;
  const block = event.block;
  const existing = await context.PausableContract.get(contractAddress);
  const base = existing ?? emptyPausable(contractAddress, block);
  const wasPaused = base.isPaused;

  context.PausableContract.set({
    ...base,
    isPaused: paused,
    pauseCount: base.pauseCount + (paused ? 1 : 0),
    unpauseCount: base.unpauseCount + (paused ? 0 : 1),
    lastChangeBlock: BigInt(block.number),
    lastChangeTimestamp: BigInt(block.timestamp),
  });

  context.PauseEvent.set({
    id: logId(event),
    target_id: contractAddress,
    paused,
    blockNumber: BigInt(block.number),
    timestamp: BigInt(block.timestamp),
    txHash: event.transaction.hash,
  });

  const flipped = wasPaused !== paused;
  await updateStats(context, block, (s) => ({
    ...s,
    pauseCount: s.pauseCount + (paused ? 1 : 0),
    unpauseCount: s.unpauseCount + (paused ? 0 : 1),
    pausedContractCount:
      s.pausedContractCount + (flipped ? (paused ? 1 : -1) : 0),
  }));
}

indexer.onEvent(
  { contract: "PauserRegistry", event: "ContractPaused" },
  async ({ event, context }) => {
    await applyPause(context, event, true);
  },
);

indexer.onEvent(
  { contract: "PauserRegistry", event: "ContractUnpaused" },
  async ({ event, context }) => {
    await applyPause(context, event, false);
  },
);

indexer.onEvent(
  { contract: "PauserRegistry", event: "RoleGranted" },
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
  { contract: "PauserRegistry", event: "RoleRevoked" },
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
  { contract: "PauserRegistry", event: "RoleAdminChanged" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      `roleAdmin:${event.params.role}`,
      event.params.newAdminRole,
      event.params.previousAdminRole,
    );
  },
);

indexer.onEvent(
  { contract: "PauserRegistry", event: "Upgraded" },
  async ({ event, context }) => {
    await recordUpgrade(context, event, event.params.implementation);
  },
);

indexer.onEvent(
  { contract: "PauserRegistry", event: "AdminChanged" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "AdminChanged", {
      detail: `${event.params.previousAdmin} -> ${event.params.newAdmin}`,
    });
  },
);

indexer.onEvent(
  { contract: "PauserRegistry", event: "Initialized" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "Initialized", {
      detail: `version ${event.params.version}`,
    });
  },
);
