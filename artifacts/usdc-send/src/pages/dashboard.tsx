import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Wallet,
  DollarSign,
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  Building2,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";
import {
  useGetCurrentUser,
  useGetUserBalance,
  useGetPendingEscrows,
  useGetEscrowHistory,
  useWithdrawCrypto,
  useWithdrawFiat,
} from "@workspace/api-client-react";
import { useWeb3 } from "@/hooks/use-web3";
import { cn, formatCurrency, formatAddress } from "@/lib/utils";
import { AppLayout } from "@/components/layout";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const ARC_EXPLORER = "https://explorer.arc.io/tx/";

// Extended balance type — adds Phase 6 on-chain fields not yet in the generated schema
interface FullBalance {
  // On-chain (blockchain indexer → escrow_balances)
  onChainUsdcBalance: string;
  onChainLastUpdated: string | null;
  // Off-chain (backend DB)
  claimedBalance: string;
  pendingBalance: string;
  // USD totals (1 USDC = 1 USD)
  usdBalance: string;
  usdEquivalent: string;
}

type ClaimStep = "idle" | "connecting" | "signing" | "claiming" | "success" | "error";

// ─── Small utilities ────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="p-1 rounded hover:bg-secondary transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
    </button>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive mt-3">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// ─── Claim step badge ────────────────────────────────────────────────────────

const CLAIM_STEPS = [
  { id: "connecting", label: "Connect Wallet" },
  { id: "signing",   label: "Get Signature" },
  { id: "claiming",  label: "Claim On-chain" },
  { id: "success",   label: "Done" },
] as const;

