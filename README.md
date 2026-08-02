# Flight Delay Desk

- **App**: https://F0sSter.github.io/flight-delay-desk/

Parametric flight-delay insurance on GenLayer StudioNet.

Flight Delay Desk lets an insurer seed a GEN payout pool, policyholders register eligible flights, and GenLayer validators settle delay claims from an authority-bound flight record. The claimant no longer supplies the report used for settlement.

## Reviewer fixes

- Authoritative flight records are bound by `flight_data_authority` through `publish_flight_record`.
- Only the policy holder can submit a claim for their own policy.
- A policy cannot be opened twice for the same holder and flight.
- A claim cannot be submitted until an authority record exists.
- Payouts are capped by the policy `max_payout` and cannot exceed the pool.
- Duplicate claims and duplicate payouts are blocked.
- The frontend write path uses the connected RainbowKit/wagmi wallet signer through `genlayer-js`, not just a displayed address.

## Lifecycle

1. `fund_pool()` — insurer or funder sends GEN into the shared pool.
2. `register_policy(flight_ref, max_payout)` — holder buys a policy with a premium.
3. `publish_flight_record(flight_ref, official_report, source_uri, digest)` — the flight data authority binds the official record.
4. `submit_flight(policy_id)` — only the policy holder opens the claim.
5. `verify_delay(claim_id)` — GenLayer validators extract delay minutes from the authority-bound record.
6. `rule_comp(claim_id)` — deterministic verdict: `PAYOUT`, `REVIEW`, or `NO_DELAY`.
7. `payout(claim_id)` — claimant receives the capped payout only once.

## Contract

- Contract: `backend/flight-delay-desk.py`
- Network: GenLayer StudioNet
- Address: `0x0628364a96cb0a22d3Da7fd7aC2f9eB0883Fc3C7`
- Deployment transaction: `0xc064e7c52c3a9e8dc344848b378555698fb7d9007fef05ea7afa5c543d671c91`
- Explorer: `https://explorer-studio.genlayer.com/address/0x0628364a96cb0a22d3Da7fd7aC2f9eB0883Fc3C7`

## Frontend

```bash
cd frontend
npm install
npm run dev
npm run build
```

The frontend is configured for StudioNet in `frontend/src/chain.ts` and sends writes with the connected wallet client in `frontend/src/contractService.ts`.

## Tests

```bash
genvm-lint check backend/flight-delay-desk.py --json
pytest tests/direct -q
cd frontend && npm run build
```
