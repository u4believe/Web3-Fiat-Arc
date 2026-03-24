import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { 
  Wallet, DollarSign, ArrowDownLeft, ArrowUpRight, 
  Clock, CheckCircle2, AlertCircle, Building2, Loader2 
} from "lucide-react";
import { 
  useGetCurrentUser, 
  useGetUserBalance, 
  useGetPendingEscrows, 
  useClaimEscrow,
  useGetEscrowHistory,
  useWithdrawCrypto,
  useWithdrawFiat
} from "@workspace/api-client-react";
import { cn, formatCurrency, formatAddress } from "@/lib/utils";
import { AppLayout } from "@/components/layout";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"history" | "withdraw">("history");
  const [withdrawMethod, setWithdrawMethod] = useState<"crypto" | "fiat">("crypto");

  const { data: user, isLoading: isUserLoading, isError: isUserError } = useGetCurrentUser({
    query: { retry: false }
  });
  const { data: balance, refetch: refetchBalance } = useGetUserBalance({ query: { enabled: !!user }});
  const { data: pending, refetch: refetchPending } = useGetPendingEscrows({ query: { enabled: !!user }});
  const { data: history } = useGetEscrowHistory({ query: { enabled: !!user }});
  
  const claimMutation = useClaimEscrow({
    mutation: {
      onSuccess: () => {
        refetchBalance();
        refetchPending();
        queryClient.invalidateQueries({ queryKey: ["/api/escrow/history"] });
      }
    }
  });

  const withdrawCryptoMutation = useWithdrawCrypto({
    mutation: { onSuccess: () => { refetchBalance(); } }
  });

  const withdrawFiatMutation = useWithdrawFiat({
    mutation: { onSuccess: () => { refetchBalance(); } }
  });

  useEffect(() => {
    if (!isUserLoading && isUserError) {
      setLocation("/login");
    }
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

  const handleClaim = () => {
    claimMutation.mutate({ data: {} });
  };

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Top Balances */}
        <div className="grid md:grid-cols-2 gap-6">
          <div className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-primary to-accent text-white border-none relative overflow-hidden">
            <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/4"></div>
            <div className="flex items-center gap-3 mb-4 text-white/80 font-medium">
              <DollarSign className="w-5 h-5" />
              Claimed Balance
            </div>
            <div className="text-4xl lg:text-5xl font-display font-bold tracking-tight mb-2">
              {balance ? formatCurrency(balance.claimedBalance) : "$0.00"}
            </div>
            <div className="text-white/70 text-sm">Available to withdraw instantly</div>
          </div>

          <div className="glass-panel p-6 rounded-3xl relative overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3 text-muted-foreground font-medium">
                <Clock className="w-5 h-5" />
                Pending Escrow
              </div>
              {Number(pending?.totalPendingAmount || 0) > 0 && (
                <button
                  onClick={handleClaim}
                  disabled={claimMutation.isPending}
                  className="px-4 py-2 bg-primary text-primary-foreground text-sm font-bold rounded-lg hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20 flex items-center gap-2 disabled:opacity-70"
                >
                  {claimMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Claim All
                </button>
              )}
            </div>
            <div className="text-4xl lg:text-5xl font-display font-bold text-foreground tracking-tight mb-2">
              {pending ? formatCurrency(pending.totalPendingAmount) : "$0.00"}
            </div>
            <div className="text-muted-foreground text-sm">
              {pending?.escrows.length || 0} transfer(s) waiting for you
            </div>
          </div>
        </div>

        {/* Content Tabs */}
        <div className="bg-white rounded-3xl shadow-sm border border-border overflow-hidden">
          <div className="flex border-b border-border">
            <button 
              onClick={() => setActiveTab("history")}
              className={cn("flex-1 py-4 text-center font-semibold transition-colors", activeTab === "history" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}
            >
              Transaction History
            </button>
            <button 
              onClick={() => setActiveTab("withdraw")}
              className={cn("flex-1 py-4 text-center font-semibold transition-colors", activeTab === "withdraw" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}
            >
              Withdraw Funds
            </button>
          </div>

          <div className="p-6 lg:p-8 min-h-[400px]">
            {activeTab === "history" && (
              <div className="space-y-6">
                {!history || (history.sent.length === 0 && history.received.length === 0) ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Clock className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p>No transactions yet</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {[...history.received, ...history.sent]
                      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                      .map((tx) => {
                        const isReceived = !!tx.recipientEmail && tx.recipientEmail === user.email;
                        return (
                          <div key={tx.id} className="flex items-center justify-between p-4 rounded-2xl border border-border/50 hover:bg-secondary/20 transition-colors">
                            <div className="flex items-center gap-4">
                              <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", isReceived ? "bg-green-100 text-green-600" : "bg-blue-100 text-blue-600")}>
                                {isReceived ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
                              </div>
                              <div>
                                <p className="font-semibold text-foreground">
                                  {isReceived ? "Received USDC" : "Sent USDC"}
                                </p>
                                <p className="text-xs text-muted-foreground flex items-center gap-2">
                                  {format(new Date(tx.createdAt), "MMM d, yyyy 'at' h:mm a")}
                                  <span className="w-1 h-1 rounded-full bg-border"></span>
                                  {tx.status}
                                </p>
                              </div>
                            </div>
                            <div className="text-right">
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

            {activeTab === "withdraw" && (
              <div className="max-w-2xl mx-auto">
                <div className="flex gap-2 p-1 bg-secondary rounded-xl mb-8">
                  <button 
                    onClick={() => setWithdrawMethod("crypto")}
                    className={cn("flex-1 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all", withdrawMethod === "crypto" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    <Wallet className="w-4 h-4" /> Crypto Wallet
                  </button>
                  <button 
                    onClick={() => setWithdrawMethod("fiat")}
                    className={cn("flex-1 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all", withdrawMethod === "fiat" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    <Building2 className="w-4 h-4" /> Bank Transfer
                  </button>
                </div>

                {withdrawMethod === "crypto" && (
                  <CryptoWithdrawalForm mutation={withdrawCryptoMutation} maxAmount={balance?.claimedBalance || "0"} />
                )}

                {withdrawMethod === "fiat" && (
                  <FiatWithdrawalForm mutation={withdrawFiatMutation} maxAmount={balance?.claimedBalance || "0"} />
                )}
              </div>
            )}
          </div>
        </div>

      </div>
    </AppLayout>
  );
}

// Subcomponents for forms
function CryptoWithdrawalForm({ mutation, maxAmount }: { mutation: any, maxAmount: string }) {
  const schema = z.object({
    walletAddress: z.string().min(42, "Invalid EVM address"),
    amount: z.string().refine(v => Number(v) > 0 && Number(v) <= Number(maxAmount), `Invalid amount. Max: ${maxAmount}`)
  });

  const { register, handleSubmit, formState: { errors }, reset } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async (data: any) => {
    try {
      await mutation.mutateAsync({ data });
      alert("Withdrawal successful!");
      reset();
    } catch (e: any) {
      alert(e.message || "Withdrawal failed");
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">Destination Wallet Address (USDC)</label>
        <input {...register("walletAddress")} placeholder="0x..." className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary outline-none" />
        {errors.walletAddress && <p className="text-destructive text-sm mt-1">{errors.walletAddress.message as string}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">Amount (Max: {formatCurrency(maxAmount)})</label>
        <input {...register("amount")} placeholder="10.00" type="number" step="0.01" className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary outline-none" />
        {errors.amount && <p className="text-destructive text-sm mt-1">{errors.amount.message as string}</p>}
      </div>
      <button type="submit" disabled={mutation.isPending} className="w-full bg-primary text-white font-bold py-4 rounded-xl flex justify-center hover:bg-primary/90 transition-colors">
        {mutation.isPending ? <Loader2 className="w-6 h-6 animate-spin" /> : "Withdraw to Wallet"}
      </button>
    </form>
  );
}

function FiatWithdrawalForm({ mutation, maxAmount }: { mutation: any, maxAmount: string }) {
  const schema = z.object({
    accountHolderName: z.string().min(2, "Required"),
    bankAccountNumber: z.string().min(5, "Required"),
    routingNumber: z.string().min(5, "Required"),
    amount: z.string().refine(v => Number(v) > 0 && Number(v) <= Number(maxAmount), `Invalid amount. Max: ${maxAmount}`)
  });

  const { register, handleSubmit, formState: { errors }, reset } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async (data: any) => {
    try {
      await mutation.mutateAsync({ data: { ...data, country: "US" } });
      alert("Wire transfer initiated!");
      reset();
    } catch (e: any) {
      alert(e.message || "Withdrawal failed");
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-2">Account Holder Name</label>
          <input {...register("accountHolderName")} className="w-full px-4 py-3 rounded-xl border-2 border-border focus:border-primary outline-none" />
          {errors.accountHolderName && <p className="text-destructive text-sm mt-1">{errors.accountHolderName.message as string}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Routing Number</label>
          <input {...register("routingNumber")} className="w-full px-4 py-3 rounded-xl border-2 border-border focus:border-primary outline-none" />
          {errors.routingNumber && <p className="text-destructive text-sm mt-1">{errors.routingNumber.message as string}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Account Number</label>
          <input {...register("bankAccountNumber")} className="w-full px-4 py-3 rounded-xl border-2 border-border focus:border-primary outline-none" />
          {errors.bankAccountNumber && <p className="text-destructive text-sm mt-1">{errors.bankAccountNumber.message as string}</p>}
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-2">Amount to Withdraw (Max: {formatCurrency(maxAmount)})</label>
          <input {...register("amount")} type="number" step="0.01" className="w-full px-4 py-3 rounded-xl border-2 border-border focus:border-primary outline-none" />
          {errors.amount && <p className="text-destructive text-sm mt-1">{errors.amount.message as string}</p>}
        </div>
      </div>
      <button type="submit" disabled={mutation.isPending} className="w-full bg-primary text-white font-bold py-4 rounded-xl flex justify-center hover:bg-primary/90 transition-colors">
        {mutation.isPending ? <Loader2 className="w-6 h-6 animate-spin" /> : "Initiate Wire Transfer"}
      </button>
    </form>
  );
}
