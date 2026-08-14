# Kinetiq kHYPE indexer

A complete [Envio HyperIndex](https://envio.dev) indexer for **Kinetiq**, the liquid
staking protocol for HYPE, on **HyperEVM (chain 999)**.

It indexes the full live surface — **all 7 core contracts, 86 event registrations,
~11.9M lifetime logs** — from genesis, and reconstructs the protocol's own accounting
from events alone: total staked, total claimed, rewards, slashing, kHYPE supply, and
the **kHYPE→HYPE exchange rate as a time series**, which is the one thing the
contracts can only tell you about *right now*.

No RPC reads, no oracles, no off-chain enrichment. Every number below is derived
from logs.

---

## What's indexed

| Contract | Address | Events |
|---|---|---|
| kHYPE token | `0xfD739d4e423301CE9385c1fb8850539D657C296D` | 9 |
| StakingManager (EIP-2535 diamond) | `0x393D0B87Ed38fc779FD9611144aE649BA6082109` | 35 |
| StakingAccountant | `0x9209648Ec9D448EF57116B73A2f081835643dc7A` | 8 |
| ValidatorManager | `0x4b797A93DfC3D18Cf98B7322a2b142FA8007508f` | 11 |
| OracleManager | `0x192826e470bd65FDC2CB472eDd834D096233049b` | 12 |
| DefaultOracle | `0xefbcCc6E33DA1C1ef638cBc0F044968D0f590fED` | 3 |
| PauserRegistry | `0x752E76ea71960Da08644614E626c9F9Ff5a50547` | 8 |

`start_block` is `0`. HyperSync skips empty ranges for free, so there is no reason to
hunt deploy blocks and no way to get one wrong. The protocol's first log is at block
7,635,341 (2025-07-05).

## Entities

**Accounting**

- `ProtocolStats` — the singleton. The four accumulators (`totalStaked`,
  `totalClaimed`, `totalRewards`, `totalSlashing`), `kHypeTotalSupply`,
  `totalHypeBacking`, `exchangeRate`, plus every event counter and flow total.
- `ExchangeRateSnapshot` — one row per block in which the rate could have moved.
  `exchangeRate` is `(staked + rewards − claimed − slashing) × 1e18 / totalSupply`,
  which is exactly what `StakingAccountant.kHYPEToHYPE(1e18)` returns. **APR is the
  slope of this series**, and it does not exist anywhere else.
- `DailyProtocolStat` — UTC day buckets: mint/burn, stake, withdrawal and unstake
  counts and volumes, rewards reported, open/close exchange rate, closing supply and
  closing total staked.

**Token**

- `Token` — supply, mint/burn totals and counts, approval count.
- `Allowance` — current allowance per (owner, spender).

See [Scope of the token surface](#scope-of-the-token-surface) for why there is no
per-account balance or holder count here.

**Staking**

- `Staker`, `StakeEvent`, `WithdrawalRequest`, `InstantUnstake`.

**Validators**

- `Validator` — lifecycle, net delegated stake, rewards, latest oracle metrics.
- `ValidatorMetricsSnapshot` — the raw StakeHub feed (balance, performance score,
  reward, slashing) per validator per report.
- `ValidatorPerformanceReport`, `ValidatorRewardEvent`, `ValidatorBehaviorFailure`.

**Flow and control**

- `DelegationEvent`, `L1Operation`, `L1OperationBatch`, `TreasuryMovement`,
  `RewardDistribution`, `PausableContract`, `PauseEvent`, `ProtocolChangeEvent`,
  `ConfigChangeEvent`, `RoleAssignment`.

---

## Things this indexer gets right that an ABI-generated one does not

These are not stylistic preferences. Each one was found by querying the chain and
each one silently breaks an indexer built from the published artifacts.

**1. `RewardDistributionQueued` — the verified ABI is wrong.**
The currently verified source of `StakingManagerRouter` declares a six-parameter
`RewardDistributionQueued(uint256,address,uint256,uint256,uint256,uint256)`. Its
topic0 (`0xc478b213…`) has **zero occurrences in the contract's entire history**.
The event that actually fires, 1,532 times, is the three-parameter form
`RewardDistributionQueued(uint256,address,uint256)` → `0xc2accae5…`. An indexer
generated from Kinetiq's own ABI produces zero reward-distribution rows and looks
perfectly healthy while doing it. This project registers the form that fires.

**2. The published PauserRegistry address is dead.**
Kinetiq's contracts page lists `0xac03CABA51e17c86c921E1f6CBFBdC91F8BB2E6b`. That
address has no bytecode and has never emitted a log. The live registry — read off
`kHYPE.pauserRegistry()` — is `0x752E76ea71960Da08644614E626c9F9Ff5a50547`, and it
carries 5 `ContractPaused` / 5 `ContractUnpaused` events. Index the docs and your
dashboard says the protocol was never paused.

**3. `withdrawalId` is a per-user nonce, not a global counter.**
Two different users both hold withdrawal id `0`. Keying `WithdrawalRequest` on the
id alone — the obvious reading of the event — collapses thousands of unrelated
users' requests onto each other. The key here is `<user>-<withdrawalId>`.

**4. `OperationType` is an enum, so the canonical signature says `uint8`.**
Writing `OperationType` (or `uint256`) changes topic0 and returns zero logs for
`L1OperationAggregated`, `L1DelegationQueued`, `L1DelegationProcessed` and
`L1OperationsQueued` — 92,211 events, silently.

**5. Terminal states are reconciled, never overwritten.**
A late or duplicate `WithdrawalConfirmed` bumps `confirmationCount` and changes
nothing else — it can never rewrite the settlement block, amount or latency of the
confirmation that actually settled. `RewardDistribution` is guarded the same way. A
sibling protocol's indexer lost 27k finalised withdrawals to exactly this bug.

**6. The diamond can change the event surface without changing an address.**
`StakingManager` became an EIP-2535 diamond at block 31,872,097 and a facet cut at
31,873,622 added eight signatures with no redeploy. It can happen again. Every
`Upgraded`, `DiamondCut`, `FacetAdded` and `FacetRegistrySet` is recorded in
`ProtocolChangeEvent` so the change is a query, not a surprise.

## Signature eras

The diamond cut was **additive**: no pre-existing signature changed its topic0, so
indexing from genesis with today's signatures recovers the entire history. What
changed is that eight signatures exist *only after* block 31,872,097
(`RewardDistributionQueued`, `RewardDistributionCompleted`, `InstantUnstakeExecuted`,
`RedelegationRequested`, `BufferRebalance*`, `FacetAdded`, `DiamondCut`, and the
post-cut config setters). They are marked in `config.yaml`, and `src/indexer.test.ts`
pins one real-data test in each era so a signature regression on either side of the
cut fails the build.

One event runs the other way: `OracleManager.ValidatorBehaviorCheckFailed` stopped
emitting at block 14,213,280 when the sanity checker behind it was replaced. Its
signature is unchanged. A dead tail there is correct, not a decode failure.

## Known-unverified

- **`RedelegationRequested` parameter names.** The signature
  `RedelegationRequested(address,address,address,uint256,uint256,uint256)` is
  keccak-confirmed against the observed topic0, but no Kinetiq source declares this
  event. From the logs: all three addresses are indexed; the first varies per caller
  and is disjoint from the validator set, the second and third are known validators.
  The `from → to` direction is inferred from that, not documented. The three
  `uint256`s are stored verbatim as `amount0/1/2` and are deliberately **not** applied
  to any validator's delegated balance — guessing which one is the moved stake would
  corrupt a figure that does reconcile. 249 events.
- **`SlashingEventReported` indexed layout.** Never emitted to date
  (`totalSlashing()` reads 0, independently), so the `indexed` placement could not be
  confirmed against a real log. topic0 does not depend on it, so the event will be
  captured either way.

## Scope of the token surface

kHYPE is a **linked spot asset**: it exists on HyperCore and on HyperEVM, and moves
between them. The HyperCore→HyperEVM direction settles as a *system transaction* —
a transfer out of the linked-spot bridge (`0x2000…0079`) that this indexer's event
stream does not carry. The HyperEVM→HyperCore direction is an ordinary user
transaction and is present.

That asymmetry decides what this schema does and does not expose:

| Exposed | Why it is safe |
|---|---|
| `totalSupply`, `totalMinted`, `totalBurned`, `mintCount`, `burnCount` | Mints and burns **never** travel in a system transaction — sampled across five windows and 1,918 `Transfer` logs, every system-transaction log was a plain bridge→user transfer. Verified equal to `kHYPE.totalSupply()` **to the wei** at a pinned block against three independent archive RPCs. |
| Staking, validator, reward, withdrawal and exchange-rate entities | All driven by ordinary user transactions; each reconciles exactly against the contracts' own accounting. |

| Not exposed | Why it would be wrong |
|---|---|
| Per-account balances (`Holder`) | Short by every Core→EVM credit. Accounts credited on HyperCore and later spending on HyperEVM would show **negative** balances. |
| `holderCount`, `everHolderCount` | Derived from those balances. |
| `transferCount`, `transferVolume` (token and daily) | Undercount by the system transfers, one-directionally. |

Deriving a balance ledger anyway — and letting it drift, or clamping it at zero to
hide the drift — is the tempting move and the wrong one. A number that cannot be
reconciled against the chain is not shipped here. If per-account balances are needed,
the correct source is a periodic `balanceOf` reconciliation against an archive RPC,
which is a deliberate addition rather than a silent by-product of log indexing.

## Deliberate omissions

- **No per-transfer rows.** kHYPE has millions of `Transfer` logs and nothing queries a
  multi-million-row log table; supply and per-day flow are aggregates, so that is what
  gets stored. Approvals collapse the same way, into one current-allowance row per
  (owner, spender). Re-adding a `TokenTransfer` entity is a schema line and a handler
  line if the raw log is ever wanted — with the caveat above about completeness.
- **No contract reads.** Metadata that only a view call can give (NAV, share
  conversion, validator names) is out of scope here by design — this indexer runs on
  event data alone and needs no RPC endpoint provisioned to work.
- **White-label deployments excluded.** Kinetiq's LST-as-a-service template has five
  other tenants (kmHYPE, ASXN, HYLQ, Hyperion, Flowdesk). They are separate contract
  sets and are not indexed here.

---

## Run it

```bash
pnpm install
pnpm codegen
pnpm dev        # http://localhost:8080 — GraphQL playground, local password "testing"
```

Set `ENVIO_API_TOKEN` in `.env` (see `.env.example`); get one at
<https://envio.dev/app/api-tokens>.

## Test it

```bash
pnpm test
```

The suite has two kinds of test:

- **Pinned real-data tests** at fixed blocks on both sides of the diamond cut. These
  fetch real logs from HyperSync, so they need `ENVIO_API_TOKEN`. A signature that
  stops decoding shows up as a short event count, which fails the assertion. HyperSync
  throttles hard on chain 999, so the suite's wall time swings between ~2s and ~60s;
  the per-test timeout is set to 120s for that reason and not because anything is slow.
- **Simulated handler tests** for the arithmetic: exchange-rate reconstruction, the
  token-surface scope guard (supply survives a missing bridge transfer; no balance
  state is kept), and the terminal-state guards on withdrawals and reward
  distributions.

## Pre-requisites

- [Node.js v22+](https://nodejs.org/en/download/current)
- [pnpm v8+](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or
  [Podman](https://podman.io/) (for `pnpm dev`)
