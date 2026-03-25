import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion, AnimatePresence, useMotionValue, animate } from "framer-motion";
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
  Send,
  Mail,
} from "lucide-react";
import {
  useGetCurrentUser,
  useGetUserBalance,
  useGetPendingEscrows,
  useGetEscrowHistory,
  useWithdrawCrypto,
  useWithdrawFiat,
  useSendUSDC,
} from "@workspace/api-client-react";
import { useWeb3 } from "@/hooks/use-web3";
import { cn, formatCurrency, formatAddress } from "@/lib/utils";
import { AppLayout } from "@/components/layout";
import { fadeUp, scaleIn, staggerContainer, fadeIn } from "@/lib/motion";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const ARC_EXPLORER = "https://explorer.arc.io/tx/";

interface FullBalance {
  onChainUsdcBalance: string;
  onChainLastUpdated: string | null;
  claimedBalance: string;
  pendingBalance: string;
  usdBalance: string;
  usdEquivalent: string;
}

type ClaimStep = "idle" | "connecting" | "signing" | "claiming" | "success" | "error";

// ─── Animated counter ─────────────────────────────────────────────────────────

function AnimatedAmount({ value }: { value: string }) {
  const numVal = parseFloat(value) || 0;
  const count = useMotionValue(0);
  const displayRef = useRef<HTMLSpanElement>(null);
  const prevVal = useRef(0);

  useEffect(() => {
    const from = prevVal.current;
    prevVal.current = numVal;
    const controls = animate(count, numVal, {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1],
      from,
      onUpdate(v) {
        if (displayRef.current) {
          displayRef.current.textContent = `$${v.toFixed(2)}`;
        }
      },
    });
    return controls.stop;
  }, [numVal]);

  return <span ref={displayRef}>$0.00</span>;
}

// ─── Small utilities ──────────────────────────────────────────────────────────

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
    <motion.div
      initial={{ opacity: 0, y: -6, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive mt-3 overflow-hidden"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </motion.div>
  );
}

