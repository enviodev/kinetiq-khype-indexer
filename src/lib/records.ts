/**
 * Writers for the event families that repeat across all seven contracts:
 * access-control grants, proxy/diamond changes, and one-off config setters.
 *
 * The diamond change alarm lives here. `StakingManager` is an EIP-2535 diamond;
 * a facet cut can add event signatures with no address change and no redeploy —
 * it already did once, adding eight. Every `Upgraded` / `DiamondCut` /
 * `FacetAdded` lands in `ProtocolChangeEvent` so the day it happens again is
 * queryable, rather than being discovered when a chart quietly goes flat.
 */
import type { EvmOnEventContext, ProtocolChangeEvent } from "envio";
import { contractName, logId } from "./constants.js";
import { updateStats } from "./state.js";

type Ctx = EvmOnEventContext;

/** The subset of an event object these writers need. */
export type EventMeta = {
  readonly chainId: number;
  readonly srcAddress: string;
  readonly logIndex: number;
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string };
};

export function recordProtocolChange(
  context: Ctx,
  event: EventMeta,
  kind: ProtocolChangeEvent["kind"],
  extra: {
    implementation?: string;
    facet?: string;
    selectorCount?: number;
    detail?: string;
  } = {},
): void {
  context.ProtocolChangeEvent.set({
    id: logId(event),
    contractAddress: event.srcAddress,
    contractName: contractName(event.srcAddress),
    kind,
    implementation: extra.implementation,
    facet: extra.facet,
    selectorCount: extra.selectorCount,
    detail: extra.detail,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
}

/** `Upgraded` — also bumps the protocol-wide upgrade counter. */
export async function recordUpgrade(
  context: Ctx,
  event: EventMeta,
  implementation: string,
): Promise<void> {
  recordProtocolChange(context, event, "Upgraded", { implementation });
  await updateStats(context, event.block, (s) => ({
    ...s,
    upgradeCount: s.upgradeCount + 1,
  }));
}

export function recordConfigChange(
  context: Ctx,
  event: EventMeta,
  setting: string,
  newValue: string,
  oldValue?: string,
): void {
  context.ConfigChangeEvent.set({
    id: logId(event),
    contractAddress: event.srcAddress,
    contractName: contractName(event.srcAddress),
    setting,
    oldValue,
    newValue,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
}

/**
 * `RoleGranted` / `RoleRevoked`. Keyed on (contract, role, account) so the row is
 * the current state of that assignment; grant/revoke counts keep the history
 * legible without a row per log.
 */
export async function recordRole(
  context: Ctx,
  event: EventMeta,
  role: string,
  account: string,
  granted: boolean,
): Promise<void> {
  const id = `${event.srcAddress}-${role}-${account}`;
  const existing = await context.RoleAssignment.get(id);
  const base = existing ?? {
    id,
    contractAddress: event.srcAddress,
    contractName: contractName(event.srcAddress),
    role,
    account,
    isActive: false,
    grantCount: 0,
    revokeCount: 0,
    grantedBlock: undefined,
    revokedBlock: undefined,
    lastBlock: BigInt(event.block.number),
  };
  context.RoleAssignment.set({
    ...base,
    isActive: granted,
    grantCount: base.grantCount + (granted ? 1 : 0),
    revokeCount: base.revokeCount + (granted ? 0 : 1),
    grantedBlock: granted ? BigInt(event.block.number) : base.grantedBlock,
    revokedBlock: granted ? base.revokedBlock : BigInt(event.block.number),
    lastBlock: BigInt(event.block.number),
  });
}
