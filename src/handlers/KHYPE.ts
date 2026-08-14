/**
 * kHYPE token — 0xfD739d4e423301CE9385c1fb8850539D657C296D
 *
 * Transfer is by far the hottest path in this indexer, so it stays allocation-light:
 * no per-transfer row is written. Supply and per-day mint/burn flow are aggregates,
 * and a multi-million-row transfer log costs storage nobody queries. Approvals
 * collapse the same way, into one current-allowance row per (owner, spender).
 *
 * Supply is derived the only way that reconciles with `kHYPE.totalSupply()`:
 * Σ Transfer(from=0).value − Σ Transfer(to=0).value.
 *
 * Deliberately NOT tracked: per-account balances, holder counts, and whole-token
 * transfer counts/volume. kHYPE is a linked spot asset, and its HyperCore->HyperEVM
 * movements arrive as system transactions that this event stream does not carry.
 * Those are always plain transfers out of the linked-spot bridge — never mints or
 * burns — so supply stays exact while a balance ledger built from these events
 * would drift (and would show impossible negative balances for accounts that were
 * credited on HyperCore and later spent on HyperEVM). A number that cannot be
 * proven is not shipped. See README "Scope of the token surface".
 */
import { indexer, type Token } from "envio";
import {
  KHYPE_DECIMALS,
  KHYPE_SYMBOL,
  isZeroAddress,
} from "../lib/constants.js";
import {
  recordConfigChange,
  recordProtocolChange,
  recordRole,
  recordUpgrade,
} from "../lib/records.js";
import { updateDay, updateStats } from "../lib/state.js";

type Block = { readonly number: number; readonly timestamp: number };

function emptyToken(id: string, block: Block): Token {
  return {
    id,
    symbol: KHYPE_SYMBOL,
    decimals: KHYPE_DECIMALS,
    totalSupply: 0n,
    totalMinted: 0n,
    totalBurned: 0n,
    mintCount: 0n,
    burnCount: 0n,
    approvalCount: 0n,
    lastBlock: BigInt(block.number),
    lastTimestamp: BigInt(block.timestamp),
  };
}

indexer.onEvent(
  { contract: "KHYPE", event: "Transfer" },
  async ({ event, context }) => {
    const { from, to, value } = event.params;
    const block = event.block;
    const minting = isZeroAddress(from);
    const burning = isZeroAddress(to);

    // A plain account->account transfer moves no supply and, since balances are
    // deliberately not tracked (see the file header), carries nothing else this
    // indexer can prove. Skip it rather than writing a count that a HyperCore
    // system transfer would silently make wrong.
    if (!minting && !burning) return;

    const supplyDelta = (minting ? value : 0n) - (burning ? value : 0n);
    const token = await context.Token.getOrCreate(
      emptyToken(event.srcAddress, block),
    );
    context.Token.set({
      ...token,
      totalSupply: token.totalSupply + supplyDelta,
      totalMinted: token.totalMinted + (minting ? value : 0n),
      totalBurned: token.totalBurned + (burning ? value : 0n),
      mintCount: token.mintCount + (minting ? 1n : 0n),
      burnCount: token.burnCount + (burning ? 1n : 0n),
      lastBlock: BigInt(block.number),
      lastTimestamp: BigInt(block.timestamp),
    });

    await updateDay(context, block, (d) => ({
      ...d,
      mintVolume: d.mintVolume + (minting ? value : 0n),
      burnVolume: d.burnVolume + (burning ? value : 0n),
    }));

    // Only a supply change can move the exchange rate, so the singleton and the
    // rate snapshot are touched on mints and burns only.
    if (supplyDelta !== 0n) {
      await updateStats(
        context,
        block,
        (s) => ({ ...s, kHypeTotalSupply: s.kHypeTotalSupply + supplyDelta }),
        { snapshot: true },
      );
    }
  },
);

indexer.onEvent(
  { contract: "KHYPE", event: "Approval" },
  async ({ event, context }) => {
    const { owner, spender, value } = event.params;
    const block = event.block;
    const id = `${owner}-${spender}`;
    const existing = await context.Allowance.get(id);
    context.Allowance.set({
      id,
      owner,
      spender,
      amount: value,
      updateCount: (existing?.updateCount ?? 0) + 1,
      lastBlock: BigInt(block.number),
      lastTimestamp: BigInt(block.timestamp),
    });

    const token = await context.Token.getOrCreate(
      emptyToken(event.srcAddress, block),
    );
    context.Token.set({
      ...token,
      approvalCount: token.approvalCount + 1n,
      lastBlock: BigInt(block.number),
      lastTimestamp: BigInt(block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "KHYPE", event: "RoleGranted" },
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
  { contract: "KHYPE", event: "RoleRevoked" },
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
  { contract: "KHYPE", event: "RoleAdminChanged" },
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
  { contract: "KHYPE", event: "HypercoreDeployerSet" },
  async ({ event, context }) => {
    recordConfigChange(
      context,
      event,
      "hypercoreDeployer",
      event.params.deployer,
    );
  },
);

indexer.onEvent(
  { contract: "KHYPE", event: "Upgraded" },
  async ({ event, context }) => {
    await recordUpgrade(context, event, event.params.implementation);
  },
);

indexer.onEvent(
  { contract: "KHYPE", event: "AdminChanged" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "AdminChanged", {
      detail: `${event.params.previousAdmin} -> ${event.params.newAdmin}`,
    });
  },
);

indexer.onEvent(
  { contract: "KHYPE", event: "Initialized" },
  async ({ event, context }) => {
    recordProtocolChange(context, event, "Initialized", {
      detail: `version ${event.params.version}`,
    });
  },
);