// ─── Claim step progress ──────────────────────────────────────────────────────

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
              <motion.div
                animate={active ? { scale: [1, 1.15, 1] } : {}}
                transition={{ repeat: Infinity, duration: 1.4 }}
                className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all",
                  done ? "bg-green-500 text-white" : active ? "bg-primary text-white ring-2 ring-primary/30" : "bg-secondary text-muted-foreground",
                )}
              >
                {done ? <Check className="w-3 h-3" /> : i + 1}
              </motion.div>
              <span className={cn("text-[9px] font-medium whitespace-nowrap", active ? "text-primary" : done ? "text-green-600" : "text-muted-foreground")}>
                {s.label}
              </span>
            </div>
            {i < CLAIM_STEPS.length - 1 && (
              <div className={cn("h-0.5 flex-1 mx-0.5 rounded-full transition-colors duration-500", i < activeIdx || step === "success" ? "bg-green-400" : "bg-border")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"history" | "send" | "withdraw">("history");
  const [withdrawMethod, setWithdrawMethod] = useState<"crypto" | "fiat">("crypto");

  const [claimStep, setClaimStep]       = useState<ClaimStep>("idle");
  const [claimError, setClaimError]     = useState<string | null>(null);
  const [claimTxHash, setClaimTxHash]   = useState<string | null>(null);
  const [claimTotal, setClaimTotal]     = useState<string | null>(null);

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

  const withdrawCryptoMutation = useWithdrawCrypto({ mutation: { onSuccess: () => refetchBalance() } });
  const withdrawFiatMutation   = useWithdrawFiat({ mutation: { onSuccess: () => refetchBalance() } });

  useEffect(() => {
    if (!isUserLoading && isUserError) setLocation("/login");
  }, [isUserLoading, isUserError, setLocation]);

  if (isUserLoading || !user) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
          >
            <Loader2 className="w-10 h-10 text-primary" />
          </motion.div>
        </div>
      </AppLayout>
    );
  }

  const handleClaim = async () => {
    setClaimError(null);
    setClaimTxHash(null);
    try {
      let walletAddr = address;
      if (!walletAddr) {
        setClaimStep("connecting");
        walletAddr = await connectWallet();
        if (!walletAddr) { setClaimStep("idle"); return; }
      }
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
      const { emailHash, signature, contractAddress, totalPendingAmount, nonce } = await signRes.json();
      setClaimTotal(totalPendingAmount);
      setClaimStep("claiming");
      const txHash = await claimFromEscrow(contractAddress, emailHash, walletAddr, signature);
      fetch(`${BASE}/api/escrow/claim/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ txHash, walletAddress: walletAddr, nonce }),
      }).catch(console.warn);
      setClaimTxHash(txHash);
      setClaimStep("success");
      refetchBalance();
      refetchPending();
      queryClient.invalidateQueries({ queryKey: ["/api/escrow/history"] });
    } catch (err: any) {
      const msg = err?.reason ?? err?.info?.error?.message ?? err?.message ?? "Claim failed.";
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

  const hasPending  = Number(pending?.totalPendingAmount ?? 0) > 0;
  const isClaiming  = claimStep !== "idle" && claimStep !== "success" && claimStep !== "error";

  return (
    <AppLayout>
      {/* Subtle background orb */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="orb orb-blue w-[500px] h-[500px] top-[-100px] right-[-100px] opacity-60" />
        <div className="orb orb-violet w-[400px] h-[400px] bottom-0 left-[-100px] opacity-40" />
      </div>

      <motion.div
        variants={staggerContainer(0.1, 0)}
        initial="hidden"
        animate="show"
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8"
      >
        {/* ── Balance cards ────────────────────────────────────────────────── */}
        <div className="grid md:grid-cols-2 gap-6">

          {/* USD Balance */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
            className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-primary to-accent text-white border-none relative overflow-hidden"
          >
            <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-40 h-40 bg-white/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/4 pointer-events-none" />

            <div className="flex items-center gap-3 mb-4 text-white/80 font-medium">
              <DollarSign className="w-5 h-5" />
              USD Balance
            </div>

            <div className="text-4xl lg:text-5xl font-display font-bold tracking-tight mb-1">
              {bal ? <AnimatedAmount value={bal.usdBalance} /> : "$0.00"}
            </div>
            <div className="text-white/70 text-sm mb-5">1 USDC = 1 USD · stablecoin peg</div>

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
          </motion.div>

          {/* Pending Escrow */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
            className="glass-panel p-6 rounded-3xl relative overflow-hidden"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3 text-muted-foreground font-medium">
                <Clock className="w-5 h-5" />
                Pending Escrow
              </div>
              <AnimatePresence>
                {hasPending && claimStep === "idle" && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleClaim}
                    disabled={isClaiming}
                    className="px-4 py-2 bg-primary text-primary-foreground text-sm font-bold rounded-lg shadow-lg shadow-primary/20 flex items-center gap-2 disabled:opacity-70"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    Claim All
                  </motion.button>
                )}
                {claimStep === "success" && (
                  <motion.button
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    onClick={handleClaimReset}
                    className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Done
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            <div className="text-4xl lg:text-5xl font-display font-bold text-foreground tracking-tight mb-2">
              {pending ? <AnimatedAmount value={String(pending.totalPendingAmount)} /> : "$0.00"}
            </div>
            <div className="text-muted-foreground text-sm mb-2">
              {pending?.escrows.length || 0} transfer(s) waiting for you
            </div>

            {isClaiming && <ClaimProgress step={claimStep} />}
            {isClaiming && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-sm text-primary mt-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {claimStep === "connecting" && "Connecting wallet…"}
                {claimStep === "signing"    && "Requesting backend authorization…"}
                {claimStep === "claiming"   && "Confirm the transaction in your wallet…"}
              </motion.div>
            )}

            <AnimatePresence>
              {claimStep === "success" && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, height: 0 }}
                  animate={{ opacity: 1, scale: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 p-3 rounded-xl bg-green-50 border border-green-200 overflow-hidden"
                >
                  <div className="flex items-center gap-2 text-green-700 font-semibold text-sm mb-1">
                    <CheckCircle2 className="w-4 h-4" />
                    {claimTotal ? `${claimTotal} USDC claimed!` : "Claimed successfully!"}
                  </div>
                  {claimTxHash && (
                    <div className="flex items-center gap-1 text-xs text-green-600 font-mono truncate">
                      <span className="truncate">{claimTxHash}</span>
                      <CopyButton text={claimTxHash} />
                      <a href={`${ARC_EXPLORER}${claimTxHash}`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-3 h-3 opacity-60 hover:opacity-100" />
                      </a>
                    </div>
                  )}
                </motion.div>
              )}
              {claimStep === "error" && claimError && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2">
                  <InlineError message={claimError} />
                  <button onClick={handleClaimReset} className="mt-2 text-sm text-primary hover:underline">
                    Try again
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────────── */}
        <motion.div variants={fadeUp} className="bg-white/80 backdrop-blur rounded-3xl shadow-sm border border-border overflow-hidden">
          <div className="flex border-b border-border relative">
            {([
              { id: "history",  label: "History",      icon: Clock },
              { id: "send",     label: "Send USDC",    icon: Send  },
              { id: "withdraw", label: "Withdraw",     icon: Wallet },
            ] as const).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  "flex-1 py-4 text-center font-semibold transition-colors relative flex items-center justify-center gap-2",
                  activeTab === id ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{label}</span>
                <span className="sm:hidden text-xs">{label}</span>
                {activeTab === id && (
                  <motion.div
                    layoutId="tab-indicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
              </button>
            ))}
          </div>

          <div className="p-6 lg:p-8 min-h-[400px]">
            <AnimatePresence mode="wait">
              {/* History tab */}
              {activeTab === "history" && (
                <motion.div
                  key="history"
                  variants={fadeIn}
                  initial="hidden"
                  animate="show"
                  exit="hidden"
                  className="space-y-6"
                >
                  {!history || (history.sent.length === 0 && history.received.length === 0) ? (
                    <motion.div variants={scaleIn} className="text-center py-12 text-muted-foreground">
                      <Clock className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      <p>No transactions yet</p>
                    </motion.div>
                  ) : (
                    <motion.div variants={staggerContainer(0.06)} className="space-y-3">
                      {[...history.received, ...history.sent]
                        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                        .map((tx, idx) => {
                          const isReceived = !!tx.recipientEmail && tx.recipientEmail === user.email;
                          const statusColor =
                            tx.status === "claimed" ? "text-green-600" :
                            tx.status === "pending"  ? "text-amber-600" : "text-muted-foreground";
                          return (
                            <motion.div
                              key={tx.id}
                              variants={fadeUp}
                              whileHover={{ x: 4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
                              className="flex items-center justify-between p-4 rounded-2xl border border-border/50 hover:bg-secondary/20 transition-colors gap-4 cursor-default"
                            >
                              <div className="flex items-center gap-4 min-w-0">
                                <motion.div
                                  whileHover={{ scale: 1.1, rotate: isReceived ? -10 : 10 }}
                                  className={cn(
                                    "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                                    isReceived ? "bg-green-100 text-green-600" : "bg-blue-100 text-blue-600",
                                  )}
                                >
                                  {isReceived ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
                                </motion.div>
                                <div className="min-w-0">
                                  <p className="font-semibold text-foreground">{isReceived ? "Received USDC" : "Sent USDC"}</p>
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
                            </motion.div>
                          );
                        })}
                    </motion.div>
                  )}
                </motion.div>
              )}

              {/* Send USDC tab */}
              {activeTab === "send" && (
                <motion.div
                  key="send"
                  variants={fadeIn}
                  initial="hidden"
                  animate="show"
                  exit="hidden"
                  className="max-w-2xl mx-auto"
                >
                  <DashboardSendForm onSuccess={() => setActiveTab("history")} />
                </motion.div>
              )}

              {/* Withdraw tab */}
              {activeTab === "withdraw" && (
                <motion.div
                  key="withdraw"
                  variants={fadeIn}
                  initial="hidden"
                  animate="show"
                  exit="hidden"
                  className="max-w-2xl mx-auto"
                >
                  {/* Withdraw method selector */}
                  <div className="flex gap-2 p-1 bg-secondary rounded-xl mb-8">
                    {(["crypto", "fiat"] as const).map((method) => (
                      <button
                        key={method}
                        onClick={() => setWithdrawMethod(method)}
                        className={cn(
                          "flex-1 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all relative",
                          withdrawMethod === method ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {withdrawMethod === method && (
                          <motion.div
                            layoutId="withdraw-tab-bg"
                            className="absolute inset-0 bg-white rounded-lg shadow-sm"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                          />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                          {method === "crypto" ? (
                            <><Wallet className="w-4 h-4" /> Crypto Wallet</>
                          ) : (
                            <>
                              <Building2 className="w-4 h-4" />
                              Bank Transfer
                              <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 leading-none">
                                SOON
                              </span>
                            </>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>

                  <AnimatePresence mode="wait">
                    {withdrawMethod === "crypto" ? (
                      <motion.div key="crypto" variants={scaleIn} initial="hidden" animate="show" exit="hidden">
                        <CryptoWithdrawalForm mutation={withdrawCryptoMutation} maxAmount={balance?.claimedBalance || "0"} />
                      </motion.div>
                    ) : (
                      <motion.div key="fiat" variants={scaleIn} initial="hidden" animate="show" exit="hidden">
                        <FiatComingSoon />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </AppLayout>
  );
}

// ─── Withdrawal sub-forms ─────────────────────────────────────────────────────

function CryptoWithdrawalForm({ mutation, maxAmount }: { mutation: any; maxAmount: string }) {
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);

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
      setSuccessMsg(`Withdrawal of ${formatCurrency(data.amount)} USDC initiated.`);
      reset();
    } catch (e: any) {
      setErrorMsg(e?.message || "Withdrawal failed. Please try again.");
    }
  };

  return (
    <motion.form
      onSubmit={handleSubmit(onSubmit)}
      variants={staggerContainer(0.08)}
      initial="hidden"
      animate="show"
      className="space-y-5"
    >
      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm overflow-hidden"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {successMsg}
          </motion.div>
        )}
        {errorMsg && <InlineError message={errorMsg} />}
      </AnimatePresence>

      <motion.div variants={fadeUp}>
        <label className="block text-sm font-medium text-foreground mb-2">Destination Wallet Address</label>
        <input
          {...register("walletAddress")}
          placeholder="0x…"
          className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all"
        />
        {errors.walletAddress && <p className="text-destructive text-sm mt-1">{errors.walletAddress.message as string}</p>}
      </motion.div>

      <motion.div variants={fadeUp}>
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
            className="w-full pl-8 pr-16 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all"
          />
          <span className="absolute right-4 inset-y-0 flex items-center text-muted-foreground text-sm">USDC</span>
        </div>
        {errors.amount && <p className="text-destructive text-sm mt-1">{errors.amount.message as string}</p>}
      </motion.div>

      <motion.div variants={fadeUp}>
        <motion.button
          type="submit"
          disabled={mutation.isPending}
          whileHover={!mutation.isPending ? { scale: 1.02, y: -1 } : {}}
          whileTap={!mutation.isPending ? { scale: 0.98 } : {}}
          className="w-full bg-primary text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary/25 transition-shadow disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Withdraw to Wallet"}
        </motion.button>
      </motion.div>
    </motion.form>
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
    <motion.div
      variants={staggerContainer(0.1, 0)}
      initial="hidden"
      animate="show"
      className="flex flex-col items-center text-center py-4 space-y-8"
    >
      <motion.div variants={fadeUp}>
        <motion.div
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-semibold"
        >
          <Clock className="w-4 h-4" />
          Coming Soon
        </motion.div>
      </motion.div>

      <motion.div variants={fadeUp} className="space-y-2 max-w-sm">
        <h3 className="text-2xl font-bold text-foreground">Send USD to Your Bank</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Withdraw your USDC balance as real USD directly to your bank account — no crypto wallet needed.
        </p>
      </motion.div>

      <motion.div variants={staggerContainer(0.1)} className="w-full max-w-md space-y-3 text-left">
        {steps.map((step, i) => (
          <motion.div
            key={i}
            variants={fadeUp}
            whileHover={{ x: 6, transition: { type: "spring", stiffness: 400, damping: 20 } }}
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
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={fadeUp} className="w-full max-w-md">
        <button disabled className="w-full bg-muted text-muted-foreground font-bold py-4 rounded-xl flex items-center justify-center gap-2 cursor-not-allowed opacity-60">
          <Building2 className="w-5 h-5" />
          Initiate Wire Transfer — Coming Soon
        </button>
      </motion.div>

      <motion.p variants={fadeUp} className="text-xs text-muted-foreground max-w-sm">
        Powered by <span className="font-semibold text-foreground">Circle's Payout API</span>. Requires Circle KYB approval in production.
      </motion.p>
    </motion.div>
  );
}

// ─── Dashboard Send Form ──────────────────────────────────────────────────────

type DashSendStep = "idle" | "approving" | "approved" | "depositing" | "success";

const dashSendSchema = z.object({
  recipientEmail: z.string().email("Please enter a valid email address"),
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((v) => !isNaN(Number(v)) && Number(v) > 0, "Must be a positive number")
    .refine((v) => Number(v) >= 0.01, "Minimum is $0.01 USDC"),
});

type DashSendValues = z.infer<typeof dashSendSchema>;

async function confirmSend(escrowId: number, txHash: string) {
  await fetch(`${BASE}/api/escrow/send/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ escrowId, txHash }),
  });
}

