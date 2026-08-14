/** Shared constants and small pure helpers. */

export const CHAIN_ID = 999;

/** ProtocolStats is a singleton; this is its id. */
export const PROTOCOL_ID = "kinetiq";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** kHYPE and HYPE are both 18-decimal. */
export const ONE_E18 = 10n ** 18n;

export const KHYPE_ADDRESS = "0xfD739d4e423301CE9385c1fb8850539D657C296D";
export const KHYPE_SYMBOL = "kHYPE";
export const KHYPE_DECIMALS = 18;

/** Human labels for the seven indexed addresses, lowercased for lookup. */
const CONTRACT_NAMES: Record<string, string> = {
  "0xfd739d4e423301ce9385c1fb8850539d657c296d": "KHYPE",
  "0x393d0b87ed38fc779fd9611144ae649ba6082109": "StakingManager",
  "0x9209648ec9d448ef57116b73a2f081835643dc7a": "StakingAccountant",
  "0x4b797a93dfc3d18cf98b7322a2b142fa8007508f": "ValidatorManager",
  "0x192826e470bd65fdc2cb472edd834d096233049b": "OracleManager",
  "0xefbccc6e33da1c1ef638cbc0f044968d0f590fed": "DefaultOracle",
  "0x752e76ea71960da08644614e626c9f9ff5a50547": "PauserRegistry",
};

export function contractName(address: string): string {
  return CONTRACT_NAMES[address.toLowerCase()] ?? address;
}

export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

/** Globally unique row id for per-log entities. */
export function logId(event: {
  chainId: number;
  block: { number: number };
  logIndex: number;
}): string {
  return `${event.chainId}_${event.block.number}_${event.logIndex}`;
}

/** Zero-pad a numeric id so lexical ordering matches numeric ordering. */
export function padded(value: bigint | number, width = 12): string {
  return String(value).padStart(width, "0");
}

/** UTC calendar day of a unix-seconds timestamp, as "YYYY-MM-DD". */
export function dayId(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/** Start-of-day unix seconds for the UTC day containing `timestamp`. */
export function dayStart(timestamp: number): bigint {
  return BigInt(Math.floor(timestamp / 86400) * 86400);
}
