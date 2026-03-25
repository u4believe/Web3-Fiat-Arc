import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Wallet,
  ArrowRight,
  ShieldCheck,
  Mail,
  Zap,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
} from "lucide-react";
import { useSendUSDC } from "@workspace/api-client-react";
import { useWeb3 } from "@/hooks/use-web3";
import { cn, formatAddress } from "@/lib/utils";
import { AppLayout } from "@/components/layout";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const ARC_EXPLORER = "https://explorer.arc.io/tx/";

const sendSchema = z.object({
  recipientEmail: z.string().email("Please enter a valid email address"),
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine(
      (v) => !isNaN(Number(v)) && Number(v) > 0,
      "Must be a positive number",
    )
    .refine((v) => Number(v) >= 0.01, "Minimum send is $0.01 USDC"),
});

type SendFormValues = z.infer<typeof sendSchema>;

type TxStep = "idle" | "approving" | "approved" | "depositing" | "success";

async function confirmSendOnServer(escrowId: number, txHash: string) {
  await fetch(`${BASE}/api/escrow/send/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ escrowId, txHash }),
  });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-white/20 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-400" />
      ) : (
        <Copy className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
      )}
    </button>
  );
}

function StepIndicator({ step }: { step: TxStep }) {
  const steps: { id: TxStep; label: string }[] = [
    { id: "approving", label: "Approve USDC" },
    { id: "depositing", label: "Deposit to Escrow" },
    { id: "success", label: "Confirmed" },
  ];

  const activeIndex = steps.findIndex(
    (s) =>
      s.id === step ||
      (step === "approved" && s.id === "depositing"),
  );

  return (
    <div className="flex items-center gap-0 mb-6">
      {steps.map((s, i) => {
        const done =
          (step === "approved" && i === 0) ||
          (step === "depositing" && i === 0) ||
          (step === "success" && i <= 1);
        const active =
          (step === "approving" && i === 0) ||
          ((step === "approved" || step === "depositing") && i === 1) ||
          (step === "success" && i === 2);

        return (
          <div key={s.id} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1 flex-1">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300",
                  done
                    ? "bg-green-500 text-white"
                    : active
                      ? "bg-primary text-white ring-4 ring-primary/20"
                      : "bg-secondary text-muted-foreground",
                )}
              >
                {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium whitespace-nowrap",
                  active
                    ? "text-primary"
                    : done
                      ? "text-green-600"
                      : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "h-0.5 flex-1 mx-1 rounded-full transition-colors duration-500",
                  done ? "bg-green-400" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Landing() {
  const { address, connectWallet, isConnecting, depositToEscrow } = useWeb3();
  const sendMutation = useSendUSDC();
  const [txStep, setTxStep] = useState<TxStep>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState("");
  const [successAmount, setSuccessAmount] = useState("");

  const { register, handleSubmit, reset, formState: { errors } } = useForm<SendFormValues>({
    resolver: zodResolver(sendSchema),
  });

  const onSubmit = async (data: SendFormValues) => {
    setFormError(null);
    try {
      // Ensure wallet is connected
      let currentAddress = address;
      if (!currentAddress) {
        currentAddress = await connectWallet();
        if (!currentAddress) return;
      }

      setTxStep("approving");

      // 1. Register the pending escrow on the backend and get contract params
      const response = await sendMutation.mutateAsync({
        data: {
          recipientEmail: data.recipientEmail.toLowerCase().trim(),
          amount: data.amount,
          senderAddress: currentAddress,
        },
      });

      // 2. Approve USDC spend, then deposit (two wallet confirmations)
      const hash = await depositToEscrow(
        response.contractAddress,
        response.usdcAddress,
        response.emailHash,
        response.amountWei,
        () => setTxStep("depositing"),   // called right after approve tx is mined
      );

      // 3. Notify backend of the confirmed tx hash (fire-and-forget, best effort)
      confirmSendOnServer(response.escrowId, hash).catch(console.warn);

      setTxHash(hash);
      setSuccessEmail(data.recipientEmail.toLowerCase().trim());
      setSuccessAmount(data.amount);
      setTxStep("success");
    } catch (err: any) {
      console.error(err);
      setTxStep("idle");
      // Friendly inline error — no alerts
      const msg: string =
        err?.reason ??
        err?.info?.error?.message ??
        err?.message ??
        "Transaction failed. Please try again.";
      setFormError(msg.length > 200 ? msg.slice(0, 200) + "…" : msg);
    }
  };

  const handleSendAnother = () => {
    setTxStep("idle");
    setTxHash(null);
    setFormError(null);
    setSuccessEmail("");
    setSuccessAmount("");
    reset();
  };

  const isBusy = txStep !== "idle";

  return (
    <AppLayout>
      <div className="relative overflow-hidden min-h-[calc(100vh-5rem)] flex items-center">
        {/* Background */}
        <div className="absolute inset-0 -z-10">
          <img
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`}
            alt="Hero abstract background"
            className="w-full h-full object-cover opacity-40"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/80 to-background" />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-24 grid lg:grid-cols-2 gap-16 items-center">

          {/* Left — hero copy */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="max-w-2xl"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary font-medium text-sm mb-6 border border-primary/20">
              <Zap className="w-4 h-4" />
              <span>Instant Web3 + Web2 Escrow</span>
            </div>

            <h1 className="text-5xl lg:text-6xl font-bold text-foreground leading-tight mb-6">
              Send USDC to <br />
              <span className="text-gradient">Any Email Address</span>
            </h1>

            <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
              No wallet required for the recipient. Send stablecoins instantly.
              The funds are locked safely in a smart contract until they sign up
              and claim it.
            </p>

            <div className="grid sm:grid-cols-2 gap-6">
              <div className="flex gap-3">
                <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Secure Escrow</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Smart contract locked with email hashes.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="w-12 h-12 rounded-xl bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center shrink-0">
                  <Mail className="w-6 h-6 text-teal-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">No Onboarding</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    They just need their email to claim funds.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Right — send card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
          >
            <div className="glass-panel rounded-3xl p-8 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />

              <AnimatePresence mode="wait">
                {/* ── Success state ── */}
                {txStep === "success" ? (
                  <motion.div
                    key="success"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="text-center py-6"
                  >
                    <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-5 shadow-lg shadow-green-500/20">
                      <CheckCircle2 className="w-10 h-10" />
                    </div>
                    <h2 className="text-2xl font-bold mb-1">Funds Sent!</h2>
                    <p className="text-muted-foreground text-sm mb-5">
                      <span className="font-medium text-foreground">
                        ${successAmount} USDC
                      </span>{" "}
                      is locked in escrow for{" "}
                      <span className="font-medium text-foreground">
                        {successEmail}
                      </span>
                      . They can claim it any time after signing up.
                    </p>

                    {txHash && (
                      <div className="bg-secondary/60 rounded-xl px-4 py-3 mb-5 flex items-center justify-between gap-2 text-left">
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5 font-semibold">
                            Transaction Hash
                          </p>
                          <p className="font-mono text-xs text-foreground truncate">
                            {txHash}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <CopyButton text={txHash} />
                          <a
                            href={`${ARC_EXPLORER}${txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 rounded hover:bg-white/20 transition-colors"
                            title="View on block explorer"
                          >
                            <ExternalLink className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
                          </a>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleSendAnother}
                      className="px-6 py-3 bg-secondary text-foreground rounded-xl font-medium hover:bg-secondary/80 transition-colors"
                    >
                      Send Another Payment
                    </button>
                  </motion.div>
                ) : (
                  /* ── Form state ── */
                  <motion.div
                    key="form"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between mb-6">
                      <h2 className="text-2xl font-bold font-display">
                        Send Payment
                      </h2>
                      {address ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-sm font-medium border border-green-200">
                          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                          {formatAddress(address)}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={connectWallet}
                          disabled={isConnecting}
                          className="flex items-center gap-2 px-4 py-2 bg-secondary text-foreground rounded-xl text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
                        >
                          <Wallet className="w-4 h-4" />
                          {isConnecting ? "Connecting…" : "Connect Wallet"}
                        </button>
                      )}
                    </div>

                    {/* Step progress (visible during tx) */}
                    {isBusy && <StepIndicator step={txStep} />}

                    {/* Inline error */}
                    {formError && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-start gap-3 px-4 py-3 mb-5 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive"
                      >
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>{formError}</span>
                      </motion.div>
                    )}

                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-2">
                          Recipient Email
                        </label>
                        <input
                          {...register("recipientEmail")}
                          disabled={isBusy}
                          className={cn(
                            "w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none disabled:opacity-60",
                            errors.recipientEmail &&
                              "border-destructive focus:border-destructive focus:ring-destructive/10",
                          )}
                          placeholder="satoshi@example.com"
                          type="email"
                          autoComplete="email"
                        />
                        {errors.recipientEmail && (
                          <p className="mt-1.5 text-sm text-destructive">
                            {errors.recipientEmail.message}
                          </p>
                        )}
                      </div>

                      <div>
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
                            className={cn(
                              "w-full pl-8 pr-16 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none font-medium disabled:opacity-60",
                              errors.amount &&
                                "border-destructive focus:border-destructive focus:ring-destructive/10",
                            )}
                            placeholder="100.00"
                            type="number"
                            step="0.01"
                            min="0.01"
                          />
                          <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                            <span className="text-muted-foreground font-medium text-sm">USDC</span>
                          </div>
                        </div>
                        {errors.amount && (
                          <p className="mt-1.5 text-sm text-destructive">
                            {errors.amount.message}
                          </p>
                        )}
                      </div>

                      <button
                        type="submit"
                        disabled={isBusy}
                        className="w-full relative group flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-bold text-white overflow-hidden bg-primary disabled:opacity-70 disabled:cursor-not-allowed transition-all hover:shadow-xl hover:shadow-primary/30 active:scale-[0.98]"
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-primary to-accent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                        <span className="relative z-10 flex items-center gap-2">
                          {txStep === "approving" && (
                            <>
                              <Loader2 className="w-5 h-5 animate-spin" />
                              Approving USDC in wallet…
                            </>
                          )}
                          {(txStep === "approved" || txStep === "depositing") && (
                            <>
                              <Loader2 className="w-5 h-5 animate-spin" />
                              Depositing to Escrow…
                            </>
                          )}
                          {txStep === "idle" && (
                            <>
                              Lock &amp; Send
                              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                            </>
                          )}
                        </span>
                      </button>

                      {isBusy && (
                        <p className="text-center text-xs text-muted-foreground mt-2">
                          {txStep === "approving"
                            ? "Step 1 of 2 — Approve the USDC spend in your wallet"
                            : "Step 2 of 2 — Confirm the deposit transaction in your wallet"}
                        </p>
                      )}
                    </form>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

        </div>
      </div>
    </AppLayout>
  );
}