function DashSendStepIndicator({ step }: { step: DashSendStep }) {
  const steps: { id: DashSendStep; label: string }[] = [
    { id: "approving",  label: "Approve USDC" },
    { id: "depositing", label: "Deposit to Escrow" },
    { id: "success",    label: "Confirmed" },
  ];
  return (
    <div className="flex items-center gap-0 mb-6">
      {steps.map((s, i) => {
        const done =
          (step === "approved"   && i === 0) ||
          (step === "depositing" && i === 0) ||
          (step === "success"    && i <= 1);
        const active =
          (step === "approving"  && i === 0) ||
          ((step === "approved" || step === "depositing") && i === 1) ||
          (step === "success"    && i === 2);
        return (
          <div key={s.id} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1 flex-1">
              <motion.div
                animate={active ? { scale: [1, 1.12, 1] } : {}}
                transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300",
                  done   ? "bg-green-500 text-white" :
                  active ? "bg-primary text-white ring-4 ring-primary/20" :
                           "bg-secondary text-muted-foreground",
                )}
              >
                {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </motion.div>
              <span className={cn("text-[10px] font-medium whitespace-nowrap", active ? "text-primary" : done ? "text-green-600" : "text-muted-foreground")}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn("h-0.5 flex-1 mx-1 rounded-full transition-colors duration-500", done ? "bg-green-400" : "bg-border")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DashboardSendForm({ onSuccess }: { onSuccess: () => void }) {
  const sendMutation = useSendUSDC();
  const { address, connectWallet, isConnecting, depositToEscrow } = useWeb3();

  const [txStep,       setTxStep]       = useState<DashSendStep>("idle");
  const [txHash,       setTxHash]       = useState<string | null>(null);
  const [formError,    setFormError]    = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState("");
  const [successAmount, setSuccessAmount] = useState("");

  const { register, handleSubmit, reset, formState: { errors } } = useForm<DashSendValues>({
    resolver: zodResolver(dashSendSchema),
  });

  const onSubmit = async (data: DashSendValues) => {
    setFormError(null);
    try {
      let walletAddr = address;
      if (!walletAddr) {
        walletAddr = await connectWallet();
        if (!walletAddr) return;
      }
      setTxStep("approving");
      const res = await sendMutation.mutateAsync({
        data: {
          recipientEmail: data.recipientEmail.toLowerCase().trim(),
          amount: data.amount,
          senderAddress: walletAddr,
        },
      });
      const hash = await depositToEscrow(
        res.contractAddress,
        res.usdcAddress,
        res.emailHash,
        res.amountWei,
        () => setTxStep("depositing"),
      );
      confirmSend(res.escrowId, hash).catch(console.warn);
      setTxHash(hash);
      setSuccessEmail(data.recipientEmail.toLowerCase().trim());
      setSuccessAmount(data.amount);
      setTxStep("success");
    } catch (err: any) {
      setTxStep("idle");
      const msg: string = err?.reason ?? err?.info?.error?.message ?? err?.message ?? "Transaction failed.";
      setFormError(msg.length > 200 ? msg.slice(0, 200) + "…" : msg);
    }
  };

  const handleReset = () => {
    setTxStep("idle");
    setTxHash(null);
    setFormError(null);
    setSuccessEmail("");
    setSuccessAmount("");
    reset();
  };

  const isBusy = txStep !== "idle";

  return (
    <AnimatePresence mode="wait">
      {/* ── Success state ── */}
      {txStep === "success" ? (
        <motion.div
          key="success"
          variants={scaleIn}
          initial="hidden"
          animate="show"
          exit="hidden"
          className="text-center py-10"
        >
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.1 }}
            className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-5 shadow-lg shadow-green-500/20"
          >
            <CheckCircle2 className="w-10 h-10" />
          </motion.div>

          <motion.div variants={staggerContainer(0.08)} initial="hidden" animate="show">
            <motion.h3 variants={fadeUp} className="text-2xl font-bold mb-1">Payment Sent!</motion.h3>
            <motion.p variants={fadeUp} className="text-muted-foreground text-sm mb-5">
              <span className="font-semibold text-foreground">${successAmount} USDC</span> locked in escrow for{" "}
              <span className="font-semibold text-foreground">{successEmail}</span>.
              They'll receive a notification to claim it.
            </motion.p>

            {txHash && (
              <motion.div variants={fadeUp} className="bg-secondary/60 rounded-xl px-4 py-3 mb-6 flex items-center justify-between gap-2 text-left mx-auto max-w-sm">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5 font-semibold">Tx Hash</p>
                  <p className="font-mono text-xs text-foreground truncate">{txHash}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <CopyButton text={txHash} />
                  <a href={`${ARC_EXPLORER}${txHash}`} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-white/20 transition-colors">
                    <ExternalLink className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
                  </a>
                </div>
              </motion.div>
            )}

            <motion.div variants={fadeUp} className="flex items-center justify-center gap-3">
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={handleReset}
                className="px-5 py-2.5 rounded-xl bg-secondary text-foreground font-medium hover:bg-secondary/80 transition-colors"
              >
                Send Another
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={onSuccess}
                className="px-5 py-2.5 rounded-xl bg-primary text-white font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
              >
                <Clock className="w-4 h-4" /> View History
              </motion.button>
            </motion.div>
          </motion.div>
        </motion.div>
      ) : (
        /* ── Form state ── */
        <motion.div key="form" variants={staggerContainer(0.08, 0)} initial="hidden" animate="show" exit="hidden">
          {/* Header */}
          <motion.div variants={fadeUp} className="mb-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold font-display">Send USDC</h3>
                <p className="text-sm text-muted-foreground mt-0.5">Lock funds in escrow for any email address</p>
              </div>
              {/* Wallet status */}
              {address ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-sm font-medium border border-green-200"
                >
                  <motion.div
                    animate={{ scale: [1, 1.4, 1] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="w-2 h-2 rounded-full bg-green-500"
                  />
                  {formatAddress(address)}
                </motion.div>
              ) : (
                <motion.button
                  type="button"
                  onClick={connectWallet}
                  disabled={isConnecting}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className="flex items-center gap-2 px-4 py-2 bg-secondary text-foreground rounded-xl text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
                >
                  <Wallet className="w-4 h-4" />
                  {isConnecting ? "Connecting…" : "Connect Wallet"}
                </motion.button>
              )}
            </div>
          </motion.div>

          {/* Step progress during tx */}
          {isBusy && <DashSendStepIndicator step={txStep} />}

          {/* Error message */}
          <AnimatePresence>
            {formError && (
              <motion.div
                initial={{ opacity: 0, height: 0, y: -6 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-start gap-3 px-4 py-3 mb-5 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive overflow-hidden"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{formError}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            {/* Recipient email */}
            <motion.div variants={fadeUp}>
              <label className="block text-sm font-medium text-foreground mb-2">
                <Mail className="w-4 h-4 inline mr-1.5 opacity-60" />
                Recipient Email
              </label>
              <input
                {...register("recipientEmail")}
                disabled={isBusy}
                type="email"
                autoComplete="off"
                placeholder="satoshi@example.com"
                className={cn(
                  "w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none disabled:opacity-60",
                  errors.recipientEmail && "border-destructive focus:border-destructive focus:ring-destructive/10",
                )}
              />
              <AnimatePresence>
                {errors.recipientEmail && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-destructive">
                    {errors.recipientEmail.message}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Amount */}
            <motion.div variants={fadeUp}>
              <label className="block text-sm font-medium text-foreground mb-2">
                Amount (USDC)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="text-muted-foreground font-medium">$</span>
                </div>
                <input
                  {...register("amount")}
                  disabled={isBusy}
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="100.00"
                  className={cn(
                    "w-full pl-8 pr-16 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none font-medium disabled:opacity-60",
                    errors.amount && "border-destructive focus:border-destructive focus:ring-destructive/10",
                  )}
                />
                <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                  <span className="text-muted-foreground font-medium text-sm">USDC</span>
                </div>
              </div>
              <AnimatePresence>
                {errors.amount && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-destructive">
                    {errors.amount.message}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Info note */}
            <motion.div variants={fadeUp} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-primary/5 border border-primary/10 text-sm text-muted-foreground">
              <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
              <span>Funds are locked in a smart contract escrow until the recipient signs up and claims them.</span>
            </motion.div>

            {/* Submit */}
            <motion.div variants={fadeUp}>
              <motion.button
                type="submit"
                disabled={isBusy}
                whileHover={!isBusy ? { scale: 1.02, y: -1 } : {}}
                whileTap={!isBusy ? { scale: 0.98 } : {}}
                className="w-full relative group flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-bold text-white overflow-hidden bg-primary disabled:opacity-70 disabled:cursor-not-allowed transition-shadow hover:shadow-xl hover:shadow-primary/30"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-primary to-accent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                <span className="relative z-10 flex items-center gap-2">
                  {txStep === "approving"  && <><Loader2 className="w-5 h-5 animate-spin" />Approving USDC in wallet…</>}
                  {(txStep === "approved" || txStep === "depositing") && <><Loader2 className="w-5 h-5 animate-spin" />Depositing to Escrow…</>}
                  {txStep === "idle" && <>
                    <Send className="w-5 h-5" />
                    Lock &amp; Send
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </>}
                </span>
              </motion.button>

              <AnimatePresence>
                {isBusy && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-xs text-muted-foreground mt-2"
                  >
                    {txStep === "approving"
                      ? "Step 1 of 2 — Approve the USDC spend in your wallet"
                      : "Step 2 of 2 — Confirm the deposit transaction in your wallet"}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>
          </form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
