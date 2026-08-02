import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = "0x0628364a96cb0a22d3Da7fd7aC2f9eB0883Fc3C7";
const GEN = 10n ** 18n;
const pk = process.env.FLIGHT_DELAY_DEPLOYER_PK;

if (!pk) {
  throw new Error("Set FLIGHT_DELAY_DEPLOYER_PK before running this smoke test.");
}

const deployer = createAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const holder = createAccount();
const attacker = createAccount();

function client(account) {
  return createClient({ chain: studionet, account });
}

const insurerClient = client(deployer);
const holderClient = client(holder);
const attackerClient = client(attacker);

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

function receiptSucceeded(receipt) {
  const leader = receipt?.consensus_data?.leader_receipt;
  if (Array.isArray(leader) && leader.length > 0) {
    const nonIdle = leader.filter((entry) => !(entry.execution_result === "ERROR" && entry?.genvm_result?.error_code === "CONSENSUS_VALIDATOR_QUORUM_REACHED"));
    return nonIdle.length > 0 && nonIdle.every((entry) => entry.execution_result === "SUCCESS");
  }
  if (receipt?.execution_result) return receipt.execution_result === "SUCCESS";
  if (receipt?.result_name === "MAJORITY_AGREE" || receipt?.result === 6) return true;
  const resultName = receipt?.txExecutionResultName ?? receipt?.result_name ?? "";
  if (resultName === ExecutionResult.FINISHED_WITH_ERROR || resultName === "FINISHED_WITH_ERROR") return false;
  if (receipt?.status_name === "ACCEPTED" && receipt?.hash) return true;
  return Boolean(receipt?.hash);
}

async function read(gl, functionName, args = []) {
  return await gl.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}

async function write(label, gl, functionName, args = [], value = 0n, expectSuccess = true) {
  const hash = await gl.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value });
  const receipt = await gl.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    interval: 5000,
    retries: 90,
    fullTransaction: false,
  });
  const ok = receiptSucceeded(receipt);
  if (expectSuccess && !ok) throw new Error(`${label} failed execution: ${hash}`);
  if (!expectSuccess && ok) throw new Error(`${label} unexpectedly succeeded: ${hash}`);
  console.log(`${label}: ${hash} ${ok ? "SUCCESS" : "EXPECTED_FAIL"}`);
  return hash;
}

async function main() {
  const stamp = Date.now();
  const flightRef = `FD-SMOKE-${stamp}`;
  const officialReport = [
    "Official airline operational record for Flight FD-SMOKE.",
    "Scheduled departure: 2026-08-02 10:00 UTC.",
    "Actual departure: 2026-08-02 15:00 UTC.",
    "Verified departure delay: 300 minutes.",
    "Arrival delay confirms the same operational disruption.",
  ].join(" ");

  console.log(`contract=${CONTRACT_ADDRESS}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`holder=${holder.address}`);
  console.log(`attacker=${attacker.address}`);

  const beforeCounts = String(await read(insurerClient, "get_counts"));
  console.log(`before_counts=${beforeCounts}`);

  await write("fund_pool_10_GEN", insurerClient, "fund_pool", [], 10n * GEN);

  await write(
    "attacker_publish_fabricated_record",
    attackerClient,
    "publish_flight_record",
    [flightRef, officialReport, "attacker://fabricated", ""],
    0n,
    false,
  );

  await write(
    "authority_publish_record",
    insurerClient,
    "publish_flight_record",
    [flightRef, officialReport, "authority://airline-status/fd-smoke", ""],
  );

  const authorityRecord = await read(insurerClient, "get_authority_record", [flightRef]);
  assertOk(String(authorityRecord.attestor).toLowerCase() === deployer.address.toLowerCase(), "authority record not bound by deployer");

  await write("holder_register_policy", holderClient, "register_policy", [flightRef, 2n * GEN], GEN / 10n);
  const afterPolicyCounts = String(await read(insurerClient, "get_counts")).split("||");
  const policyId = Number(afterPolicyCounts[0]) - 1;
  assertOk(policyId >= 0, "policy was not created");

  await write("attacker_submit_holder_policy", attackerClient, "submit_flight", [policyId], 0n, false);
  await write("holder_submit_claim", holderClient, "submit_flight", [policyId]);

  const afterClaimCounts = String(await read(insurerClient, "get_counts")).split("||");
  const claimId = Number(afterClaimCounts[1]) - 1;
  assertOk(claimId >= 0, "claim was not created");

  await write("holder_duplicate_submit_claim", holderClient, "submit_flight", [policyId], 0n, false);

  await write("verify_delay_from_authority_record", holderClient, "verify_delay", [claimId]);
  await write("rule_compensation", holderClient, "rule_comp", [claimId]);

  const ruled = await read(insurerClient, "get_flight", [claimId]);
  console.log(`ruled.delay=${ruled.delay_minutes} verdict=${ruled.verdict} max=${ruled.max_payout}`);
  assertOk(Number(ruled.delay_minutes) >= 285 && Number(ruled.delay_minutes) <= 315, "delay outside validator tolerance");
  assertOk(String(ruled.verdict) === "PAYOUT", "expected PAYOUT verdict");

  await write("claimant_payout", holderClient, "payout", [claimId]);
  await write("duplicate_payout_blocked", holderClient, "payout", [claimId], 0n, false);

  const paid = await read(insurerClient, "get_flight", [claimId]);
  const policy = await read(insurerClient, "get_policy", [policyId]);
  const counts = String(await read(insurerClient, "get_counts"));
  const pool = String(await read(insurerClient, "get_pool_balance"));

  console.log(`paid.status=${paid.status} share=${paid.pool_share}`);
  console.log(`policy.status=${policy.status} policy.claim_id=${policy.claim_id}`);
  console.log(`final_counts=${counts}`);
  console.log(`final_pool=${pool}`);

  assertOk(Number(paid.status) === 3, "claim was not marked PAID");
  assertOk(BigInt(paid.pool_share) === GEN, "expected payout to be 1 GEN from 300/600 of 2 GEN max");
  assertOk(Number(policy.status) === 2, "policy was not marked CLAIMED");

  console.log("StudioNet smoke PASS");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