function ClaimProgress({ step }: { step: ClaimStep }) {
  const activeIdx = CLAIM_STEPS.findIndex((s) => s.id === step);
  return (
    <div className="flex items-center gap-1 my-4">
      {CLAIM_STEPS.map((s, i) => {
        const done   = i < activeIdx || step === "success";
        const active = i === activeIdx && step !== "success";
        return (
          <div key={s.id} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1 flex-1">
              <div className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all",
                done   ? "bg-green-500 text-white" :
                active ? "bg-primary text-white ring-2 ring-primary/30" :
                         "bg-secondary text-muted-foreground",
              )}>
                {done ? <Check className="w-3 h-3" /> : i + 1}
              </div>
              <span className={cn(
                "text-[9px] font-medium whitespace-nowrap",
                active ? "text-primary" : done ? "text-green-600" : "text-muted-foreground",
              )}>{s.label}</span>
            </div>
            {i < CLAIM_STEPS.length - 1 && (
              <div className={cn(
                "h-0.5 flex-1 mx-0.5 rounded-full transition-colors",
                i < activeIdx || step === "success" ? "bg-green-400" : "bg-border",
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"history" | "withdraw">("history");
  const [withdrawMethod, setWithdrawMethod] = useState<"crypto" | "fiat">("crypto");

  // Claim state
  const [claimStep, setClaimStep] = useState<ClaimStep>("idle");
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimTotal, setClaimTotal] = useState<string | null>(null);

  const { address, connectWallet, claimFromEscrow } = useWeb3();

  const { data: user, isLoading: isUserLoading, isError: isUserError } =
    useGetCurrentUser({ query: { retry: false } });
  const { data: balance, refetch: refetchBalance } =
    useGetUserBalance({ query: { enabled: !!user } });
  const bal = balance as FullBalance | undefined;
  const { data: pending, refetch: refetchPending } =
    useGetPendingEscrows({ query: { enabled: !!user } });
  const { data: history } =
    useGetEscrowHistory({ query: { enabled: !!user } });

  const withdrawCryptoMutation = useWithdrawCrypto({
    mutation: { onSuccess: () => { refetchBalance(); } },
  });
  const withdrawFiatMutation = useWithdrawFiat({
    mutation: { onSuccess: () => { refetchBalance(); } },
  });

  useEffect(() => {
    if (!isUserLoading && isUserError) setLocation("/login");
  }, [isUserLoading, isUserError, setLocation]);

  if (isUserLoading || !user) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  // ── Phase 5 claim handler ─────────────────────────────────────────────────
  const handleClaim = async () => {
    setClaimError(null);
    setClaimTxHash(null);

    try {
      // Step 1 — connect wallet
      let walletAddr = address;
      if (!walletAddr) {
        setClaimStep("connecting");
        walletAddr = await connectWallet();
        if (!walletAddr) {
          setClaimStep("idle");
          return;
        }
      }

      // Step 2 — get backend signature
      setClaimStep("signing");
      const jwt = localStorage.getItem("token");
      const authHeader = jwt ? { Authorization: `Bearer ${jwt}` } : {};
      const signRes = await fetch(`${BASE}/api/escrow/claim/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ walletAddress: walletAddr }),
      });
      if (!signRes.ok) {
        const err = await signRes.json().catch(() => ({}));
        throw new Error(err.message || "Failed to get backend signature");
      }
      const { emailHash, signature, contractAddress, totalPendingAmount } = await signRes.json();
      setClaimTotal(totalPendingAmount);

      // Step 3 — user's wallet calls the contract
      setClaimStep("claiming");
      const txHash = await claimFromEscrow(contractAddress, emailHash, walletAddr, signature);

      // Step 4 — notify backend (best effort, fire-and-forget)
      fetch(`${BASE}/api/escrow/claim/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ txHash, walletAddress: walletAddr }),
      }).catch(console.warn);

      setClaimTxHash(txHash);
      setClaimStep("success");

      // Refresh dashboard data
      refetchBalance();
      refetchPending();
      queryClient.invalidateQueries({ queryKey: ["/api/escrow/history"] });
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.reason ??
        err?.info?.error?.message ??
        err?.message ??
        "Claim failed. Please try again.";
      setClaimError(msg.length > 200 ? msg.slice(0, 200) + "…" : msg);
      setClaimStep("error");
    }
  };

  const handleClaimReset = () => {
    setClaimStep("idle");
    setClaimError(null);
    setClaimTxHash(null);
    setClaimTotal(null);
  };

  const hasPending = Number(pending?.totalPendingAmount ?? 0) > 0;
  const isClaiming = claimStep !== "idle" && claimStep !== "success" && claimStep !== "error";

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

        {/* ── Balance cards ── */}
        <div className="grid md:grid-cols-2 gap-6">

          {/* USD Balance card — reads from escrow_balances (on-chain) + users.claimed_balance */}
          <div className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-primary to-accent text-white border-none relative overflow-hidden">
            <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />

            <div className="flex items-center gap-3 mb-4 text-white/80 font-medium">
              <DollarSign className="w-5 h-5" />
              USD Balance
            </div>

            {/* Primary figure — total USD (1 USDC = 1 USD) */}
            <div className="text-4xl lg:text-5xl font-display font-bold tracking-tight mb-1">
              {bal ? formatCurrency(bal.usdBalance) : "$0.00"}
            </div>
            <div className="text-white/70 text-sm mb-5">
              1 USDC = 1 USD · stablecoin peg
            </div>

            {/* Breakdown rows */}
            <div className="space-y-2 border-t border-white/20 pt-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/70 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-300 inline-block" />
                  On-chain escrow
                </span>
                <span className="font-semibold tabular-nums">
                  {bal ? formatCurrency(bal.onChainUsdcBalance) : "$0.00"}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/70 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-300 inline-block" />
                  Credited balance
                </span>
                <span className="font-semibold tabular-nums">
                  {bal ? formatCurrency(bal.claimedBalance) : "$0.00"}
                </span>
              </div>
            </div>
          </div>

          {/* Pending escrow */}
          <div className="glass-panel p-6 rounded-3xl relative overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3 text-muted-foreground font-medium">
                <Clock className="w-5 h-5" />
                Pending Escrow
              </div>
              {hasPending && claimStep === "idle" && (
                <button
                  onClick={handleClaim}
                  disabled={isClaiming}
                  className="px-4 py-2 bg-primary text-primary-foreground text-sm font-bold rounded-lg hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20 flex items-center gap-2 disabled:opacity-70"
                >
                  <ShieldCheck className="w-4 h-4" />
                  Claim All
                </button>
              )}
              {claimStep === "success" && (
                <button
                  onClick={handleClaimReset}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Done
                </button>
              )}
            </div>

            <div className="text-4xl lg:text-5xl font-display font-bold text-foreground tracking-tight mb-2">
              {pending ? formatCurrency(pending.totalPendingAmount) : "$0.00"}
            </div>
            <div className="text-muted-foreground text-sm mb-2">
              {pending?.escrows.length || 0} transfer(s) waiting for you
            </div>

            {/* Claim progress */}
            {isClaiming && <ClaimProgress step={claimStep} />}
            {isClaiming && (
              <div className="flex items-center gap-2 text-sm text-primary mt-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {claimStep === "connecting" && "Connecting wallet…"}
                {claimStep === "signing"   && "Requesting backend authorization…"}
                {claimStep === "claiming"  && "Confirm the transaction in your wallet…"}
              </div>
            )}

            {/* Success state */}
            {claimStep === "success" && (
              <div className="mt-3 p-3 rounded-xl bg-green-50 border border-green-200">
                <div className="flex items-center gap-2 text-green-700 font-semibold text-sm mb-1">
                  <CheckCircle2 className="w-4 h-4" />
                  {claimTotal ? `${claimTotal} USDC claimed!` : "Claimed successfully!"}
                </div>
                {claimTxHash && (
                  <div className="flex items-center gap-1 text-xs text-green-600 font-mono truncate">
                    <span className="truncate">{claimTxHash}</span>
                    <CopyButton text={claimTxHash} />
                    <a
                      href={`${ARC_EXPLORER}${claimTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View on explorer"
                    >
                      <ExternalLink className="w-3 h-3 opacity-60 hover:opacity-100" />
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Error state */}
            {claimStep === "error" && claimError && (
              <div className="mt-2">
                <InlineError message={claimError} />
                <button
                  onClick={handleClaimReset}
                  className="mt-2 text-sm text-primary hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="bg-white rounded-3xl shadow-sm border border-border overflow-hidden">
          <div className="flex border-b border-border">
            {(["history", "withdraw"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "flex-1 py-4 text-center font-semibold transition-colors capitalize",
                  activeTab === tab
                    ? "text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab === "history" ? "Transaction History" : "Withdraw Funds"}
              </button>
            ))}
          </div>

          <div className="p-6 lg:p-8 min-h-[400px]">

            {/* History tab */}
            {activeTab === "history" && (
              <div className="space-y-6">
                {!history || (history.sent.length === 0 && history.received.length === 0) ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Clock className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p>No transactions yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {[...history.received, ...history.sent]
                      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                      .map((tx) => {
                        const isReceived = !!tx.recipientEmail && tx.recipientEmail === user.email;
                        const statusColor =
                          tx.status === "claimed" ? "text-green-600" :
                          tx.status === "pending"  ? "text-amber-600" :
                                                     "text-muted-foreground";
                        return (
                          <div
                            key={tx.id}
                            className="flex items-center justify-between p-4 rounded-2xl border border-border/50 hover:bg-secondary/20 transition-colors gap-4"
                          >
                            <div className="flex items-center gap-4 min-w-0">
                              <div className={cn(
                                "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                                isReceived ? "bg-green-100 text-green-600" : "bg-blue-100 text-blue-600",
                              )}>
                                {isReceived
                                  ? <ArrowDownLeft className="w-5 h-5" />
                                  : <ArrowUpRight className="w-5 h-5" />}
                              </div>
                              <div className="min-w-0">
                                <p className="font-semibold text-foreground">
                                  {isReceived ? "Received USDC" : "Sent USDC"}
                                </p>
                                <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
                                  <span>{format(new Date(tx.createdAt), "MMM d, yyyy 'at' h:mm a")}</span>
                                  <span className="w-1 h-1 rounded-full bg-border" />
                                  <span className={statusColor}>{tx.status}</span>
                                  {tx.txHash && (
                                    <>
                                      <span className="w-1 h-1 rounded-full bg-border" />
                                      <a
                                        href={`${ARC_EXPLORER}${tx.txHash}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-0.5 hover:text-primary transition-colors"
                                      >
                                        tx <ExternalLink className="w-2.5 h-2.5" />
                                      </a>
                                    </>
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className={cn("font-bold text-lg", isReceived ? "text-green-600" : "text-foreground")}>
                                {isReceived ? "+" : "-"}{formatCurrency(tx.amount)}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            {/* Withdraw tab */}
            {activeTab === "withdraw" && (
              <div className="max-w-2xl mx-auto">
                <div className="flex gap-2 p-1 bg-secondary rounded-xl mb-8">
                  <button
                    onClick={() => setWithdrawMethod("crypto")}
                    className={cn(
                      "flex-1 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all",
                      withdrawMethod === "crypto"
                        ? "bg-white text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Wallet className="w-4 h-4" /> Crypto Wallet
                  </button>
                  <button
                    onClick={() => setWithdrawMethod("fiat")}
                    className={cn(
                      "flex-1 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all",
                      withdrawMethod === "fiat"
                        ? "bg-white text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Building2 className="w-4 h-4" />
                    Bank Transfer
                    <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 leading-none">
                      SOON
                    </span>
                  </button>
                </div>
                {withdrawMethod === "crypto" && (
                  <CryptoWithdrawalForm
                    mutation={withdrawCryptoMutation}
                    maxAmount={balance?.claimedBalance || "0"}
                  />
                )}
                {withdrawMethod === "fiat" && <FiatComingSoon />}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

// ─── Withdrawal sub-forms ────────────────────────────────────────────────────

function CryptoWithdrawalForm({ mutation, maxAmount }: { mutation: any; maxAmount: string }) {
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const schema = z.object({
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address (0x...)"),
    amount: z
      .string()
      .refine((v) => Number(v) > 0, "Amount must be positive")
      .refine((v) => Number(v) <= Number(maxAmount), `Max available: $${maxAmount}`),
  });

  const { register, handleSubmit, formState: { errors }, reset } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async (data: any) => {
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      await mutation.mutateAsync({ data });
      setSuccessMsg(`Withdrawal of ${formatCurrency(data.amount)} USDC initiated successfully.`);
      reset();
    } catch (e: any) {
      setErrorMsg(e?.message || "Withdrawal failed. Please try again.");
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {successMsg}
        </div>
      )}
      {errorMsg && <InlineError message={errorMsg} />}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">Destination Wallet Address</label>
        <input
          {...register("walletAddress")}
          placeholder="0x…"
          className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary outline-none transition-colors"
        />
        {errors.walletAddress && <p className="text-destructive text-sm mt-1">{errors.walletAddress.message as string}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          Amount <span className="text-muted-foreground font-normal">(max {formatCurrency(maxAmount)})</span>
        </label>
        <div className="relative">
          <span className="absolute left-4 inset-y-0 flex items-center text-muted-foreground">$</span>
          <input
            {...register("amount")}
            placeholder="10.00"
            type="number"
            step="0.01"
            className="w-full pl-8 pr-16 py-3 rounded-xl bg-white border-2 border-border focus:border-primary outline-none transition-colors"
          />
          <span className="absolute right-4 inset-y-0 flex items-center text-muted-foreground text-sm">USDC</span>
        </div>
        {errors.amount && <p className="text-destructive text-sm mt-1">{errors.amount.message as string}</p>}
      </div>
      <button
        type="submit"
        disabled={mutation.isPending}
        className="w-full bg-primary text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-70"
      >
        {mutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Withdraw to Wallet"}
      </button>
    </form>
  );
}

function FiatComingSoon() {
  const steps = [
    {
      icon: <Wallet className="w-5 h-5" />,
      label: "Claim USDC",
      desc: "Your claimed USDC balance transfers to the platform wallet",
      color: "bg-blue-50 text-blue-600 border-blue-200",
    },
    {
      icon: <ArrowRight className="w-5 h-5" />,
      label: "Circle converts",
      desc: "Circle's Payout API converts USDC to USD at 1:1 peg",
      color: "bg-violet-50 text-violet-600 border-violet-200",
    },
    {
      icon: <Building2 className="w-5 h-5" />,
      label: "Wire to bank",
      desc: "USD arrives in your bank account within 1–3 business days",
      color: "bg-green-50 text-green-600 border-green-200",
    },
  ];

  return (
    <div className="flex flex-col items-center text-center py-4 space-y-8">
      {/* Badge */}
      <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-semibold">
        <Clock className="w-4 h-4" />
        Coming Soon
      </div>

      {/* Headline */}
      <div className="space-y-2 max-w-sm">
        <h3 className="text-2xl font-bold text-foreground">Send USD to Your Bank</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Withdraw your USDC balance as real USD directly to your bank account — no crypto wallet needed on your end.
        </p>
      </div>

      {/* Steps */}
      <div className="w-full max-w-md space-y-3 text-left">
        {steps.map((step, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-4 p-4 rounded-2xl border",
              step.color.split(" ").slice(0, 2).join(" "),
              "border-" + step.color.split(" ")[2].replace("border-", ""),
            )}
          >
            <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", step.color.split(" ").slice(0, 2).join(" "))}>
              {step.icon}
            </div>
            <div>
              <p className="font-semibold text-sm text-foreground">{step.label}</p>
              <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">{step.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Disabled button */}
      <button
        disabled
        className="w-full max-w-md bg-muted text-muted-foreground font-bold py-4 rounded-xl flex items-center justify-center gap-2 cursor-not-allowed opacity-60"
      >
        <Building2 className="w-5 h-5" />
        Initiate Wire Transfer — Coming Soon
      </button>

      <p className="text-xs text-muted-foreground max-w-sm">
        Powered by{" "}
        <span className="font-semibold text-foreground">Circle's Payout API</span>.
        Requires Circle KYB approval in production.
      </p>
    </div>
  );
}
