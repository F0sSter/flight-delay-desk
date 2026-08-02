import { useState, useEffect, useRef } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient } from "wagmi";
import { formatEther, parseEther } from "viem";
import anime from "animejs";
import {
  fundPool,
  publishFlightRecord,
  registerPolicy,
  submitFlight,
  verifyDelay,
  ruleComp,
  payout,
  getFlight,
  getCounts,
  getPoolBalanceWei,
  STATUS,
  VERDICT,
  type FlightRecord,
  type Counts,
} from "./contractService";
import { CONTRACT_ADDRESS, GENLAYER_CHAIN_ID, GENLAYER_EXPLORER_URL } from "./chain";

type Hex = `0x${string}`;
type Busy = null | "fund" | "submit" | "load" | "verify" | "rule" | "payout";

function WalletControl() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;
        if (!connected) return <button className="wbtn" onClick={openConnectModal} type="button">Connect Wallet</button>;
        if (chain?.unsupported) return <button className="wbtn wbtn-warn" onClick={openChainModal} type="button">Wrong network</button>;
        return <button className="wchip" onClick={openAccountModal} type="button"><span className="wdot" />{account.displayName}</button>;
      }}
    </ConnectButton.Custom>
  );
}

function reducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// One split-flap line: each glyph sits in its own flap cell and tumbles on change.
function FlapLine({ text, cells, flip, className }: { text: string; cells: number; flip: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const glyphs = text.toUpperCase().slice(0, cells).padEnd(cells, "\u2007").split("");

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const flaps = host.querySelectorAll<HTMLElement>(".flap");
    if (reducedMotion()) {
      flaps.forEach((f) => { f.style.opacity = "1"; f.style.transform = "none"; });
      return;
    }
    anime.remove(flaps);
    anime({
      targets: flaps,
      rotateX: [90, 0],
      opacity: [0, 1],
      translateY: [-4, 0],
      duration: 600,
      delay: anime.stagger(60),
      easing: "easeOutQuad",
    });
  }, [text, flip, cells]);

  return (
    <div className={"flapline" + (className ? " " + className : "")} ref={ref} aria-label={text.trim()}>
      {glyphs.map((g, i) => (
        <span className="flap" key={i} aria-hidden="true">{g === " " ? "\u00A0" : g}</span>
      ))}
    </div>
  );
}

function fmtGen(wei: string): string {
  try {
    const n = Number(formatEther(BigInt(wei)));
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "0";
  } catch {
    return "0";
  }
}

function shortAddr(a: string): string {
  return a && a.length > 12 ? a.slice(0, 6) + "\u2026" + a.slice(-4) : a;
}

function errMsg(e: unknown): string {
  const m = (e as { message?: string })?.message;
  return (m ? String(m) : "Something went wrong.").slice(0, 200);
}

function boardStatus(f: FlightRecord | null, busy: Busy): string {
  if (busy === "verify") return "READING";
  if (busy === "rule") return "RULING";
  if (busy === "payout") return "PAYING";
  if (!f) return "AWAITING";
  if (f.status === STATUS.SUBMITTED) return "FILED";
  if (f.status === STATUS.VERIFIED) return "MEASURED";
  if (f.status === STATUS.RULED) return f.verdict || "RULED";
  if (f.status === STATUS.PAID) return "PAID";
  return "\u2014";
}

function boardStatusClass(f: FlightRecord | null, busy: Busy): string {
  if (busy || !f) return "wait";
  if (f.status === STATUS.PAID) return "PAYOUT";
  if (f.status === STATUS.RULED && f.verdict) return f.verdict.replace(/[^A-Z]/g, "");
  return "wait";
}

