import { useState } from "react";
import { Link } from "wouter";
import { Mail, Lock, User, ArrowRight, Loader2, CheckCircle2, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { AppLayout } from "@/components/layout";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Step = "form" | "check-email";

export default function Register() {
  const [step, setStep]           = useState<Step>("form");
  const [sentEmail, setSentEmail] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError]         = useState("");
  const [resent, setResent]       = useState(false);

  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password) { setError("All fields are required."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setError("");
    setIsPending(true);
    try {
      const res  = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email: email.toLowerCase().trim(), password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? "Registration failed");
      setSentEmail(json.email ?? email.toLowerCase().trim());
      setStep("check-email");
    } catch (err: any) {
      setError(err.message ?? "Failed to create account. Please try again.");
    } finally {
      setIsPending(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setResent(false);
    setIsPending(true);
    try {
      await fetch(`${BASE}/api/auth/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: sentEmail }),
      });
      setResent(true);
    } catch {
      setError("Failed to resend. Please try again.");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AppLayout>
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="orb orb-violet w-[600px] h-[600px] top-[-150px] left-[-150px]" />
        <div className="orb orb-cyan w-[450px] h-[450px] bottom-[-100px] right-[-100px]" />
      </div>

      <div className="min-h-[calc(100vh-5rem)] flex items-center justify-center p-4">
        <div className="w-full max-w-md">

          <div className="flex justify-center mb-8">
            <Link href="/landing">
              <motion.div animate={{ y: [0, -4, 0] }} transition={{ repeat: Infinity, duration: 4, ease: "easeInOut" }}>
                <img src="/EPEE4721.JPG" alt="SEND" className="h-10 w-auto cursor-pointer" />
              </motion.div>
            </Link>
          </div>

          <AnimatePresence mode="wait">
            {step === "form" ? (
              <motion.div key="form" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
                <div className="text-center mb-8">
                  <h1 className="text-3xl font-display font-bold">Create Account</h1>
                  <p className="text-muted-foreground mt-2">Sign up to send and receive USDC.</p>
                </div>

                <div className="glass-panel p-8 rounded-3xl">
                  <AnimatePresence>
                    {error && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        className="mb-6 p-4 rounded-xl bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20 overflow-hidden">
                        {error}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <form onSubmit={handleRegister} className="space-y-5">
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">Full Name</label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground"><User className="w-5 h-5" /></div>
                        <input type="text" value={name} onChange={e => setName(e.target.value)}
                          className="w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none"
                          placeholder="Satoshi Nakamoto" autoComplete="name" required />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">Email</label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground"><Mail className="w-5 h-5" /></div>
                        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                          className="w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none"
                          placeholder="you@example.com" autoComplete="email" required />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">Password</label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground"><Lock className="w-5 h-5" /></div>
                        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                          className="w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none"
                          placeholder="••••••••" autoComplete="new-password" required />
                      </div>
                    </div>

                    <motion.button type="submit" disabled={isPending}
                      whileHover={!isPending ? { scale: 1.02, y: -1 } : {}} whileTap={!isPending ? { scale: 0.98 } : {}}
                      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold text-white bg-foreground hover:bg-foreground/90 hover:shadow-lg transition-all disabled:opacity-70 disabled:cursor-not-allowed">
                      {isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <><span>Create Account</span><ArrowRight className="w-5 h-5" /></>}
                    </motion.button>
                  </form>

                  <div className="mt-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      Already have an account?{" "}
                      <Link href="/login" className="font-semibold text-primary hover:underline">Log in</Link>
                    </p>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div key="check-email" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
                <div className="text-center mb-8">
                  <div className="flex justify-center mb-4">
                    <div className="w-16 h-16 rounded-2xl bg-violet-100 flex items-center justify-center">
                      <Mail className="w-8 h-8 text-violet-600" />
                    </div>
                  </div>
                  <h1 className="text-3xl font-display font-bold">Check your inbox</h1>
                  <p className="text-muted-foreground mt-2">
                    We've sent a verification link to{" "}
                    <span className="font-semibold text-foreground">{sentEmail}</span>
                  </p>
                </div>

                <div className="glass-panel p-8 rounded-3xl space-y-5">
                  <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-violet-50 border border-violet-200 text-violet-700 text-sm">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>Click the verification link in the email to activate your account. Once verified, you can sign in.</span>
                  </div>

                  <AnimatePresence>
                    {error && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        className="p-4 rounded-xl bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20 overflow-hidden">
                        {error}
                      </motion.div>
                    )}
                    {resent && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        className="p-4 rounded-xl bg-green-50 text-green-700 text-sm font-medium border border-green-200 overflow-hidden">
                        A new verification link has been sent.
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="text-center space-y-3">
                    <p className="text-sm text-muted-foreground">Didn't receive it? Check your spam folder or</p>
                    <button type="button" onClick={handleResend} disabled={isPending}
                      className="flex items-center gap-1.5 mx-auto text-sm font-medium text-primary hover:underline disabled:opacity-50">
                      <RefreshCw className="w-3.5 h-3.5" /> Resend verification email
                    </button>
                    <button type="button" onClick={() => { setStep("form"); setError(""); setResent(false); }}
                      className="block mx-auto text-sm text-muted-foreground hover:text-foreground transition-colors">
                      ← Use a different email
                    </button>
                  </div>

                  <div className="pt-2 border-t border-border text-center">
                    <p className="text-sm text-muted-foreground">
                      Already verified?{" "}
                      <Link href="/login" className="font-semibold text-primary hover:underline">Sign in</Link>
                    </p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </div>
      </div>
    </AppLayout>
  );
}
