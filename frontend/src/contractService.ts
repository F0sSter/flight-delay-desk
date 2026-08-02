import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import type { WalletClient } from "viem";
import { CONTRACT_ADDRESS, GENLAYER_NETWORK } from "./chain";

type Hex = `0x${string}`;
type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
export type ConnectedWallet = WalletClient & {
  account: NonNullable<WalletClient["account"]>;
  transport: WalletClient["transport"] & WalletProvider;
};

const ADDR = CONTRACT_ADDRESS as Hex;
const TIMEOUT_MS = 240_000;

// --- Domain model ---------------------------------------------------------

// Lifecycle status, matching the contract's FLIGHT_* constants.
export const STATUS = {
  SUBMITTED: 0,
  VERIFIED: 1,
  RULED: 2,
  PAID: 3,
} as const;

export const VERDICT = {
  PAYOUT: "PAYOUT",
  REVIEW: "REVIEW",
  NO_DELAY: "NO_DELAY",
} as const;

export interface FlightRecord {
  flightId: number;
  claimId: number;
  policyId: number;
  claimant: string;
  flightRef: string;
  airportReport: string;
  officialReport: string;
  recordDigest: string;
  recordAttestor: string;
  maxPayoutWei: string;
  poolShareWei: string; // u256 as decimal string
  status: number; // 0..3
  verdict: string; // "" | PAYOUT | REVIEW | NO_DELAY
  delayMinutes: number;
  severity: string;
  rationale: string;
}

export interface Counts {
  policies: number;
  claims: number;
  ruled: number;
  payouts: number;
  insurer: string;
  flightDataAuthority: string;
}

// --- Clients --------------------------------------------------------------

// A read-only client uses an ephemeral account; no wallet needed.
let _read: ReturnType<typeof createClient> | null = null;
function readClient() {
  if (!_read) _read = createClient({ chain: studionet, account: createAccount() });
  return _read;
}

function requireConnectedWallet(wallet: WalletClient | undefined): ConnectedWallet {
  if (!wallet?.account?.address) {
    throw new Error("Connect a wallet before sending a transaction.");
  }
  if (typeof wallet.transport?.request !== "function") {
    throw new Error("Connected wallet does not expose an EIP-1193 request signer.");
  }
  return wallet as ConnectedWallet;
}

function writeClient(wallet: WalletClient | undefined) {
  const signer = requireConnectedWallet(wallet);
  return createClient({
    chain: studionet,
    account: signer.account.address as Hex,
    provider: {
      request: (args: { method: string; params?: unknown[] }) => signer.transport.request(args),
    },
  });
}

async function send(
  wallet: WalletClient | undefined,
  functionName: string,
  args: any[],
  value: bigint = 0n
): Promise<string> {
  const client = writeClient(wallet);
  await client.connect(GENLAYER_NETWORK);

  const hash = await client.writeContract({ address: ADDR, functionName, args, value });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Transaction timed out")), TIMEOUT_MS);
  });
  try {
    await Promise.race([
      client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.ACCEPTED,
        interval: 5000,
        retries: 60,
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return String(hash);
}

// --- Reads ----------------------------------------------------------------

export async function getPoolBalanceWei(): Promise<string> {
  const raw = await readClient().readContract({
    address: ADDR,
    functionName: "get_pool_balance",
    args: [],
  });
  return String(raw ?? "0");
}

export async function getCounts(): Promise<Counts> {
  const raw = await readClient().readContract({
    address: ADDR,
    functionName: "get_counts",
    args: [],
  });
  const [policies, claims, ruled, payouts, insurer, flightDataAuthority] = String(raw ?? "0||0||0||0||||").split("||");
  return {
    policies: Number(policies || 0),
    claims: Number(claims || 0),
    ruled: Number(ruled || 0),
    payouts: Number(payouts || 0),
    insurer: String(insurer || ""),
    flightDataAuthority: String(flightDataAuthority || ""),
  };
}

export async function getFlight(flightId: number): Promise<FlightRecord> {
  const r = (await readClient().readContract({
    address: ADDR,
    functionName: "get_flight",
    args: [flightId],
  })) as Record<string, unknown>;

  return {
    flightId: Number(r.flight_id ?? flightId),
    claimId: Number(r.claim_id ?? flightId),
    policyId: Number(r.policy_id ?? 0),
    claimant: String(r.claimant ?? ""),
    flightRef: String(r.flight_ref ?? ""),
    airportReport: String(r.airport_report ?? ""),
    officialReport: String(r.official_report ?? r.airport_report ?? ""),
    recordDigest: String(r.record_digest ?? ""),
    recordAttestor: String(r.record_attestor ?? ""),
    maxPayoutWei: String(r.max_payout ?? "0"),
    poolShareWei: String(r.pool_share ?? "0"),
    status: Number(r.status ?? 0),
    verdict: String(r.verdict ?? ""),
    delayMinutes: Number(r.delay_minutes ?? 0),
    severity: String(r.severity ?? ""),
    rationale: String(r.rationale ?? ""),
  };
}

export async function getPolicy(policyId: number): Promise<Record<string, unknown>> {
  return (await readClient().readContract({
    address: ADDR,
    functionName: "get_policy",
    args: [policyId],
  })) as Record<string, unknown>;
}

export async function getAuthorityRecord(flightRef: string): Promise<Record<string, unknown>> {
  return (await readClient().readContract({
    address: ADDR,
    functionName: "get_authority_record",
    args: [flightRef],
  })) as Record<string, unknown>;
}

// --- Writes (full lifecycle) ---------------------------------------------

export function fundPool(wallet: WalletClient | undefined, amountWei: bigint): Promise<string> {
  return send(wallet, "fund_pool", [], amountWei);
}

export function transferFlightDataAuthority(wallet: WalletClient | undefined, newAuthority: Hex): Promise<string> {
  return send(wallet, "transfer_flight_data_authority", [newAuthority]);
}

export function registerPolicy(wallet: WalletClient | undefined, flightRef: string, maxPayoutWei: bigint, premiumWei: bigint): Promise<string> {
  return send(wallet, "register_policy", [flightRef, maxPayoutWei], premiumWei);
}

export function publishFlightRecord(
  wallet: WalletClient | undefined,
  flightRef: string,
  officialReport: string,
  sourceUri: string,
  digest = ""
): Promise<string> {
  return send(wallet, "publish_flight_record", [flightRef, officialReport, sourceUri, digest]);
}

export function submitFlight(wallet: WalletClient | undefined, policyId: number): Promise<string> {
  return send(wallet, "submit_flight", [policyId]);
}

export function verifyDelay(wallet: WalletClient | undefined, flightId: number): Promise<string> {
  return send(wallet, "verify_delay", [flightId]);
}

export function ruleComp(wallet: WalletClient | undefined, flightId: number): Promise<string> {
  return send(wallet, "rule_comp", [flightId]);
}

export function payout(wallet: WalletClient | undefined, flightId: number): Promise<string> {
  return send(wallet, "payout", [flightId]);
}