export function App() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const addr = address as Hex | undefined;

  const [poolWei, setPoolWei] = useState("0");
  const [counts, setCounts] = useState<Counts>({
    policies: 0,
    claims: 0,
    ruled: 0,
    payouts: 0,
    insurer: "",
    flightDataAuthority: "",
  });

  const [fundAmt, setFundAmt] = useState("");
  const [flightRef, setFlightRef] = useState("");
  const [report, setReport] = useState("");
  const [sourceUri, setSourceUri] = useState("");
  const [maxPayout, setMaxPayout] = useState("0.5");
  const [premium, setPremium] = useState("0.01");
  const [trackId, setTrackId] = useState("0");

  const [flight, setFlight] = useState<FlightRecord | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [flip, setFlip] = useState(0);

  async function refreshStats() {
    try {
      const [p, c] = await Promise.all([getPoolBalanceWei(), getCounts()]);
      setPoolWei(p);
      setCounts(c);
    } catch {
      /* reads can fail transiently; keep last known values */
    }
  }

  useEffect(() => { refreshStats(); }, []);

  async function loadFlight(id: number) {
    const f = await getFlight(id);
    setFlight(f);
    setFlip((n) => n + 1);
    return f;
  }

  async function onLoad() {
    const id = Number(trackId.trim());
    if (!Number.isInteger(id) || id < 0) { setError("Enter a valid flight id (0 or higher)."); return; }
    setBusy("load"); setError(""); setNotice("");
    try {
      await loadFlight(id);
    } catch (e) {
      setFlight(null);
      setError(errMsg(e) || "Could not load that flight.");
    } finally {
      setBusy(null);
    }
  }

  async function onFund() {
    if (!addr || !walletClient) return;
    let wei: bigint;
    try { wei = parseEther(fundAmt.trim() || "0"); } catch { setError("Invalid GEN amount."); return; }
    if (wei <= 0n) { setError("Enter an amount greater than 0."); return; }
    setBusy("fund"); setError(""); setNotice("");
    try {
      await fundPool(walletClient, wei);
      setNotice("Pool funded with " + fundAmt.trim() + " GEN.");
      setFundAmt("");
      await refreshStats();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSubmit() {
    if (!addr || !walletClient) return;
    let maxWei: bigint;
    let premiumWei: bigint;
    try {
      maxWei = parseEther(maxPayout.trim() || "0");
      premiumWei = parseEther(premium.trim() || "0");
    } catch {
      setError("Invalid premium or max payout amount.");
      return;
    }
    if (maxWei <= 0n || premiumWei <= 0n) {
      setError("Premium and max payout must be greater than 0.");
      return;
    }
    setBusy("submit"); setError(""); setNotice("");
    try {
      await registerPolicy(walletClient, flightRef.trim(), maxWei, premiumWei);
      const afterPolicy = await getCounts();
      const policyId = Math.max(0, afterPolicy.policies - 1);
      await submitFlight(walletClient, policyId);
      const c = await getCounts();
      setCounts(c);
      const newId = Math.max(0, c.claims - 1);
      setTrackId(String(newId));
      await loadFlight(newId);
      await refreshStats();
      setNotice("Policy #" + policyId + " claimed on-chain as flight #" + newId + ". Run Verify, then Rule.");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function onBindRecord() {
    if (!walletClient) return;
    setBusy("submit"); setError(""); setNotice("");
    try {
      await publishFlightRecord(walletClient, flightRef.trim(), report.trim(), sourceUri.trim() || "authority://frontend");
      setNotice("Authority flight record bound on-chain for " + flightRef.trim() + ".");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function runStep(key: Busy, fn: (wallet: typeof walletClient, id: number) => Promise<string>) {
    if (!walletClient || !flight) return;
    const id = flight.flightId;
    setBusy(key); setError(""); setNotice("");
    try {
      await fn(walletClient, id);
      await loadFlight(id);
      await refreshStats();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const canBind = !!isConnected && !!walletClient && !!flightRef.trim() && report.trim().length >= 30 && !busy;
  const canSubmit = !!isConnected && !!walletClient && !!flightRef.trim() && !!maxPayout.trim() && !!premium.trim() && !busy;
  const poolGen = fmtGen(poolWei);
  const boardRef = flight ? flight.flightRef : "";
  const boardDelay = flight && flight.status >= STATUS.VERIFIED ? String(flight.delayMinutes) : "";
  const statusText = boardStatus(flight, busy);
  const statusClass = boardStatusClass(flight, busy);

  return (
    <div className="terminal">
      <header className="gantry">
        <span className="logo">
          <span className="logo-sq" />
          <span className="logo-txt">Late&nbsp;Gate</span>
        </span>
        <span className="gantry-sub">On-chain flight-delay compensation desk</span>
        <WalletControl />
      </header>

      <section className="marquee" aria-hidden="true">
        <div className="marquee-track">
          OFFICIAL AIRPORT DATA, READ ON-CHAIN&nbsp;&nbsp;&middot;&nbsp;&nbsp;VALIDATORS AGREE ON THE DELAY&nbsp;&nbsp;&middot;&nbsp;&nbsp;180+ MIN PAYS OUT&nbsp;&nbsp;&middot;&nbsp;&nbsp;60&ndash;179 MIN GOES TO REVIEW&nbsp;&nbsp;&middot;&nbsp;&nbsp;INDEMNITY FROM A FUNDED POOL&nbsp;&nbsp;&middot;&nbsp;&nbsp;OFFICIAL AIRPORT DATA, READ ON-CHAIN&nbsp;&nbsp;&middot;&nbsp;&nbsp;VALIDATORS AGREE ON THE DELAY&nbsp;&nbsp;&middot;
        </div>
      </section>

      <section className="intro">
        <h1>Flight-delay compensation, settled by consensus.</h1>
        <p>
          Fund the pool, have the flight-data authority bind the official airport or airline record,
          then let the policy holder file a claim. GenLayer validators read the authority-bound record
          and agree on how many minutes the flight was delayed. The measured delay, the verdict, and any
          indemnity are all written on-chain.
        </p>
      </section>

      {/* Pool + ledger stats */}
      <section className="poolbar">
        <div className="stat">
          <span className="stat-num">{poolGen}<small>&nbsp;GEN</small></span>
          <span className="stat-label">Compensation pool</span>
        </div>
        <div className="stat">
          <span className="stat-num">{counts.policies}</span>
          <span className="stat-label">Policies</span>
        </div>
        <div className="stat">
          <span className="stat-num">{counts.claims}</span>
          <span className="stat-label">Claims</span>
        </div>
        <div className="stat">
          <span className="stat-num">{counts.ruled}</span>
          <span className="stat-label">Ruled</span>
        </div>
        <div className="stat">
          <span className="stat-num">{counts.payouts}</span>
          <span className="stat-label">Payouts</span>
        </div>
        <div className="poolfund">
          <input
            className="entry amount"
            value={fundAmt}
            onChange={(e) => setFundAmt(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            aria-label="Amount of GEN to add to the pool"
          />
          <button className="pull" disabled={!isConnected || !fundAmt.trim() || !!busy} onClick={onFund}>
            {busy === "fund" ? "Funding\u2026" : "Fund pool"}
          </button>
        </div>
      </section>

      {/* File a claim */}
      <section className="lookup">
        <div className="lookup-head">
          <span className="col">Flight reference</span>
          <span className="col">Authority-bound flight record</span>
        </div>
        <div className="lookup-row">
          <div className="cell">
            <input
              className="entry"
              value={flightRef}
              onChange={(e) => setFlightRef(e.target.value)}
              placeholder="AB123 / 2026-06-14"
            />
            <span className="cellhint">Carrier, number and date &mdash; exactly as printed on the boarding pass.</span>
            <input
              className="entry amount"
              value={maxPayout}
              onChange={(e) => setMaxPayout(e.target.value)}
              placeholder="Max payout GEN"
              inputMode="decimal"
              aria-label="Policy max payout in GEN"
            />
            <span className="cellhint">Policy max payout in GEN. Contract caps the payout to this amount.</span>
            <input
              className="entry amount"
              value={premium}
              onChange={(e) => setPremium(e.target.value)}
              placeholder="Premium GEN"
              inputMode="decimal"
              aria-label="Policy premium in GEN"
            />
            <span className="cellhint">Premium paid when registering the policy.</span>
          </div>
          <div className="cell">
            <textarea
              className="entry entry-area"
              rows={5}
              value={report}
              onChange={(e) => setReport(e.target.value)}
              placeholder="Authority only: paste the official airport / airline status record with scheduled vs actual times, delay figures, cancellation notes\u2026"
            />
            <input
              className="entry"
              value={sourceUri}
              onChange={(e) => setSourceUri(e.target.value)}
              placeholder="Authority source URI / API path"
            />
            <span className="cellhint">
              Only the flight-data authority can bind this record. Validators read the bound record, not claimant-written evidence &mdash; {report.trim().length} chars.
            </span>
          </div>
        </div>
        <div className="lookup-foot">
          <button className="pull" disabled={!canBind} onClick={onBindRecord}>
            {busy === "submit" ? "Binding\u2026" : "Bind official record"}
          </button>
          <button className="pull" disabled={!canSubmit} onClick={onSubmit}>
            {busy === "submit" ? "Filing\u2026" : "Buy policy + file claim"}
          </button>
          {!isConnected && <span className="footnote">Connect a wallet to file a claim.</span>}
        </div>
      </section>

      {/* Track / drive a filed flight */}
      <section className="lookup section-gap">
        <div className="lookup-head">
          <span className="col">Track a filed flight</span>
        </div>
        <div className="lookup-row">
          <div className="cell">
            <input
              className="entry"
              value={trackId}
              onChange={(e) => setTrackId(e.target.value)}
              placeholder="0"
              inputMode="numeric"
            />
            <span className="cellhint">Each filed claim gets a sequential id, starting at 0.</span>
          </div>
          <div className="cell cell-end">
            <button className="pull" onClick={onLoad} disabled={!!busy}>
              {busy === "load" ? "Loading\u2026" : "Load flight"}
            </button>
          </div>
        </div>
      </section>

      {/* The board */}
      <section className="display">
        <div className="display-head">
          <span className="dh dh-flight">Flight</span>
          <span className="dh dh-status">Status</span>
          <span className="dh dh-conf">Delay (min)</span>
        </div>

        <div className="display-row">
          <FlapLine className="row-flight" text={boardRef || "\u2014\u2014\u2014\u2014\u2014\u2014"} cells={12} flip={flip} />
          <FlapLine className={"row-status st-" + statusClass} text={statusText} cells={9} flip={flip} />
          <FlapLine className="row-conf" text={(busy === "verify" || busy === "rule") ? "..." : (boardDelay || "---")} cells={5} flip={flip} />
        </div>

        <div className="readout">
          {flight ? (
            <>
              {flight.status >= STATUS.VERIFIED && flight.rationale
                ? <p className="readout-sum">{flight.rationale}</p>
                : <p className="readout-idle">Flight #{flight.flightId} is filed. The validators have not measured the delay yet.</p>}

              <div className="actionrow">
                {!isConnected && <span className="footnote">Connect a wallet to act on this flight.</span>}

                {isConnected && flight.status === STATUS.SUBMITTED && (
                  <button className="pull" disabled={!!busy} onClick={() => runStep("verify", verifyDelay)}>
                    {busy === "verify" ? "Validators reading\u2026" : "Verify delay \u00b7 AI panel"}
                  </button>
                )}

                {isConnected && flight.status === STATUS.VERIFIED && (
                  <button className="pull" disabled={!!busy} onClick={() => runStep("rule", ruleComp)}>
                    {busy === "rule" ? "Ruling\u2026" : "Rule compensation"}
                  </button>
                )}

                {isConnected && flight.status === STATUS.RULED && flight.verdict === VERDICT.PAYOUT && (
                  <button className="pull" disabled={!!busy} onClick={() => runStep("payout", payout)}>
                    {busy === "payout" ? "Paying\u2026" : "Pay out indemnity"}
                  </button>
                )}

                {flight.status === STATUS.RULED && flight.verdict === VERDICT.REVIEW && (
                  <span className="verdict-note">Borderline delay (60&ndash;179 min) &mdash; manual review required before any payout.</span>
                )}
                {flight.status === STATUS.RULED && flight.verdict === VERDICT.NO_DELAY && (
                  <span className="verdict-note">Delay below 60 min &mdash; no compensation is due.</span>
                )}
                {flight.status === STATUS.PAID && (
                  <span className="verdict-note ok">Indemnity paid: {fmtGen(flight.poolShareWei)} GEN to the claimant.</span>
                )}
              </div>

              <div className="meta">
                <span className="meta-row"><span className="meta-k">Claimant</span><span className="meta-v">{shortAddr(flight.claimant)}</span></span>
                <span className="meta-row"><span className="meta-k">Policy</span><span className="meta-v">#{flight.policyId} max {fmtGen(flight.maxPayoutWei)} GEN</span></span>
                <span className="meta-row"><span className="meta-k">Authority</span><span className="meta-v">{shortAddr(flight.recordAttestor)}</span></span>
                <span className="meta-row"><span className="meta-k">Verdict</span><span className="meta-v">{flight.verdict || "\u2014"}</span></span>
                <span className="meta-row"><span className="meta-k">Pool share</span><span className="meta-v">{fmtGen(flight.poolShareWei)} GEN</span></span>
              </div>

              {error && <span className="board-err">{error}</span>}
              {notice && <span className="stub">{notice}</span>}
            </>
          ) : (
            <>
              <p className="readout-idle">Load a filed flight to drive it through verify &rarr; rule &rarr; payout. The flipped status and delay are exactly what the on-chain panel returns.</p>
              {error && <span className="board-err">{error}</span>}
              {notice && <span className="stub">{notice}</span>}
            </>
          )}
        </div>
      </section>

      <footer className="apron">
        <span className="logo small"><span className="logo-sq" />Late&nbsp;Gate</span>
        <span className="reg">
          <a className="reg-link" href={GENLAYER_EXPLORER_URL + "/address/" + CONTRACT_ADDRESS} target="_blank" rel="noreferrer">
            {CONTRACT_ADDRESS}
          </a>
          &nbsp;&middot;&nbsp;GenLayer StudioNet &middot; chain {GENLAYER_CHAIN_ID}
        </span>
      </footer>
    </div>
  );
}
