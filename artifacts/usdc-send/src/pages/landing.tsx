import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowRight,
  ShieldCheck,
  Mail,
  Zap,
  Loader2,
  CheckCircle2,
  AlertCircle,
  LogIn,
  UserPlus,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AppLayout } from "@/components/layout";
import { fadeUp, slideLeft, slideRight, scaleIn, staggerContainer, fadeIn } from "@/lib/motion";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const sendSchema = z.object({
  recipientEmail: z.string().email("Please enter a valid email address"),
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((v) => !isNaN(Number(v)) && Number(v) > 0, "Must be a positive number")
    .refine((v) => Number(v) >= 0.01, "Minimum send is $0.01 USDC"),
});

type SendFormValues = z.infer<typeof sendSchema>;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className="p-1 rounded hover:bg-white/20 transition-colors" title="Copy">
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />}
    </button>
  );
}

export default function Landing() {
  const [, navigate] = useLocation();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isSending,    setIsSending]    = useState(false);
  const [formError,    setFormError]    = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState("");
  const [successAmount, setSuccessAmount] = useState("");
  const [didSucceed,   setDidSucceed]   = useState(false);

  useEffect(() => {
    setIsLoggedIn(!!localStorage.getItem("token"));
  }, []);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<SendFormValues>({
    resolver: zodResolver(sendSchema),
  });

  const onSubmit = async (data: SendFormValues) => {
    if (!isLoggedIn) {
      navigate(`${BASE}/login`);
      return;
    }
    setFormError(null);
    setIsSending(true);
    try {
      const jwt = localStorage.getItem("token");
      const sendHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (jwt) sendHeaders["Authorization"] = `Bearer ${jwt}`;
      const res = await fetch(`${BASE}/api/escrow/send/platform`, {
        method: "POST",
        headers: sendHeaders,
        body: JSON.stringify({
          recipientEmail: data.recipientEmail.toLowerCase().trim(),
          amount: data.amount,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? "Failed to send payment");
      setSuccessEmail(data.recipientEmail.toLowerCase().trim());
      setSuccessAmount(data.amount);
      setDidSucceed(true);
    } catch (err: any) {
      setFormError(err?.message ?? "Failed to send. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  const handleSendAnother = () => {
    setDidSucceed(false);
    setFormError(null);
    setSuccessEmail("");
    setSuccessAmount("");
    reset();
  };

  const isBusy = isSending;

  return (
    <AppLayout>
      <div className="relative overflow-hidden min-h-[calc(100vh-5rem)] flex items-center">

        {/* ── Animated background ──────────────────────────────────────────── */}
        <div className="absolute inset-0 -z-10">
          <img
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`}
            alt=""
            className="w-full h-full object-cover opacity-30"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/70 to-background" />

          {/* Floating gradient orbs */}
          <div className="orb orb-blue w-[500px] h-[500px] top-[-100px] left-[10%]" />
          <div className="orb orb-cyan w-[400px] h-[400px] top-[20%] right-[5%]" />
          <div className="orb orb-violet w-[350px] h-[350px] bottom-[10%] left-[30%]" />

          {/* Subtle grid overlay */}
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage: "linear-gradient(#1e40af 1px, transparent 1px), linear-gradient(to right, #1e40af 1px, transparent 1px)",
              backgroundSize: "60px 60px",
            }}
          />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-24 grid lg:grid-cols-2 gap-16 items-center">

          {/* ── Left — hero copy ──────────────────────────────────────────── */}
          <motion.div
            variants={staggerContainer(0.12, 0.1)}
            initial="hidden"
            animate="show"
            className="max-w-2xl"
          >
            {/* Badge */}
            <motion.div variants={fadeUp}>
              <motion.div
                whileHover={{ scale: 1.04 }}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary font-medium text-sm mb-6 border border-primary/20 cursor-default"
              >
                <motion.div
                  animate={{ rotate: [0, 15, -15, 0] }}
                  transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
                >
                  <Zap className="w-4 h-4" />
                </motion.div>
                <span>Instant Web3 + Web2 Escrow</span>
              </motion.div>
            </motion.div>

            {/* Heading */}
            <motion.div variants={fadeUp}>
              <h1 className="text-5xl lg:text-6xl font-bold text-foreground leading-tight mb-6">
                Send USDC to{" "}
                <br />
                <span className="text-gradient-animated">Any Email Address</span>
              </h1>
            </motion.div>

            {/* Subtitle */}
            <motion.p variants={fadeUp} className="text-lg text-muted-foreground mb-10 leading-relaxed">
              No wallet required for the recipient. Send stablecoins instantly.
              The funds are locked safely in a smart contract until they sign up and claim it.
            </motion.p>

            {/* Feature pills */}
            <motion.div variants={staggerContainer(0.1)} className="grid sm:grid-cols-2 gap-5">
              {[
                {
                  icon: <ShieldCheck className="w-6 h-6 text-primary" />,
                  bg: "bg-blue-100",
                  title: "Secure Escrow",
                  desc: "Smart contract locked with email hashes.",
                },
                {
                  icon: <Mail className="w-6 h-6 text-teal-600" />,
                  bg: "bg-teal-100",
                  title: "No Onboarding",
                  desc: "They just need their email to claim funds.",
                },
              ].map((f) => (
                <motion.div
                  key={f.title}
                  variants={fadeUp}
                  whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
                  className="flex gap-3 p-4 rounded-2xl bg-white/60 backdrop-blur border border-white/60 shadow-sm"
                >
                  <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center shrink-0", f.bg)}>
                    {f.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{f.title}</h3>
                    <p className="text-sm text-muted-foreground mt-0.5">{f.desc}</p>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>

          {/* ── Right — send card ─────────────────────────────────────────── */}
          <motion.div
            variants={slideRight}
            initial="hidden"
            animate="show"
            transition={{ delay: 0.25 }}
          >
            {/* Decorative spinning rings behind card */}
            <div className="relative">
              <div className="absolute inset-0 -m-8 pointer-events-none">
                <div className="absolute inset-0 rounded-full border border-primary/10 spin-slow" />
                <div className="absolute inset-4 rounded-full border border-accent/10 spin-slow-reverse" />
              </div>

              <motion.div
                animate={{ y: [0, -8, 0] }}
                transition={{ repeat: Infinity, duration: 5, ease: "easeInOut" }}
                className="glass-panel rounded-3xl p-8 relative overflow-hidden"
              >
                {/* Decorative inner glow */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-accent/5 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2 pointer-events-none" />

                <AnimatePresence mode="wait">
                  {/* ── Success state ── */}
                  {didSucceed ? (
                    <motion.div
                      key="success"
                      variants={scaleIn}
                      initial="hidden"
                      animate="show"
                      exit="hidden"
                      className="text-center py-6"
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
                        <motion.h2 variants={fadeUp} className="text-2xl font-bold mb-1">Funds Sent!</motion.h2>
                        <motion.p variants={fadeUp} className="text-muted-foreground text-sm mb-3">
                          <span className="font-medium text-foreground">${successAmount} USDC</span>{" "}
                          is locked in escrow for{" "}
                          <span className="font-medium text-foreground">{successEmail}</span>.
                          They can claim it any time after signing up.
                        </motion.p>
                        <motion.div variants={fadeUp} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-50 text-violet-700 text-xs font-medium border border-violet-200 mb-5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Sent from your platform balance — no wallet needed
                        </motion.div>
                        <br />
                        <motion.button
                          variants={fadeUp}
                          whileHover={{ scale: 1.03 }}
                          whileTap={{ scale: 0.97 }}
                          onClick={handleSendAnother}
                          className="px-6 py-3 bg-secondary text-foreground rounded-xl font-medium hover:bg-secondary/80 transition-colors"
                        >
                          Send Another Payment
                        </motion.button>
                      </motion.div>
                    </motion.div>
                  ) : (
                    /* ── Form state ── */
                    <motion.div key="form" variants={fadeIn} initial="hidden" animate="show" exit="hidden">
                      {/* Header */}
                      <div className="flex items-center justify-between mb-5">
                        <h2 className="text-2xl font-bold font-display">Send Payment</h2>
                        {isLoggedIn ? (
                          <motion.div
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 text-violet-700 rounded-full text-xs font-semibold border border-violet-200"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            No wallet needed
                          </motion.div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <motion.a
                              href={`${BASE}/login`}
                              whileHover={{ scale: 1.03 }}
                              whileTap={{ scale: 0.97 }}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-foreground rounded-xl text-xs font-medium hover:bg-secondary/80 transition-colors"
                            >
                              <LogIn className="w-3.5 h-3.5" />
                              Sign In
                            </motion.a>
                            <motion.a
                              href={`${BASE}/register`}
                              whileHover={{ scale: 1.03 }}
                              whileTap={{ scale: 0.97 }}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-xl text-xs font-medium hover:bg-primary/90 transition-colors"
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                              Create Account
                            </motion.a>
                          </div>
                        )}
                      </div>

                      {/* Sign-in prompt for unauthenticated users */}
                      {!isLoggedIn && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="flex items-start gap-3 px-4 py-3 mb-5 rounded-xl bg-primary/5 border border-primary/10 text-sm text-muted-foreground"
                        >
                          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                          <span>Sign in or create a free account to send USDC without a crypto wallet.</span>
                        </motion.div>
                      )}

                      {/* Inline error */}
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

                      <motion.form
                        onSubmit={handleSubmit(onSubmit)}
                        variants={staggerContainer(0.08, 0.05)}
                        initial="hidden"
                        animate="show"
                        className="space-y-5"
                      >
                        <motion.div variants={fadeUp}>
                          <label className="block text-sm font-medium text-foreground mb-2">Recipient Email</label>
                          <input
                            {...register("recipientEmail")}
                            disabled={isBusy}
                            className={cn(
                              "w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none disabled:opacity-60",
                              errors.recipientEmail && "border-destructive focus:border-destructive focus:ring-destructive/10",
                            )}
                            placeholder="satoshi@example.com"
                            type="email"
                            autoComplete="email"
                          />
                          <AnimatePresence>
                            {errors.recipientEmail && (
                              <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-destructive">
                                {errors.recipientEmail.message}
                              </motion.p>
                            )}
                          </AnimatePresence>
                        </motion.div>

                        <motion.div variants={fadeUp}>
                          <label className="block text-sm font-medium text-foreground mb-2">Amount (USDC)</label>
                          <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                              <span className="text-muted-foreground font-medium">$</span>
                            </div>
                            <input
                              {...register("amount")}
                              disabled={isBusy}
                              className={cn(
                                "w-full pl-8 pr-16 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none font-medium disabled:opacity-60",
                                errors.amount && "border-destructive focus:border-destructive focus:ring-destructive/10",
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
                          <AnimatePresence>
                            {errors.amount && (
                              <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-destructive">
                                {errors.amount.message}
                              </motion.p>
                            )}
                          </AnimatePresence>
                        </motion.div>

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
                              {isBusy
                                ? <><Loader2 className="w-5 h-5 animate-spin" />Sending…</>
                                : isLoggedIn
                                  ? <>Lock &amp; Send <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" /></>
                                  : <>Sign In to Send <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" /></>
                              }
                            </span>
                          </motion.button>
                        </motion.div>
                      </motion.form>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </div>
    </AppLayout>
  );
}
