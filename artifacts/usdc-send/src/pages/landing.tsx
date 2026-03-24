import { useState } from "react";
import { motion } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Wallet, ArrowRight, ShieldCheck, Mail, Zap, Loader2, CheckCircle2 } from "lucide-react";
import { useSendUSDC } from "@workspace/api-client-react";
import { useWeb3 } from "@/hooks/use-web3";
import { cn, formatAddress } from "@/lib/utils";
import { AppLayout } from "@/components/layout";

const sendSchema = z.object({
  recipientEmail: z.string().email("Please enter a valid email address"),
  amount: z.string().min(1, "Amount is required").refine(val => !isNaN(Number(val)) && Number(val) > 0, "Must be a positive number"),
});

type SendFormValues = z.infer<typeof sendSchema>;

export default function Landing() {
  const { address, connectWallet, isConnecting, depositToEscrow } = useWeb3();
  const sendMutation = useSendUSDC();
  const [txStatus, setTxStatus] = useState<"idle" | "approving" | "depositing" | "success">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<SendFormValues>({
    resolver: zodResolver(sendSchema),
  });

  const onSubmit = async (data: SendFormValues) => {
    try {
      let currentAddress = address;
      if (!currentAddress) {
        currentAddress = await connectWallet();
        if (!currentAddress) return;
      }

      setTxStatus("approving");
      
      // 1. Get escrow parameters from backend
      const response = await sendMutation.mutateAsync({
        data: {
          recipientEmail: data.recipientEmail,
          amount: data.amount,
          senderAddress: currentAddress,
        }
      });

      // 2. Execute on-chain transaction
      setTxStatus("depositing");
      const hash = await depositToEscrow(
        response.contractAddress,
        response.usdcAddress,
        response.emailHash,
        response.amountWei
      );

      setTxHash(hash);
      setTxStatus("success");
    } catch (error) {
      console.error(error);
      setTxStatus("idle");
      // Handle error gracefully via UI
      alert(error instanceof Error ? error.message : "Failed to complete transaction");
    }
  };

  return (
    <AppLayout>
      <div className="relative overflow-hidden min-h-[calc(100vh-5rem)] flex items-center">
        {/* Background Image & Effects */}
        <div className="absolute inset-0 -z-10">
          <img 
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`} 
            alt="Hero abstract background" 
            className="w-full h-full object-cover opacity-40"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/80 to-background"></div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-24 grid lg:grid-cols-2 gap-16 items-center">
          
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
              The funds are locked safely in a smart contract until they sign up and claim it.
            </p>

            <div className="grid sm:grid-cols-2 gap-6">
              <div className="flex gap-3">
                <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Secure Escrow</h3>
                  <p className="text-sm text-muted-foreground mt-1">Smart contract locked with email hashes.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="w-12 h-12 rounded-xl bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center shrink-0">
                  <Mail className="w-6 h-6 text-teal-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">No Onboarding</h3>
                  <p className="text-sm text-muted-foreground mt-1">They just need their email to claim funds.</p>
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
          >
            <div className="glass-panel rounded-3xl p-8 relative overflow-hidden">
              {/* Decorative gradients inside card */}
              <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
              
              {txStatus === "success" ? (
                <div className="text-center py-10">
                  <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-green-500/20">
                    <CheckCircle2 className="w-10 h-10" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Funds Sent Successfully!</h2>
                  <p className="text-muted-foreground mb-6">
                    The recipient has been notified and can claim their USDC at any time.
                  </p>
                  <button 
                    onClick={() => { setTxStatus("idle"); setTxHash(null); }}
                    className="px-6 py-3 bg-secondary text-foreground rounded-xl font-medium hover:bg-secondary/80 transition-colors"
                  >
                    Send Another Payment
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-8">
                    <h2 className="text-2xl font-bold font-display">Send Payment</h2>
                    {address ? (
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-sm font-medium border border-green-200">
                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                        {formatAddress(address)}
                      </div>
                    ) : (
                      <button 
                        onClick={connectWallet}
                        disabled={isConnecting}
                        className="flex items-center gap-2 px-4 py-2 bg-secondary text-foreground rounded-xl text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
                      >
                        <Wallet className="w-4 h-4" />
                        {isConnecting ? "Connecting..." : "Connect Wallet"}
                      </button>
                    )}
                  </div>

                  <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">Recipient Email</label>
                      <input 
                        {...register("recipientEmail")}
                        className={cn(
                          "w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none",
                          errors.recipientEmail && "border-destructive focus:border-destructive focus:ring-destructive/10"
                        )}
                        placeholder="satoshi@example.com"
                      />
                      {errors.recipientEmail && <p className="mt-1.5 text-sm text-destructive">{errors.recipientEmail.message}</p>}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">Amount (USDC)</label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                          <span className="text-muted-foreground font-medium">$</span>
                        </div>
                        <input 
                          {...register("amount")}
                          className={cn(
                            "w-full pl-8 pr-16 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none font-medium",
                            errors.amount && "border-destructive focus:border-destructive focus:ring-destructive/10"
                          )}
                          placeholder="100.00"
                          type="number"
                          step="0.01"
                        />
                        <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                          <span className="text-muted-foreground font-medium text-sm">USDC</span>
                        </div>
                      </div>
                      {errors.amount && <p className="mt-1.5 text-sm text-destructive">{errors.amount.message}</p>}
                    </div>

                    <button
                      type="submit"
                      disabled={txStatus !== "idle" && txStatus !== "success"}
                      className="w-full relative group flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-bold text-white overflow-hidden bg-primary disabled:opacity-70 disabled:cursor-not-allowed transition-all hover:shadow-xl hover:shadow-primary/30 active:scale-[0.98]"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-primary to-accent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                      <span className="relative z-10 flex items-center gap-2">
                        {txStatus === "approving" && <><Loader2 className="w-5 h-5 animate-spin" /> Approving USDC...</>}
                        {txStatus === "depositing" && <><Loader2 className="w-5 h-5 animate-spin" /> Depositing to Escrow...</>}
                        {txStatus === "idle" && (
                          <>
                            Lock & Send <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                          </>
                        )}
                      </span>
                    </button>
                  </form>
                </>
              )}
            </div>
          </motion.div>

        </div>
      </div>
    </AppLayout>
  );
}
