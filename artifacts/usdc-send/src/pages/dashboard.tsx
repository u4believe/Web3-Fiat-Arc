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
  Repeat,
  Trash2,
  CalendarDays,
  Plus,
  X,
  KeyRound,
  Lock,
  LockKeyhole,
  Eye,
  EyeOff,
  RefreshCw,
  PlusCircle,
  QrCode,
  Landmark,
  LayoutDashboard,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Menu,
  Home,
} from "lucide-react";
import {
  useGetCurrentUser,
  useGetUserBalance,
  useGetPendingEscrows,
  useGetEscrowHistory,
  useWithdrawCrypto,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { cn, formatCurrency } from "@/lib/utils";
import { AppLayout, Navbar } from "@/components/layout";
import { fadeUp, scaleIn, staggerContainer, fadeIn } from "@/lib/motion";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const ARC_EXPLORER = "https://explorer.arc.io/tx/";

// Block explorer URLs — keys are substrings matched against the network field
// (network can be "Base Sepolia USDC", "Polygon Amoy USDC", etc.)
const EXPLORER_BASE: Array<{ match: string; url: string }> = [
  { match: "base sepolia",      url: "https://sepolia.basescan.org/tx/" },
  { match: "ethereum sepolia",  url: "https://sepolia.etherscan.io/tx/" },
  { match: "polygon amoy",      url: "https://amoy.polygonscan.com/tx/" },
];

function getExplorerUrl(network: string, txHash: string): string | null {
  if (!txHash) return null;
  const lower = network.toLowerCase();
  const entry = EXPLORER_BASE.find((e) => lower.includes(e.match));
  return entry ? entry.url + txHash : null;
}

interface UnifiedTx {
  id: string;
  category: "deposit" | "withdrawal" | "escrow";
  currency: "USDC" | "USD";
  direction: "in" | "out";
  amount: string;
  status: string;
  network: string;
  txHash: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  description: string;
  createdAt: string;
  completedAt: string | null;
}

interface FullBalance {
  onChainUsdcBalance: string;
  onChainLastUpdated: string | null;
  claimedBalance: string;
  pendingBalance: string;
  usdBalance: string;
  usdEquivalent: string;
}

type ClaimStep = "idle" | "processing" | "success" | "error";

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

function ClaimProgress({ step }: { step: ClaimStep }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <motion.div
        animate={{ rotate: step === "processing" ? 360 : 0 }}
        transition={{ repeat: step === "processing" ? Infinity : 0, duration: 1, ease: "linear" }}
      >
        <Loader2 className={cn("w-4 h-4", step === "processing" ? "text-primary" : "text-green-500")} />
      </motion.div>
      <span className="text-sm font-medium text-primary">
        {step === "processing" && "Claiming your funds via Circle…"}
        {step === "success" && "Claimed successfully!"}
      </span>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

type ActivePage = "dashboard" | "send-usd" | "send-usdc" | "fund" | "recurring" | "security";

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  collapsed: boolean;
  badge?: number;
}

function SidebarItem({ icon, label, active, onClick, collapsed, badge }: SidebarItemProps) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
        active
          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        collapsed && "justify-center px-2",
      )}
    >
      <span className="shrink-0 w-5 h-5 flex items-center justify-center">{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && badge != null && badge > 0 && (
        <span className="ml-auto text-[10px] font-bold bg-primary/20 text-primary rounded-full px-1.5 py-0.5 leading-none">{badge}</span>
      )}
    </button>
  );
}

interface SendMenuProps {
  activePage: ActivePage;
  onNavigate: (p: ActivePage) => void;
  collapsed: boolean;
}

function SendSubMenu({ activePage, onNavigate, collapsed }: SendMenuProps) {
  const [open, setOpen] = useState(activePage === "send-usd" || activePage === "send-usdc");

  useEffect(() => {
    if (activePage === "send-usd" || activePage === "send-usdc") setOpen(true);
  }, [activePage]);

  const isSendActive = activePage === "send-usd" || activePage === "send-usdc";

  if (collapsed) {
    return (
      <>
        <SidebarItem icon={<Send className="w-4 h-4" />} label="Send USD" active={activePage === "send-usd"} onClick={() => onNavigate("send-usd")} collapsed />
        <SidebarItem icon={<ArrowUpRight className="w-4 h-4" />} label="Send USDC" active={activePage === "send-usdc"} onClick={() => onNavigate("send-usdc")} collapsed />
      </>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
          isSendActive ? "text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        )}
      >
        <span className="shrink-0 w-5 h-5 flex items-center justify-center">
          <Send className="w-4 h-4" />
        </span>
        <span className="truncate flex-1 text-left">Send</span>
        <ChevronDown className={cn("w-4 h-4 transition-transform shrink-0", open && "rotate-180")} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="send-sub"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="ml-4 mt-1 space-y-0.5 border-l border-border pl-3">
              <SidebarItem icon={<Mail className="w-4 h-4" />} label="Send USD" active={activePage === "send-usd"} onClick={() => onNavigate("send-usd")} collapsed={false} />
              <SidebarItem icon={<ArrowUpRight className="w-4 h-4" />} label="Send USDC" active={activePage === "send-usdc"} onClick={() => onNavigate("send-usdc")} collapsed={false} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface DashSidebarProps {
  activePage: ActivePage;
  onNavigate: (p: ActivePage) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  user: any;
}

function DashSidebar({ activePage, onNavigate, collapsed, onToggleCollapse, mobileOpen, user }: DashSidebarProps) {
  const [, setLocation] = useLocation();

  const handleLogout = () => {
    localStorage.removeItem("token");
    setLocation("/login");
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Sidebar header — collapse toggle only */}
      <div className="flex items-center justify-end px-3 py-3 border-b border-border">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          title="Collapse sidebar"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <SidebarItem
          icon={<Home className="w-4 h-4" />}
          label="Home"
          active={false}
          onClick={() => setLocation("/landing")}
          collapsed={collapsed}
        />
        <SidebarItem
          icon={<LayoutDashboard className="w-4 h-4" />}
          label="Dashboard"
          active={activePage === "dashboard"}
          onClick={() => onNavigate("dashboard")}
          collapsed={collapsed}
        />

        <SendSubMenu activePage={activePage} onNavigate={onNavigate} collapsed={collapsed} />

        <SidebarItem
          icon={<PlusCircle className="w-4 h-4" />}
          label="Fund"
          active={activePage === "fund"}
          onClick={() => onNavigate("fund")}
          collapsed={collapsed}
        />

        <SidebarItem
          icon={<Repeat className="w-4 h-4" />}
          label="Recurring"
          active={activePage === "recurring"}
          onClick={() => onNavigate("recurring")}
          collapsed={collapsed}
        />

        <SidebarItem
          icon={<LockKeyhole className="w-4 h-4" />}
          label="Security"
          active={activePage === "security"}
          onClick={() => onNavigate("security")}
          collapsed={collapsed}
        />
      </nav>

      {/* User + logout */}
      <div className={cn("border-t border-border p-2 space-y-1", collapsed && "px-1")}>
        {!collapsed && (
          <div className="px-3 py-2">
            <p className="text-xs font-semibold text-foreground truncate">{user?.name ?? "User"}</p>
            <p className="text-[11px] text-muted-foreground truncate">{user?.email ?? ""}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          title={collapsed ? "Log out" : undefined}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all",
            collapsed && "justify-center px-2",
          )}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — fully hidden when collapsed */}
      <aside
        className={cn(
          "hidden lg:flex flex-col fixed left-0 top-20 h-[calc(100vh-5rem)] bg-white/95 backdrop-blur border-r border-border z-30 transition-all duration-300 w-60",
          collapsed && "translate-x-[-100%]",
        )}
      >
        {sidebarContent}
      </aside>

      {/* Floating expand button — shown when sidebar is fully hidden */}
      {collapsed && (
        <button
          onClick={onToggleCollapse}
          className="hidden lg:flex fixed left-0 top-[calc(50%+2.5rem)] -translate-y-1/2 z-40 items-center justify-center bg-white border border-border border-l-0 rounded-r-xl w-6 h-12 shadow-md hover:bg-secondary transition-colors"
          title="Show sidebar"
        >
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "lg:hidden fixed left-0 top-0 h-screen w-72 bg-white z-50 flex flex-col border-r border-border shadow-2xl transition-transform duration-300",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {sidebarContent}
      </aside>
    </>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [activePage,       setActivePage]       = useState<ActivePage>("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen,       setMobileOpen]       = useState(false);
  const [fundMethod,       setFundMethod]       = useState<"crypto" | "bank">("crypto");

  const [claimStep, setClaimStep]       = useState<ClaimStep>("idle");
  const [claimError, setClaimError]     = useState<string | null>(null);
  const [claimTxHash, setClaimTxHash]   = useState<string | null>(null);
  const [claimTotal, setClaimTotal]     = useState<string | null>(null);

  const { data: user, isLoading: isUserLoading, isError: isUserError } =
    useGetCurrentUser({ query: { retry: false } });
  const { data: balance, refetch: refetchBalance } =
    useGetUserBalance({ query: { enabled: !!user } });
  const bal = balance as FullBalance | undefined;
  const { data: pending, refetch: refetchPending } =
    useGetPendingEscrows({ query: { enabled: !!user } });
  const { data: history } =
    useGetEscrowHistory({ query: { enabled: !!user } });

  // Unified transaction history (deposits + withdrawals + escrow)
  const { data: txHistory } = useQuery({
    queryKey: ["/api/user/history"],
    enabled: !!user,
    staleTime: 0,                   // always consider data stale — refetch eagerly
    refetchInterval: 5_000,         // poll every 5 s (matches indexer cadence)
    refetchOnWindowFocus: true,     // refresh instantly when user switches back to tab
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/user/history`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      if (!res.ok) throw new Error("Failed to fetch history");
      return res.json() as Promise<{ transactions: UnifiedTx[]; total: number }>;
    },
  });

  const [selectedTx, setSelectedTx] = useState<UnifiedTx | null>(null);

  const invalidateHistory = () => queryClient.invalidateQueries({ queryKey: ["/api/user/history"] });

  const withdrawCryptoMutation = useWithdrawCrypto({
    mutation: {
      onSuccess: () => {
        refetchBalance();
        invalidateHistory();
      },
    },
  });

  useEffect(() => {
    if (!isUserLoading && isUserError) setLocation("/login");
  }, [isUserLoading, isUserError, setLocation]);

  // Reset to account overview when the header "Dashboard" link is clicked
  useEffect(() => {
    const handler = () => setActivePage("dashboard");
    window.addEventListener("nav:dashboard-overview", handler);
    return () => window.removeEventListener("nav:dashboard-overview", handler);
  }, []);

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

  // Wallet-free server-side claim — uses the platform's Circle-managed backend wallet.
  // No MetaMask or browser extension required.
  const handleClaim = async () => {
    setClaimError(null);
    setClaimTxHash(null);
    setClaimTotal(null);
    setClaimStep("processing");
    try {
      const jwt = localStorage.getItem("token");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
      const res = await fetch(`${BASE}/api/escrow/claim/auto`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Claim failed");
      }
      const data = await res.json();
      setClaimTotal(data.totalClaimed);
      if (data.txHash) setClaimTxHash(data.txHash);
      setClaimStep("success");
      refetchBalance();
      refetchPending();
      queryClient.invalidateQueries({ queryKey: ["/api/escrow/history"] });
      invalidateHistory();
    } catch (err: any) {
      setClaimError(err?.message ?? "Claim failed. Please try again.");
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
  const isClaiming  = claimStep === "processing";
  const circleWallet = (user as any)?.circleWalletAddress as string | undefined;

  return (
    <div className="min-h-screen bg-background">
      {/* Background orbs */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="orb orb-blue w-[500px] h-[500px] top-[-100px] right-[-100px] opacity-60" />
        <div className="orb orb-violet w-[400px] h-[400px] bottom-0 left-[-100px] opacity-40" />
      </div>

      <Navbar />

      <div className="flex pt-20 min-h-[calc(100vh-80px)]">
        {/* Mobile overlay */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
              onClick={() => setMobileOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Sidebar */}
        <DashSidebar
          activePage={activePage}
          onNavigate={(page) => { setActivePage(page); setMobileOpen(false); }}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          mobileOpen={mobileOpen}
          user={user as any}
        />

        {/* Main content — offset by sidebar width */}
        <main className={cn(
          "flex-1 overflow-y-auto transition-all duration-300",
          sidebarCollapsed ? "lg:ml-0" : "lg:ml-60",
        )}>
          {/* Mobile top bar */}
          <div className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 bg-white/80 backdrop-blur border-b border-border lg:hidden">
            <button
              onClick={() => setMobileOpen(true)}
              className="p-2 rounded-xl bg-white border border-border shadow-sm"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="font-semibold text-foreground text-sm">
              {activePage === "dashboard" ? "Dashboard" :
               activePage === "send-usd"  ? "Send USD"  :
               activePage === "send-usdc" ? "Send USDC" :
               activePage === "fund"      ? "Fund"      :
               activePage === "recurring" ? "Recurring" : "Security"}
            </span>
          </div>

          <AnimatePresence mode="wait">

            {/* ── DASHBOARD PAGE ─────────────────────────────────────────── */}
            {activePage === "dashboard" && (
              <motion.div
                key="page-dashboard"
                variants={staggerContainer(0.08, 0)}
                initial="hidden"
                animate="show"
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6"
              >
                {/* Page header */}
                <motion.div variants={fadeUp} className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-bold font-display text-foreground">
                      Welcome back, {user.name.split(" ")[0]} 👋
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">Here's your account overview</p>
                  </div>
                </motion.div>

                {/* Balance cards */}
                <div className="grid md:grid-cols-2 gap-5">
                  <motion.div
                    variants={fadeUp}
                    whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
                    className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-primary to-accent text-white border-none relative overflow-hidden"
                  >
                    <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-40 h-40 bg-white/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/4 pointer-events-none" />
                    <div className="flex items-center gap-2 mb-4 text-white/80 text-sm font-medium">
                      <DollarSign className="w-4 h-4" /> USD Balance
                    </div>
                    <div className="text-4xl lg:text-5xl font-display font-bold tracking-tight mb-1">
                      {bal ? <AnimatedAmount value={bal.usdBalance} /> : "$0.00"}
                    </div>
                    <div className="text-white/70 text-xs mb-5">Backed 1:1 by USDC · stablecoin</div>
                    <div className="space-y-2 border-t border-white/20 pt-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-white/70 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-300 inline-block" /> On-chain escrow
                        </span>
                        <span className="font-semibold tabular-nums text-sm">{bal ? formatCurrency(bal.onChainUsdcBalance) : "$0.00"}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-white/70 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-300 inline-block" /> Credited balance
                        </span>
                        <span className="font-semibold tabular-nums text-sm">{bal ? formatCurrency(bal.claimedBalance) : "$0.00"}</span>
                      </div>
                    </div>
                  </motion.div>

                  <motion.div
                    variants={fadeUp}
                    whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
                    className="glass-panel p-6 rounded-3xl relative overflow-hidden"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
                        <Clock className="w-4 h-4" /> Pending Escrow
                      </div>
                      <AnimatePresence>
                        {hasPending && claimStep === "idle" && (
                          <motion.button initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}
                            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                            onClick={handleClaim} disabled={isClaiming}
                            className="px-3 py-1.5 bg-primary text-primary-foreground text-xs font-bold rounded-lg shadow-lg shadow-primary/20 flex items-center gap-1.5 disabled:opacity-70"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" /> Claim All
                          </motion.button>
                        )}
                        {claimStep === "success" && (
                          <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={handleClaimReset}
                            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >Done</motion.button>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="text-4xl lg:text-5xl font-display font-bold text-foreground tracking-tight mb-1">
                      {pending ? <AnimatedAmount value={String(pending.totalPendingAmount)} /> : "$0.00"}
                    </div>
                    <div className="text-muted-foreground text-xs mb-2">{pending?.escrows?.length || 0} transfer(s) awaiting claim</div>
                    {isClaiming && <ClaimProgress step={claimStep} />}
                    <AnimatePresence>
                      {claimStep === "success" && (
                        <motion.div initial={{ opacity: 0, scale: 0.9, height: 0 }} animate={{ opacity: 1, scale: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                          className="mt-3 p-3 rounded-xl bg-green-50 border border-green-200 overflow-hidden"
                        >
                          <div className="flex items-center gap-2 text-green-700 font-semibold text-sm mb-1">
                            <CheckCircle2 className="w-4 h-4" />
                            {claimTotal ? `${claimTotal} USD claimed!` : "Claimed successfully!"}
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
                          <button onClick={handleClaimReset} className="mt-2 text-sm text-primary hover:underline">Try again</button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                </div>

                {/* Deposit address strip */}
                {circleWallet && (
                  <motion.div variants={fadeUp}
                    className="glass-panel p-4 rounded-2xl flex items-center justify-between gap-4 bg-gradient-to-r from-violet-50/80 to-blue-50/80 border border-violet-100"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center shrink-0 shadow-lg shadow-violet-200">
                        <ShieldCheck className="w-4 h-4 text-white" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-violet-700 mb-0.5 flex items-center gap-1.5">
                          Deposit Address
                          <span className="px-1.5 py-0.5 rounded-full bg-violet-100 text-[10px] font-bold text-violet-600">Circle Wallet</span>
                        </p>
                        <p className="font-mono text-xs text-muted-foreground truncate">{circleWallet}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <CopyButton text={circleWallet} />
                      <a href={`https://sepolia.basescan.org/address/${circleWallet}`} target="_blank" rel="noopener noreferrer"
                        className="p-1 rounded hover:bg-secondary transition-colors" title="View on Base Sepolia explorer"
                      >
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </a>
                    </div>
                  </motion.div>
                )}

                {/* Transaction history */}
                <motion.div variants={fadeUp} className="bg-white/80 backdrop-blur rounded-3xl shadow-sm border border-border overflow-hidden">
                  <div className="px-6 py-5 border-b border-border/60 flex items-center justify-between">
                    <h2 className="font-bold text-foreground flex items-center gap-2">
                      <Clock className="w-4 h-4 text-muted-foreground" /> Transaction History
                    </h2>
                    {txHistory?.total ? (
                      <span className="text-xs text-muted-foreground">{txHistory.total} total</span>
                    ) : null}
                  </div>
                  <div className="p-4">
                    {!txHistory?.transactions?.length ? (
                      <motion.div variants={scaleIn} className="text-center py-16 text-muted-foreground">
                        <Clock className="w-10 h-10 mx-auto mb-3 opacity-20" />
                        <p className="text-sm">No transactions yet</p>
                        <p className="text-xs mt-1 opacity-60">Your activity will appear here</p>
                      </motion.div>
                    ) : (
                      <motion.div variants={staggerContainer(0.06)} className="space-y-2">
                        {txHistory.transactions.map((tx) => {
                          const isIn = tx.direction === "in";
                          const isCrypto = tx.currency === "USDC";
                          const statusColor =
                            tx.status === "completed" || tx.status === "claimed"
                              ? "text-green-600"
                              : tx.status === "pending" || tx.status === "pending_transfer"
                              ? "text-amber-600"
                              : "text-muted-foreground";
                          const explorerUrl = getExplorerUrl(tx.network, tx.txHash ?? "");
                          const label = isCrypto
                            ? isIn ? `Received USDC` : `Sent USDC`
                            : isIn ? `Received USD` : `Sent USD`;
                          return (
                            <motion.div
                              key={tx.id}
                              variants={fadeUp}
                              whileHover={{ x: 3, transition: { type: "spring", stiffness: 400, damping: 20 } }}
                              className="flex items-center justify-between p-4 rounded-2xl border border-border/50 hover:bg-secondary/20 transition-colors gap-4 cursor-pointer"
                              onClick={() => setSelectedTx(selectedTx?.id === tx.id ? null : tx)}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0",
                                  isIn ? "bg-green-100 text-green-600" : "bg-blue-100 text-blue-600")}>
                                  {isIn ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="font-semibold text-foreground text-sm">{label}</p>
                                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">{tx.network}</span>
                                  </div>
                                  <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap mt-0.5">
                                    <span>{format(new Date(tx.createdAt), "MMM d, yyyy · h:mm a")}</span>
                                    <span className={cn("font-medium capitalize", statusColor)}>{tx.status.replace(/_/g, " ")}</span>
                                  </p>
                                  {/* Expanded detail row */}
                                  <AnimatePresence>
                                    {selectedTx?.id === tx.id && (
                                      <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: "auto" }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="overflow-hidden"
                                      >
                                        <div className="mt-2 space-y-1 text-xs text-muted-foreground border-t border-border/40 pt-2">
                                          {tx.fromAddress && (
                                            <div className="flex items-start gap-1.5">
                                              <span className="shrink-0 font-medium text-foreground">From:</span>
                                              <span className="break-all font-mono">{tx.fromAddress}</span>
                                            </div>
                                          )}
                                          {tx.toAddress && (
                                            <div className="flex items-start gap-1.5">
                                              <span className="shrink-0 font-medium text-foreground">To:</span>
                                              <span className="break-all font-mono">{tx.toAddress}</span>
                                            </div>
                                          )}
                                          {!tx.fromAddress && !tx.toAddress && isCrypto && tx.direction === "in" && (
                                            <div className="flex items-start gap-1.5">
                                              <span className="shrink-0 font-medium text-foreground">Network:</span>
                                              <span>{tx.network}</span>
                                            </div>
                                          )}
                                          {explorerUrl && (
                                            <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
                                              className="flex items-center gap-1 text-primary hover:underline mt-1"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              View on explorer <ExternalLink className="w-3 h-3" />
                                            </a>
                                          )}
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </div>
                              </div>
                              <div className="flex flex-col items-end shrink-0 gap-1">
                                <p className={cn("font-bold tabular-nums", isIn ? "text-green-600" : "text-foreground")}>
                                  {isIn ? "+" : "-"}{isCrypto ? `$${parseFloat(tx.amount).toFixed(2)} USDC` : formatCurrency(tx.amount)}
                                </p>
                                <ChevronDown className={cn("w-3 h-3 text-muted-foreground transition-transform", selectedTx?.id === tx.id && "rotate-180")} />
                              </div>
                            </motion.div>
                          );
                        })}
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              </motion.div>
            )}

            {/* ── NON-DASHBOARD PAGES ─────────────────────────────────────── */}
            {activePage !== "dashboard" && (
              <motion.div
                key={`page-${activePage}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
                transition={{ duration: 0.25 }}
                className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6"
              >
                {/* Page header */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setActivePage("dashboard")}
                    className="p-2 rounded-xl border border-border bg-white hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                    title="Back to Dashboard"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <div>
                    <h1 className="text-xl font-bold font-display text-foreground">
                      {activePage === "send-usd"  ? "Send USD"       :
                       activePage === "send-usdc" ? "Send USDC"      :
                       activePage === "fund"      ? "Add Funds"      :
                       activePage === "recurring" ? "Recurring"      : "Security"}
                    </h1>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {activePage === "send-usd"  ? "Transfer USD to any email address"          :
                       activePage === "send-usdc" ? "Withdraw USDC to an external wallet"        :
                       activePage === "fund"      ? "Deposit USDC or fund via bank"              :
                       activePage === "recurring" ? "Manage your scheduled transfers"            :
                                                    "Transaction password & authorization key"}
                    </p>
                  </div>
                </div>

                {/* Page card */}
                <div className="bg-white/90 backdrop-blur rounded-3xl shadow-sm border border-border overflow-hidden">
                  <div className="p-6 lg:p-8">
                    <AnimatePresence mode="wait">

                      {activePage === "send-usd" && (
                        <motion.div key="send-usd" variants={fadeIn} initial="hidden" animate="show" exit="hidden">
                          <DashboardSendForm onSuccess={() => setActivePage("dashboard")} hasTransactionPassword={(user as any).hasTransactionPassword} />
                        </motion.div>
                      )}

                      {activePage === "send-usdc" && (
                        <motion.div key="send-usdc" variants={fadeIn} initial="hidden" animate="show" exit="hidden">
                          <CryptoWithdrawalForm mutation={withdrawCryptoMutation} maxAmount={balance?.claimedBalance || "0"} circleWalletAddress={circleWallet} hasTransactionPassword={(user as any).hasTransactionPassword} />
                        </motion.div>
                      )}

                      {activePage === "fund" && (
                        <motion.div key="fund" variants={fadeIn} initial="hidden" animate="show" exit="hidden">
                          <div className="flex gap-2 p-1 bg-secondary rounded-xl mb-8">
                            {(["crypto", "bank"] as const).map((method) => (
                              <button key={method} onClick={() => setFundMethod(method)}
                                className={cn("flex-1 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all relative",
                                  fundMethod === method ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                              >
                                {fundMethod === method && (
                                  <motion.div layoutId="fund-tab-bg" className="absolute inset-0 bg-white rounded-lg shadow-sm"
                                    transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                                )}
                                <span className="relative z-10 flex items-center gap-2">
                                  {method === "crypto" ? <><QrCode className="w-4 h-4" /> Fund with Crypto</> : <><Landmark className="w-4 h-4" /> Direct Bank Deposit</>}
                                </span>
                              </button>
                            ))}
                          </div>
                          <AnimatePresence mode="wait">
                            {fundMethod === "crypto" ? (
                              <motion.div key="fund-crypto" variants={scaleIn} initial="hidden" animate="show" exit="hidden">
                                <CryptoDepositPanel walletAddress={(user as any).circleWalletAddress} />
                              </motion.div>
                            ) : (
                              <motion.div key="fund-bank" variants={scaleIn} initial="hidden" animate="show" exit="hidden">
                                <BankDepositForm onSuccess={() => setActivePage("dashboard")} />
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      )}

                      {activePage === "recurring" && (
                        <motion.div key="recurring" variants={fadeIn} initial="hidden" animate="show" exit="hidden">
                          <RecurringTransferTab userEmail={user.email} availableBalance={parseFloat(balance?.claimedBalance ?? "0")} hasTransactionPassword={(user as any).hasTransactionPassword} />
                        </motion.div>
                      )}

                      {activePage === "security" && (
                        <motion.div key="security" variants={fadeIn} initial="hidden" animate="show" exit="hidden">
                          <SecurityTab user={user as any} onSecurityUpdated={() => queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] })} />
                        </motion.div>
                      )}

                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

// ─── Withdrawal sub-forms ─────────────────────────────────────────────────────

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const WITHDRAWAL_FEE = 0.10;

function CryptoWithdrawalForm({ mutation, maxAmount, circleWalletAddress, hasTransactionPassword }: { mutation: any; maxAmount: string; circleWalletAddress?: string; hasTransactionPassword?: boolean }) {
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);
  const [txnPwd,     setTxnPwd]     = useState("");

  const schema = z.object({
    walletAddress: z.string().regex(EVM_RE, "Invalid EVM address — must be 0x followed by 40 hex characters"),
    amount: z
      .string()
      .refine((v) => Number(v) > 0, "Amount must be positive")
      .refine(
        (v) => Number(v) + WITHDRAWAL_FEE <= Number(maxAmount),
        `Insufficient balance — you need amount + $${WITHDRAWAL_FEE.toFixed(2)} fee`,
      ),
  });

  const { register, handleSubmit, formState: { errors }, reset, setValue, watch } = useForm({ resolver: zodResolver(schema) });
  const watchedAddr   = watch("walletAddress", "");
  const watchedAmount = watch("amount", "");
  const addrValid     = EVM_RE.test(watchedAddr ?? "");
  const addrDirty     = (watchedAddr ?? "").length > 0;
  const parsedAmount  = parseFloat(watchedAmount) || 0;
  const totalAmount   = parsedAmount > 0 ? parsedAmount + WITHDRAWAL_FEE : 0;

  const onSubmit = async (data: any) => {
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      await mutation.mutateAsync({ data: { ...data, ...(hasTransactionPassword && txnPwd ? { transactionPassword: txnPwd } : {}) } });
      setSuccessMsg(`Withdrawal of ${formatCurrency(data.amount)} USD initiated.`);
      setTxnPwd("");
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
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-foreground">Destination Wallet Address</label>
          {circleWalletAddress && (
            <button
              type="button"
              onClick={() => setValue("walletAddress", circleWalletAddress, { shouldValidate: true })}
              className="text-xs font-semibold text-violet-600 hover:text-violet-700 flex items-center gap-1 transition-colors"
            >
              <ShieldCheck className="w-3 h-3" />
              Use my Circle wallet
            </button>
          )}
        </div>
        <input
          {...register("walletAddress")}
          placeholder="0x…"
          className={cn(
            "w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:ring-4 outline-none transition-all font-mono text-sm",
            errors.walletAddress
              ? "border-destructive focus:border-destructive focus:ring-destructive/10"
              : addrDirty && addrValid
              ? "border-green-400 focus:border-green-500 focus:ring-green-100"
              : addrDirty
              ? "border-amber-400 focus:border-amber-500 focus:ring-amber-100"
              : "focus:border-primary focus:ring-primary/10",
          )}
        />
        <AnimatePresence>
          {errors.walletAddress ? (
            <motion.p key="err" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-destructive text-sm mt-1.5 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{errors.walletAddress.message as string}
            </motion.p>
          ) : addrDirty && addrValid ? (
            <motion.p key="ok" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-green-600 text-sm mt-1.5 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Valid EVM address
            </motion.p>
          ) : addrDirty ? (
            <motion.p key="bad" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-amber-600 text-sm mt-1.5 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" /> Not a valid EVM address — must start with 0x and be 42 characters total
            </motion.p>
          ) : null}
        </AnimatePresence>
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
          <span className="absolute right-4 inset-y-0 flex items-center text-muted-foreground text-sm">USD</span>
        </div>
        {errors.amount && <p className="text-destructive text-sm mt-1">{errors.amount.message as string}</p>}
      </motion.div>

      {/* Fee breakdown */}
      <motion.div variants={fadeUp} className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Amount to receive</span>
          <span className="font-medium text-foreground">{parsedAmount > 0 ? `$${parsedAmount.toFixed(2)}` : "—"} USDC</span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Network fee</span>
          <span className="font-medium text-amber-700">${WITHDRAWAL_FEE.toFixed(2)} USDC</span>
        </div>
        <div className="border-t border-amber-200 pt-1.5 flex items-center justify-between font-semibold text-foreground">
          <span>Total deducted</span>
          <span>{totalAmount > 0 ? `$${totalAmount.toFixed(2)}` : "—"} USDC</span>
        </div>
      </motion.div>

      {hasTransactionPassword && (
        <motion.div variants={fadeUp}>
          <label className="block text-sm font-medium text-foreground mb-2">
            Transaction Password
          </label>
          <input
            type="password"
            value={txnPwd}
            onChange={(e) => setTxnPwd(e.target.value)}
            disabled={mutation.isPending}
            placeholder="Your transaction password"
            className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all"
          />
        </motion.div>
      )}

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

// ─── Dashboard Send Form ──────────────────────────────────────────────────────

const dashSendSchema = z.object({
  recipientEmail: z.string().email("Please enter a valid email address"),
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((v) => !isNaN(Number(v)) && Number(v) > 0, "Must be a positive number")
    .refine((v) => Number(v) >= 0.01, "Minimum is $0.01 USD"),
});

type DashSendValues = z.infer<typeof dashSendSchema>;

function DashboardSendForm({ onSuccess, hasTransactionPassword }: { onSuccess: () => void; hasTransactionPassword?: boolean }) {
  const { data: balance } = useGetUserBalance({});
  const [isSending,    setIsSending]    = useState(false);
  const [formError,    setFormError]    = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState("");
  const [successAmount, setSuccessAmount] = useState("");
  const [didSucceed,   setDidSucceed]   = useState(false);
  const [txnPwd,       setTxnPwd]       = useState("");

  const { register, handleSubmit, reset, formState: { errors } } = useForm<DashSendValues>({
    resolver: zodResolver(dashSendSchema),
  });

  const availableBalance = parseFloat(balance?.claimedBalance ?? "0");

  const onSubmit = async (data: DashSendValues) => {
    setFormError(null);
    const numAmount = parseFloat(data.amount);
    if (numAmount > availableBalance) {
      setFormError(`Insufficient balance. You have $${availableBalance.toFixed(2)} USD available.`);
      return;
    }
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
          ...(hasTransactionPassword && txnPwd ? { transactionPassword: txnPwd } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message ?? "Failed to send payment");
      }
      setTxnPwd("");
      setSuccessEmail(data.recipientEmail.toLowerCase().trim());
      setSuccessAmount(data.amount);
      setDidSucceed(true);
      refetchBalance();
      invalidateHistory();
    } catch (err: any) {
      setFormError(err?.message ?? "Failed to send payment. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  const handleReset = () => {
    setDidSucceed(false);
    setFormError(null);
    setSuccessEmail("");
    setSuccessAmount("");
    reset();
  };

  return (
    <AnimatePresence mode="wait">
      {/* ── Success state ── */}
      {didSucceed ? (
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
            <motion.p variants={fadeUp} className="text-muted-foreground text-sm mb-2">
              <span className="font-semibold text-foreground">${successAmount} USD</span> locked in escrow for{" "}
              <span className="font-semibold text-foreground">{successEmail}</span>.
              They'll receive a notification to claim it.
            </motion.p>
            <motion.div variants={fadeUp} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-50 text-violet-700 text-xs font-medium border border-violet-200 mb-6">
              <ShieldCheck className="w-3.5 h-3.5" />
              Sent from your platform balance — no wallet needed
            </motion.div>

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
                <h3 className="text-xl font-bold font-display">Send USD</h3>
                <p className="text-sm text-muted-foreground mt-0.5">Lock funds in escrow for any email address</p>
              </div>
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 text-violet-700 rounded-full text-xs font-semibold border border-violet-200"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                No wallet needed
              </motion.div>
            </div>
          </motion.div>

          {/* Available balance callout */}
          <motion.div variants={fadeUp} className="flex items-center justify-between px-4 py-3 rounded-xl bg-secondary/60 border border-border mb-5">
            <span className="text-sm text-muted-foreground">Available balance</span>
            <span className="font-bold text-foreground tabular-nums">{formatCurrency(balance?.claimedBalance ?? "0")}</span>
          </motion.div>

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
                disabled={isSending}
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
                Amount (USD)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="text-muted-foreground font-medium">$</span>
                </div>
                <input
                  {...register("amount")}
                  disabled={isSending}
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
                  <span className="text-muted-foreground font-medium text-sm">USD</span>
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

            {/* Transaction password (shown only if user has one set) */}
            {hasTransactionPassword && (
              <motion.div variants={fadeUp}>
                <label className="block text-sm font-medium text-foreground mb-2">
                  <Lock className="w-4 h-4 inline mr-1.5 opacity-60" />
                  Transaction Password
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={txnPwd}
                    onChange={(e) => setTxnPwd(e.target.value)}
                    disabled={isSending}
                    placeholder="Your transaction password"
                    className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none disabled:opacity-60"
                  />
                </div>
              </motion.div>
            )}

            {/* Info note */}
            <motion.div variants={fadeUp} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-primary/5 border border-primary/10 text-sm text-muted-foreground">
              <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
              <span>Funds are deducted from your balance and held in escrow until the recipient claims them.</span>
            </motion.div>

            {/* Submit */}
            <motion.div variants={fadeUp}>
              <motion.button
                type="submit"
                disabled={isSending}
                whileHover={!isSending ? { scale: 1.02, y: -1 } : {}}
                whileTap={!isSending ? { scale: 0.98 } : {}}
                className="w-full relative group flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-bold text-white overflow-hidden bg-primary disabled:opacity-70 disabled:cursor-not-allowed transition-shadow hover:shadow-xl hover:shadow-primary/30"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-primary to-accent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                <span className="relative z-10 flex items-center gap-2">
                  {isSending
                    ? <><Loader2 className="w-5 h-5 animate-spin" />Sending…</>
                    : <><Send className="w-5 h-5" />Lock &amp; Send<ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" /></>
                  }
                </span>
              </motion.button>
            </motion.div>
          </form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Recurring Transfers Tab ──────────────────────────────────────────────────

interface RecurringTransfer {
  id: number;
  recipientEmail: string;
  amount: string;
  interval: "hourly" | "daily" | "weekly" | "monthly";
  nextRunAt: string;
  endDate: string | null;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
}

const recurringSchema = z.object({
  recipientEmail: z.string().email("Please enter a valid email address"),
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((v) => !isNaN(Number(v)) && Number(v) > 0, "Must be a positive number")
    .refine((v) => Number(v) >= 0.01, "Minimum is $0.01 USD"),
  interval: z.enum(["hourly", "daily", "weekly", "monthly"]),
  startHour: z.number().int().min(0).max(23).optional(),
  startDayOfWeek: z.number().int().min(0).max(6).optional(),
  startDayOfMonth: z.number().int().min(1).max(31).optional(),
  endDate: z.string().optional(),
});

type RecurringValues = z.infer<typeof recurringSchema>;

function RecurringTransferTab({ userEmail, availableBalance, hasTransactionPassword }: { userEmail: string; availableBalance: number; hasTransactionPassword?: boolean }) {
  const [transfers, setTransfers]   = useState<RecurringTransfer[]>([]);
  const [isLoading, setIsLoading]   = useState(true);
  const [showForm,  setShowForm]    = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [formError, setFormError]   = useState<string | null>(null);
  const [txnPwd,    setTxnPwd]      = useState("");
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<RecurringValues>({
    resolver: zodResolver(recurringSchema),
    defaultValues: { interval: "monthly", startHour: 9, startDayOfWeek: 1, startDayOfMonth: 1 },
  });
  const selectedInterval = watch("interval");

  const authHeaders = () => {
    const jwt = localStorage.getItem("token");
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (jwt) h["Authorization"] = `Bearer ${jwt}`;
    return h;
  };

  const fetchTransfers = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${BASE}/api/recurring`, { headers: authHeaders() });
      if (res.ok) setTransfers(await res.json());
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchTransfers(); }, []);

  const onSubmit = async (data: RecurringValues) => {
    setFormError(null);
    if (parseFloat(data.amount) > availableBalance) {
      setFormError(`Insufficient balance. You have $${availableBalance.toFixed(2)} USD available.`);
      return;
    }
    if (data.recipientEmail.toLowerCase().trim() === userEmail.toLowerCase()) {
      setFormError("You cannot schedule transfers to yourself.");
      return;
    }
    setIsSubmitting(true);
    try {
      const body: Record<string, any> = {
        recipientEmail: data.recipientEmail.toLowerCase().trim(),
        amount: data.amount,
        interval: data.interval,
      };
      if (data.interval !== "hourly" && data.startHour !== undefined) body["startHour"] = data.startHour;
      if (data.interval === "weekly" && data.startDayOfWeek !== undefined) body["startDayOfWeek"] = data.startDayOfWeek;
      if (data.interval === "monthly" && data.startDayOfMonth !== undefined) body["startDayOfMonth"] = data.startDayOfMonth;
      if (data.endDate) body["endDate"] = new Date(data.endDate).toISOString();
      if (hasTransactionPassword && txnPwd) body["transactionPassword"] = txnPwd;
      const res = await fetch(`${BASE}/api/recurring`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? "Failed to create recurring transfer");
      setFormSuccess(json.message);
      setTxnPwd("");
      reset();
      setShowForm(false);
      fetchTransfers();
    } catch (err: any) {
      setFormError(err?.message ?? "Failed to create. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async (id: number) => {
    setCancellingId(id);
    try {
      const res = await fetch(`${BASE}/api/recurring/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) fetchTransfers();
    } finally {
      setCancellingId(null);
    }
  };

  const activeTransfers    = transfers.filter((t) => t.status === "active");
  const inactiveTransfers  = transfers.filter((t) => t.status !== "active");

  const intervalLabel: Record<string, string> = { hourly: "Hourly", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  const statusColor: Record<string, string> = {
    active:    "bg-green-100 text-green-700",
    completed: "bg-secondary text-muted-foreground",
    cancelled: "bg-red-50 text-red-500",
  };

  return (
    <motion.div variants={staggerContainer(0.08, 0)} initial="hidden" animate="show" className="space-y-6">
      {/* Header */}
      <motion.div variants={fadeUp} className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-bold font-display">Recurring Transfers</h3>
          <p className="text-sm text-muted-foreground mt-0.5">Automate payments at regular intervals</p>
        </div>
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => { setShowForm((v) => !v); setFormError(null); setFormSuccess(null); }}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all",
            showForm
              ? "bg-secondary text-muted-foreground hover:bg-secondary/80"
              : "bg-primary text-white shadow-lg shadow-primary/20 hover:shadow-primary/30",
          )}
        >
          {showForm ? <><X className="w-4 h-4" />Cancel</> : <><Plus className="w-4 h-4" />New Recurring</>}
        </motion.button>
      </motion.div>

      {/* Success banner */}
      <AnimatePresence>
        {formSuccess && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm overflow-hidden"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {formSuccess}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create form */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            key="form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="p-5 rounded-2xl border border-border bg-secondary/30 space-y-4">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Repeat className="w-4 h-4 text-primary" />
                Schedule a recurring transfer
              </p>

              <AnimatePresence>
                {formError && <InlineError message={formError} />}
              </AnimatePresence>

              {/* Available balance */}
              <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white border border-border text-sm">
                <span className="text-muted-foreground">Available balance</span>
                <span className="font-bold tabular-nums">{formatCurrency(String(availableBalance))}</span>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                {/* Recipient email */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    <Mail className="w-4 h-4 inline mr-1.5 opacity-60" />
                    Recipient Email
                  </label>
                  <input
                    {...register("recipientEmail")}
                    type="email"
                    placeholder="satoshi@example.com"
                    className={cn(
                      "w-full px-4 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm",
                      errors.recipientEmail && "border-destructive",
                    )}
                  />
                  {errors.recipientEmail && <p className="mt-1 text-xs text-destructive">{errors.recipientEmail.message}</p>}
                </div>

                {/* Amount + Interval row */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">Amount (USD)</label>
                    <div className="relative">
                      <span className="absolute left-3 inset-y-0 flex items-center text-muted-foreground text-sm">$</span>
                      <input
                        {...register("amount")}
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="50.00"
                        className={cn(
                          "w-full pl-7 pr-3 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm",
                          errors.amount && "border-destructive",
                        )}
                      />
                    </div>
                    {errors.amount && <p className="mt-1 text-xs text-destructive">{errors.amount.message}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">Frequency</label>
                    <select
                      {...register("interval")}
                      className="w-full px-3 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm"
                    >
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                </div>

                {/* Timing fields — conditional on interval */}
                {selectedInterval !== "hourly" && (
                  <div className="grid grid-cols-2 gap-3">
                    {/* Start hour — all non-hourly intervals */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">Start Time (hour)</label>
                      <select
                        {...register("startHour", { valueAsNumber: true })}
                        className="w-full px-3 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm"
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>
                            {h === 0 ? "12:00 AM" : h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Day of week — weekly only */}
                    {selectedInterval === "weekly" && (
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1.5">Day of Week</label>
                        <select
                          {...register("startDayOfWeek", { valueAsNumber: true })}
                          className="w-full px-3 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm"
                        >
                          {["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((d, i) => (
                            <option key={i} value={i}>{d}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Day of month — monthly only */}
                    {selectedInterval === "monthly" && (
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1.5">Day of Month</label>
                        <select
                          {...register("startDayOfMonth", { valueAsNumber: true })}
                          className="w-full px-3 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm"
                        >
                          {Array.from({ length: 28 }, (_, i) => (
                            <option key={i + 1} value={i + 1}>{i + 1}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {/* End date */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    <CalendarDays className="w-4 h-4 inline mr-1.5 opacity-60" />
                    End Date <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <input
                    {...register("endDate")}
                    type="date"
                    min={new Date(Date.now() + 86_400_000).toISOString().split("T")[0]}
                    className="w-full px-4 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm"
                  />
                </div>

                {/* Transaction password — shown only if user has one set */}
                {hasTransactionPassword && (
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      <Lock className="w-4 h-4 inline mr-1.5 opacity-60" />
                      Transaction Password
                    </label>
                    <input
                      type="password"
                      value={txnPwd}
                      onChange={(e) => setTxnPwd(e.target.value)}
                      placeholder="Your transaction password"
                      className="w-full px-4 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm"
                    />
                  </div>
                )}

                <motion.button
                  type="submit"
                  disabled={isSubmitting}
                  whileHover={!isSubmitting ? { scale: 1.02, y: -1 } : {}}
                  whileTap={!isSubmitting ? { scale: 0.98 } : {}}
                  className="w-full bg-primary text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary/25 transition-shadow disabled:opacity-70 disabled:cursor-not-allowed text-sm"
                >
                  {isSubmitting
                    ? <><Loader2 className="w-4 h-4 animate-spin" />Creating…</>
                    : <><Repeat className="w-4 h-4" />Schedule Transfer</>
                  }
                </motion.button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transfer list */}
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-8 h-8 animate-spin text-primary/40" />
        </div>
      ) : transfers.length === 0 ? (
        <motion.div variants={scaleIn} className="text-center py-12 text-muted-foreground">
          <Repeat className="w-12 h-12 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No recurring transfers yet</p>
          <p className="text-sm mt-1">Create one above to automate your payments.</p>
        </motion.div>
      ) : (
        <div className="space-y-5">
          {/* Active */}
          {activeTransfers.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">Active</p>
              <motion.div variants={staggerContainer(0.06)} className="space-y-2">
                {activeTransfers.map((t) => (
                  <motion.div
                    key={t.id}
                    variants={fadeUp}
                    className="flex items-center justify-between p-4 rounded-2xl border border-border/50 bg-white hover:bg-secondary/10 transition-colors gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <Repeat className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground text-sm truncate">{t.recipientEmail}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap mt-0.5">
                          <span className={cn("px-1.5 py-0.5 rounded-full text-[10px] font-bold", statusColor[t.status])}>
                            {intervalLabel[t.interval]}
                          </span>
                          <span className="w-1 h-1 rounded-full bg-border" />
                          <span>Next: {format(new Date(t.nextRunAt), "MMM d, yyyy")}</span>
                          {t.endDate && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-border" />
                              <span>Ends: {format(new Date(t.endDate), "MMM d, yyyy")}</span>
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <p className="font-bold text-foreground tabular-nums">{formatCurrency(t.amount)}</p>
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => handleCancel(t.id)}
                        disabled={cancellingId === t.id}
                        title="Cancel recurring transfer"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                      >
                        {cancellingId === t.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />
                        }
                      </motion.button>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          )}

          {/* Past */}
          {inactiveTransfers.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">Past</p>
              <motion.div variants={staggerContainer(0.06)} className="space-y-2">
                {inactiveTransfers.map((t) => (
                  <motion.div
                    key={t.id}
                    variants={fadeUp}
                    className="flex items-center justify-between p-4 rounded-2xl border border-border/30 bg-secondary/20 gap-4 opacity-70"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-secondary text-muted-foreground flex items-center justify-center shrink-0">
                        <Repeat className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground text-sm truncate">{t.recipientEmail}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                          <span className={cn("px-1.5 py-0.5 rounded-full text-[10px] font-bold", statusColor[t.status])}>
                            {t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                          </span>
                          <span className="w-1 h-1 rounded-full bg-border" />
                          <span>{intervalLabel[t.interval]}</span>
                        </p>
                      </div>
                    </div>
                    <p className="font-bold text-muted-foreground tabular-nums shrink-0">{formatCurrency(t.amount)}</p>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ─── Security Tab ─────────────────────────────────────────────────────────────

interface SecurityUser {
  hasTransactionPassword?: boolean;
  hasPak?: boolean;
  pakCopied?: boolean;
  pakPreview?: string | null;
  pakCreatedAt?: string | null;
  pakCanRegenerate?: boolean;
  nextPakAllowedAt?: string | null;
}

type SecurityView =
  | "overview"
  | "set-txn-otp"   | "set-txn-pwd"
  | "gen-pak-otp"   | "gen-pak-reveal"
  | "chg-login-pak" | "chg-login-otp"
  | "chg-txn-pak"   | "chg-txn-otp"
  | "del-acct-pak"  | "del-acct-otp";

function PasswordInput({ label, placeholder, value, onChange, disabled }: {
  label: string; placeholder?: string; value: string;
  onChange: (v: string) => void; disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "••••••••"}
          disabled={disabled}
          className="w-full px-4 py-2.5 pr-10 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none text-sm disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground transition-colors"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

function OtpStep({ label, otp, setOtp, onResend, onSubmit, isLoading, error, submitLabel, submitClassName }: {
  label: string; otp: string; setOtp: (v: string) => void;
  onResend: () => void; onSubmit: () => void;
  isLoading: boolean; error: string | null;
  submitLabel?: string; submitClassName?: string;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      {error && <InlineError message={error} />}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">6-digit verification code</label>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          className="w-full px-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none text-center text-2xl font-mono tracking-widest"
        />
      </div>
      <motion.button
        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
        onClick={onSubmit}
        disabled={isLoading || otp.length < 6}
        className={cn("w-full font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-shadow disabled:opacity-70 text-sm",
          submitClassName ?? "bg-primary text-white hover:shadow-lg hover:shadow-primary/25")}
      >
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
        {isLoading ? "Verifying…" : (submitLabel ?? "Verify Code")}
      </motion.button>
      <button onClick={onResend} disabled={isLoading} className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-1">
        Resend code
      </button>
    </div>
  );
}

function SecurityTab({ user, onSecurityUpdated }: { user: SecurityUser; onSecurityUpdated: () => void }) {
  const [view, setView] = useState<SecurityView>("overview");
  const [otp, setOtp]   = useState("");
  const [pak, setPak]   = useState("");
  const [pwd, setPwd]   = useState("");
  const [pwd2, setPwd2] = useState("");  // confirm new password
  const [revealedPak, setRevealedPak] = useState<string | null>(null);
  const [pakCopiedLocally, setPakCopiedLocally] = useState(false);
  const [isLoading, setIsLoading]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [success, setSuccess]       = useState<string | null>(null);

  const reset = () => { setOtp(""); setPak(""); setPwd(""); setPwd2(""); setError(null); };

  const authHeaders = () => {
    const jwt = localStorage.getItem("token");
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (jwt) h["Authorization"] = `Bearer ${jwt}`;
    return h;
  };

  const api = async (path: string, body?: object) => {
    const res = await fetch(`${BASE}/api/security${path}`, {
      method: "POST",
      headers: authHeaders(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message ?? "Request failed");
    return json;
  };

  const run = async (fn: () => Promise<void>) => {
    setIsLoading(true);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message ?? "Something went wrong"); }
    finally { setIsLoading(false); }
  };

  // ── Transaction password ─────────────────────────────────────────────────

  const requestTxnOtp = () => run(async () => {
    await api("/txn-password/request-otp");
    setView("set-txn-otp");
  });

  const confirmTxnOtp = () => run(async () => {
    if (pwd.length < 6)  { setError("Transaction password must be at least 6 characters"); return; }
    if (pwd !== pwd2)    { setError("Passwords do not match"); return; }
    await api("/txn-password/set", { otp, password: pwd });
    setSuccess("Transaction password set successfully.");
    onSecurityUpdated();
    reset(); setView("overview");
  });

  // Resend OTP for current flow
  const resendOtp = () => run(async () => {
    const pathMap: Partial<Record<SecurityView, string>> = {
      "set-txn-otp":  "/txn-password/request-otp",
      "gen-pak-otp":  "/pak/request-otp",
      "chg-login-otp": "/change-login-password/request-otp",
      "chg-txn-otp":  "/change-txn-password/request-otp",
      "del-acct-otp": "/delete-account/request-otp",
    };
    const path = pathMap[view];
    if (!path) return;
    // For PAK-gated flows, re-send needs the PAK
    if (view === "chg-login-otp" || view === "chg-txn-otp" || view === "del-acct-otp") {
      await api(path, { pak });
    } else {
      await api(path);
    }
  });

  // ── PAK generation ───────────────────────────────────────────────────────

  const requestPakOtp = () => run(async () => {
    await api("/pak/request-otp");
    setView("gen-pak-otp");
  });

  const confirmPakOtp = () => run(async () => {
    const data = await api("/pak/generate", { otp });
    setRevealedPak(data.pak);
    setView("gen-pak-reveal");
    reset();
  });

  const copyPak = async () => {
    if (!revealedPak) return;
    await navigator.clipboard.writeText(revealedPak);
    setPakCopiedLocally(true);
  };

  const confirmPakCopied = () => run(async () => {
    await api("/pak/confirm-copied");
    setRevealedPak(null);
    setPakCopiedLocally(false);
    setSuccess("PAK saved. Keep it in a secure place — it cannot be recovered.");
    onSecurityUpdated();
    setView("overview");
  });

  // ── Change login password ────────────────────────────────────────────────

  const requestChangeLoginOtp = () => run(async () => {
    if (!pak.trim())    { setError("Please enter your PAK"); return; }
    if (pwd.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (!pwd2)          { setError("Please confirm your new password"); return; }
    if (pwd !== pwd2)   { setError("Passwords do not match — please re-enter both fields"); return; }
    await api("/change-login-password/request-otp", { pak: pak.trim() });
    setView("chg-login-otp");
  });

  const confirmChangeLogin = () => run(async () => {
    if (pwd.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (pwd !== pwd2)   { setError("Passwords do not match"); return; }
    await api("/change-login-password/confirm", { pak: pak.trim(), newPassword: pwd, otp });
    setSuccess("Login password changed successfully.");
    onSecurityUpdated();
    reset(); setView("overview");
  });

  // ── Change transaction password ──────────────────────────────────────────

  const requestChangeTxnOtp = () => run(async () => {
    if (!pak.trim())    { setError("Please enter your PAK"); return; }
    if (pwd.length < 6) { setError("Transaction password must be at least 6 characters"); return; }
    if (!pwd2)          { setError("Please confirm your new password"); return; }
    if (pwd !== pwd2)   { setError("Passwords do not match — please re-enter both fields"); return; }
    await api("/change-txn-password/request-otp", { pak: pak.trim() });
    setView("chg-txn-otp");
  });

  const confirmChangeTxn = () => run(async () => {
    if (pwd.length < 6) { setError("Transaction password must be at least 6 characters"); return; }
    if (pwd !== pwd2)   { setError("Passwords do not match"); return; }
    await api("/change-txn-password/confirm", { pak: pak.trim(), newPassword: pwd, otp });
    setSuccess("Transaction password changed successfully.");
    onSecurityUpdated();
    reset(); setView("overview");
  });

  // ── Delete account ───────────────────────────────────────────────────────

  const requestDeleteOtp = () => run(async () => {
    if (!pak.trim()) { setError("Please enter your PAK"); return; }
    await api("/delete-account/request-otp", { pak: pak.trim() });
    setView("del-acct-otp");
  });

  const confirmDeleteAccount = () => run(async () => {
    await api("/delete-account/confirm", { pak: pak.trim(), otp });
    // Account deleted — clear local auth state and redirect to landing page
    localStorage.removeItem("token");
    sessionStorage.clear();
    window.location.replace("/");
  });

  // ── Render ───────────────────────────────────────────────────────────────

  const backToOverview = () => { reset(); setView("overview"); };

  const panelHeader = (title: string, subtitle?: string) => (
    <div className="flex items-center gap-3 mb-6">
      <button onClick={backToOverview} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
        <X className="w-4 h-4" />
      </button>
      <div>
        <h4 className="font-bold text-foreground">{title}</h4>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );

  return (
    <motion.div variants={staggerContainer(0.08, 0)} initial="hidden" animate="show" className="space-y-6">
      {/* Page header */}
      {view === "overview" && (
        <motion.div variants={fadeUp} className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-200">
            <LockKeyhole className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-bold font-display">Security</h3>
            <p className="text-sm text-muted-foreground">Transaction password &amp; authorization key</p>
          </div>
        </motion.div>
      )}

      {/* Global success */}
      <AnimatePresence>
        {success && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm overflow-hidden"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {success}
            <button onClick={() => setSuccess(null)} className="ml-auto text-green-600 hover:text-green-800"><X className="w-3.5 h-3.5" /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── OVERVIEW ── */}
      {view === "overview" && (
        <motion.div variants={staggerContainer(0.06)} className="space-y-4">

          {/* Error display */}
          {error && (
            <motion.div variants={fadeUp} className="flex items-start gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
            </motion.div>
          )}

          {/* Transaction Password card */}
          <motion.div variants={fadeUp} className="p-5 rounded-2xl border border-border bg-white space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center",
                  user.hasTransactionPassword ? "bg-green-100 text-green-600" : "bg-amber-100 text-amber-600")}>
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-semibold text-foreground text-sm">Transaction Password</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {user.hasTransactionPassword ? "Required for all outgoing transfers" : "Not set — transactions are unprotected"}
                  </p>
                </div>
              </div>
              <span className={cn("px-2.5 py-1 rounded-full text-xs font-bold",
                user.hasTransactionPassword ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>
                {user.hasTransactionPassword ? "Active" : "Not set"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {!user.hasTransactionPassword ? (
                <button onClick={requestTxnOtp} disabled={isLoading}
                  className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-primary/90 transition-colors disabled:opacity-60">
                  {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />}
                  Set Transaction Password
                </button>
              ) : (
                <button onClick={() => { reset(); setView("chg-txn-pak"); }} disabled={!user.hasPak}
                  className="px-3 py-1.5 rounded-lg bg-secondary text-foreground text-xs font-semibold flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-40"
                  title={!user.hasPak ? "Generate a PAK first to change passwords" : undefined}>
                  <RefreshCw className="w-3 h-3" /> Change
                </button>
              )}
            </div>
          </motion.div>

          {/* PAK card */}
          <motion.div variants={fadeUp} className="p-5 rounded-2xl border border-border bg-white space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center",
                  user.hasPak ? "bg-violet-100 text-violet-600" : "bg-secondary text-muted-foreground")}>
                  <KeyRound className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-semibold text-foreground text-sm">Personal Authorization Key (PAK)</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {user.hasPak
                      ? user.pakPreview
                        ? <>Preview: <span className="font-mono">{user.pakPreview}</span></>
                        : "Generated"
                      : "Required to change your passwords"}
                  </p>
                </div>
              </div>
              <span className={cn("px-2.5 py-1 rounded-full text-xs font-bold shrink-0",
                user.hasPak ? "bg-violet-100 text-violet-700" : "bg-secondary text-muted-foreground")}>
                {user.hasPak ? (user.pakCopied ? "Saved" : "Not confirmed") : "None"}
              </span>
            </div>

            {/* PAK not-copied warning */}
            {user.hasPak && !user.pakCopied && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>You haven't confirmed copying your PAK yet. If you've saved it, click "Confirm saved" below.</span>
              </div>
            )}

            {user.nextPakAllowedAt && (
              <p className="text-xs text-muted-foreground">
                Next regeneration allowed: {format(new Date(user.nextPakAllowedAt), "MMM d, yyyy")}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {!user.hasPak || user.pakCanRegenerate ? (
                <button onClick={requestPakOtp} disabled={isLoading}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-violet-700 transition-colors disabled:opacity-60">
                  {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
                  {user.hasPak ? "Regenerate PAK" : "Generate PAK"}
                </button>
              ) : null}
              {user.hasPak && !user.pakCopied && (
                <button onClick={() => run(() => api("/pak/confirm-copied").then(() => { onSecurityUpdated(); setSuccess("PAK confirmed as saved."); }))}
                  disabled={isLoading}
                  className="px-3 py-1.5 rounded-lg bg-secondary text-foreground text-xs font-semibold flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-60">
                  <CheckCircle2 className="w-3 h-3" /> Confirm saved
                </button>
              )}
            </div>
          </motion.div>

          {/* Change Login Password card */}
          {user.hasPak && (
            <motion.div variants={fadeUp} className="p-5 rounded-2xl border border-border bg-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                    <RefreshCw className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground text-sm">Change Login Password</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Requires your PAK + email OTP</p>
                  </div>
                </div>
                <button onClick={() => { reset(); setView("chg-login-pak"); }}
                  className="px-3 py-1.5 rounded-lg bg-secondary text-foreground text-xs font-semibold flex items-center gap-1.5 hover:bg-secondary/80 transition-colors">
                  <RefreshCw className="w-3 h-3" /> Change
                </button>
              </div>
            </motion.div>
          )}

          {/* Info note when no PAK */}
          {!user.hasPak && (
            <motion.div variants={fadeUp} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-violet-50 border border-violet-100 text-sm text-violet-700">
              <KeyRound className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Generate your PAK first. It is needed to change your login or transaction password in the future.</span>
            </motion.div>
          )}

          {/* Delete Account card */}
          <motion.div variants={fadeUp} className="p-5 rounded-2xl border-2 border-red-200 bg-red-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-red-100 text-red-600 flex items-center justify-center">
                  <Trash2 className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-semibold text-red-700 text-sm">Delete Account</p>
                  <p className="text-xs text-red-500 mt-0.5">Permanently removes all your data — irreversible</p>
                </div>
              </div>
              <button onClick={() => { reset(); setView("del-acct-pak"); }} disabled={!user.hasPak}
                title={!user.hasPak ? "Generate a PAK first to delete your account" : undefined}
                className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-red-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Trash2 className="w-3 h-3" /> Delete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* ── SET TRANSACTION PASSWORD — OTP step ── */}
      {view === "set-txn-otp" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Set Transaction Password", "Enter the code sent to your email, then choose a password")}
          {error && <InlineError message={error} />}
          <OtpStep
            label="A 6-digit code was sent to your email to verify this action."
            otp={otp} setOtp={setOtp}
            onResend={() => run(() => api("/txn-password/request-otp"))}
            onSubmit={() => {
              // After OTP collected, advance to password entry
              run(async () => {
                // We verify OTP + set password together in one step
                setView("set-txn-pwd");
                setError(null);
              });
            }}
            isLoading={isLoading} error={null}
          />
        </motion.div>
      )}

      {/* ── SET TRANSACTION PASSWORD — password entry ── */}
      {view === "set-txn-pwd" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Set Transaction Password", "Choose a password for authorizing transfers")}
          {error && <InlineError message={error} />}
          <PasswordInput label="New Transaction Password (min 6 chars)" value={pwd} onChange={setPwd} disabled={isLoading} />
          <PasswordInput label="Confirm Password" value={pwd2} onChange={setPwd2} disabled={isLoading} />
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={confirmTxnOtp} disabled={isLoading}
            className="w-full bg-primary text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary/25 transition-shadow disabled:opacity-70 text-sm">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
            {isLoading ? "Setting…" : "Set Transaction Password"}
          </motion.button>
        </motion.div>
      )}

      {/* ── GENERATE PAK — OTP step ── */}
      {view === "gen-pak-otp" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Generate PAK", "Verify your identity before generating your key")}
          <OtpStep
            label="A 6-digit code was sent to your email."
            otp={otp} setOtp={setOtp}
            onResend={() => run(() => api("/pak/request-otp"))}
            onSubmit={confirmPakOtp}
            isLoading={isLoading} error={error}
          />
        </motion.div>
      )}

      {/* ── PAK REVEAL (one-time) ── */}
      {view === "gen-pak-reveal" && revealedPak && (
        <motion.div variants={fadeUp} className="space-y-5">
          {panelHeader("Your Personal Authorization Key", "This is displayed exactly once")}

          <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-2">
            <div className="flex items-center gap-2 text-amber-800 text-xs font-semibold">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              Copy this key and store it somewhere safe. You cannot view it again.
            </div>
            <div className="font-mono text-sm text-amber-900 bg-white border border-amber-200 rounded-xl px-4 py-3 break-all select-all">
              {revealedPak}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={copyPak}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 font-semibold text-sm transition-all",
                pakCopiedLocally
                  ? "border-green-300 bg-green-50 text-green-700"
                  : "border-border bg-white text-foreground hover:border-primary hover:text-primary",
              )}
            >
              {pakCopiedLocally ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {pakCopiedLocally ? "Copied!" : "Copy to Clipboard"}
            </button>
          </div>

          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={confirmPakCopied}
            disabled={isLoading}
            className={cn(
              "w-full font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all text-sm",
              pakCopiedLocally
                ? "bg-green-600 text-white hover:bg-green-700 shadow-lg shadow-green-200"
                : "bg-secondary text-muted-foreground cursor-not-allowed opacity-60",
            )}
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            I've saved my PAK securely
          </motion.button>
          {error && <InlineError message={error} />}
        </motion.div>
      )}

      {/* ── CHANGE LOGIN PASSWORD — PAK entry ── */}
      {view === "chg-login-pak" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Change Login Password", "Step 1 of 2 — enter your PAK")}
          {error && <InlineError message={error} />}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              <KeyRound className="w-4 h-4 inline mr-1.5 opacity-60" />
              Personal Authorization Key (PAK)
            </label>
            <input value={pak} onChange={(e) => setPak(e.target.value)}
              placeholder="Your 40-character PAK"
              className="w-full px-4 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none text-sm font-mono" />
          </div>
          <PasswordInput label="New Login Password (min 8 chars)" value={pwd} onChange={setPwd} disabled={isLoading} />
          <div>
            <PasswordInput label="Confirm New Password" value={pwd2} onChange={setPwd2} disabled={isLoading} />
            {pwd2.length > 0 && (
              <p className={cn("text-xs mt-1.5 flex items-center gap-1.5", pwd === pwd2 ? "text-green-600" : "text-destructive")}>
                {pwd === pwd2
                  ? <><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Passwords match</>
                  : <><AlertCircle className="w-3.5 h-3.5 shrink-0" /> Passwords do not match</>}
              </p>
            )}
          </div>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={requestChangeLoginOtp} disabled={isLoading || !pak.trim() || (pwd2.length > 0 && pwd !== pwd2)}
            className="w-full bg-primary text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary/25 transition-shadow disabled:opacity-70 text-sm">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {isLoading ? "Verifying PAK…" : "Continue"}
          </motion.button>
        </motion.div>
      )}

      {/* ── CHANGE LOGIN PASSWORD — OTP step ── */}
      {view === "chg-login-otp" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Change Login Password", "Step 2 of 2 — verify your email")}
          <OtpStep
            label="A verification code was sent to your email to confirm the password change."
            otp={otp} setOtp={setOtp}
            onResend={resendOtp}
            onSubmit={confirmChangeLogin}
            isLoading={isLoading} error={error}
          />
        </motion.div>
      )}

      {/* ── CHANGE TRANSACTION PASSWORD — PAK entry ── */}
      {view === "chg-txn-pak" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Change Transaction Password", "Step 1 of 2 — enter your PAK")}
          {error && <InlineError message={error} />}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              <KeyRound className="w-4 h-4 inline mr-1.5 opacity-60" />
              Personal Authorization Key (PAK)
            </label>
            <input value={pak} onChange={(e) => setPak(e.target.value)}
              placeholder="Your 40-character PAK"
              className="w-full px-4 py-2.5 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none text-sm font-mono" />
          </div>
          <PasswordInput label="New Transaction Password (min 6 chars)" value={pwd} onChange={setPwd} disabled={isLoading} />
          <div>
            <PasswordInput label="Confirm New Password" value={pwd2} onChange={setPwd2} disabled={isLoading} />
            {pwd2.length > 0 && (
              <p className={cn("text-xs mt-1.5 flex items-center gap-1.5", pwd === pwd2 ? "text-green-600" : "text-destructive")}>
                {pwd === pwd2
                  ? <><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Passwords match</>
                  : <><AlertCircle className="w-3.5 h-3.5 shrink-0" /> Passwords do not match</>}
              </p>
            )}
          </div>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={requestChangeTxnOtp} disabled={isLoading || !pak.trim() || (pwd2.length > 0 && pwd !== pwd2)}
            className="w-full bg-primary text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary/25 transition-shadow disabled:opacity-70 text-sm">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {isLoading ? "Verifying PAK…" : "Continue"}
          </motion.button>
        </motion.div>
      )}

      {/* ── CHANGE TRANSACTION PASSWORD — OTP step ── */}
      {view === "chg-txn-otp" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Change Transaction Password", "Step 2 of 2 — verify your email")}
          <OtpStep
            label="A verification code was sent to your email to confirm the password change."
            otp={otp} setOtp={setOtp}
            onResend={resendOtp}
            onSubmit={confirmChangeTxn}
            isLoading={isLoading} error={error}
          />
        </motion.div>
      )}

      {/* ── DELETE ACCOUNT — PAK entry ── */}
      {view === "del-acct-pak" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Delete Account", "Step 1 of 2 — authorize with your PAK")}
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              <strong>This action is permanent and cannot be undone.</strong> All your data — balance, transaction history, wallets, and settings — will be erased forever.
            </span>
          </div>
          {error && <InlineError message={error} />}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              <KeyRound className="w-4 h-4 inline mr-1.5 opacity-60" />
              Personal Authorization Key (PAK)
            </label>
            <input value={pak} onChange={(e) => setPak(e.target.value)}
              placeholder="Your 40-character PAK"
              className="w-full px-4 py-2.5 rounded-xl bg-white border-2 border-red-300 focus:border-red-500 focus:ring-4 focus:ring-red-100 outline-none text-sm font-mono" />
            <p className="text-xs text-muted-foreground mt-1.5">
              Your PAK is required to prove this request came from you — not from an admin or anyone with database access.
            </p>
          </div>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={requestDeleteOtp} disabled={isLoading || !pak.trim()}
            className="w-full bg-red-600 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-red-700 transition-colors disabled:opacity-70 text-sm">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {isLoading ? "Verifying PAK…" : "Continue to confirmation"}
          </motion.button>
        </motion.div>
      )}

      {/* ── DELETE ACCOUNT — OTP step ── */}
      {view === "del-acct-otp" && (
        <motion.div variants={fadeUp} className="space-y-4">
          {panelHeader("Delete Account", "Step 2 of 2 — confirm via email")}
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Enter the code sent to your email to <strong>permanently delete</strong> your account. This cannot be reversed.</span>
          </div>
          <OtpStep
            label="A verification code was sent to your email. Enter it below to confirm account deletion."
            otp={otp} setOtp={setOtp}
            onResend={resendOtp}
            onSubmit={confirmDeleteAccount}
            isLoading={isLoading} error={error}
            submitLabel="Delete My Account"
            submitClassName="bg-red-600 hover:bg-red-700 text-white"
          />
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── Fund with Crypto ─────────────────────────────────────────────────────────

function CryptoDepositPanel({ walletAddress }: { walletAddress?: string }) {
  const address = walletAddress ?? "";

  return (
    <motion.div
      variants={staggerContainer(0.08)}
      initial="hidden"
      animate="show"
      className="space-y-6"
    >
      <motion.div variants={fadeUp} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-violet-50 border border-violet-200 text-violet-700 text-sm">
        <QrCode className="w-4 h-4 shrink-0 mt-0.5" />
        <span>Send <strong>USDC</strong> to your deposit address below from any supported testnet — <strong>Base Sepolia</strong>, <strong>Polygon Amoy</strong>, or <strong>Ethereum Sepolia</strong>. Your balance is credited automatically within seconds.</span>
      </motion.div>

      {address ? (
        <>
          <motion.div variants={fadeUp} className="p-5 rounded-2xl bg-white border-2 border-border space-y-4">
            <p className="text-sm font-medium text-muted-foreground">Your USDC deposit address</p>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-secondary">
              <code className="flex-1 text-xs font-mono break-all text-foreground">{address}</code>
              <CopyButton text={address} />
            </div>
            <p className="text-xs text-muted-foreground">Only send USDC on supported networks. Sending other tokens or using a different network may result in permanent loss.</p>
          </motion.div>

          <motion.div variants={fadeUp} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Deposits are credited after on-chain confirmation (typically 1–2 minutes). Contact support if funds don't appear after 30 minutes.</span>
          </motion.div>
        </>
      ) : (
        <motion.div variants={fadeUp} className="flex items-center gap-3 px-4 py-5 rounded-xl bg-secondary text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span>Loading your deposit address…</span>
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── Direct Bank Deposit — provider virtual account ──────────────────────────
// User selects a provider → system generates a permanent virtual bank account.
// User transfers any amount to that account at any time.
// Balance is credited automatically via provider webhook — no manual confirmation.

type Provider = "paystack" | "flutterwave" | "monnify";

interface VirtualAccount {
  id: number;
  provider: Provider;
  accountNumber: string;
  accountName: string;
  bankName: string;
}

const PROVIDER_META: Record<Provider, { label: string; color: string; border: string; bg: string }> = {
  paystack:    { label: "Paystack",    color: "text-blue-700",   border: "border-blue-200",   bg: "bg-blue-50"   },
  flutterwave: { label: "Flutterwave", color: "text-orange-700", border: "border-orange-200", bg: "bg-orange-50" },
  monnify:     { label: "Monnify",     color: "text-green-700",  border: "border-green-200",  bg: "bg-green-50"  },
};

function BankDepositForm({ onSuccess: _onSuccess }: { onSuccess: () => void }) {
  const [accounts,    setAccounts]    = useState<VirtualAccount[]>([]);
  const [isLoading,   setIsLoading]   = useState(true);
  const [generating,  setGenerating]  = useState<Provider | null>(null);
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);
  const [showPicker,  setShowPicker]  = useState(false);

  const authFetch = async (path: string, method: "GET" | "POST" = "GET", body?: object) => {
    const jwt = localStorage.getItem("token");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message ?? "Request failed");
    return json;
  };

  // Load existing virtual accounts on mount
  useEffect(() => {
    authFetch("/api/deposit/bank/virtual-accounts")
      .then((data) => setAccounts(data.accounts ?? []))
      .catch(() => setErrorMsg("Could not load your deposit accounts."))
      .finally(() => setIsLoading(false));
  }, []);

  const handleGenerate = async (provider: Provider) => {
    setErrorMsg(null);
    setGenerating(provider);
    setShowPicker(false);
    try {
      const data = await authFetch("/api/deposit/bank/virtual-account", "POST", { provider });
      setAccounts((prev) => [...prev, data.account]);
    } catch (e: any) {
      setErrorMsg(e.message || "Could not generate account. Please try again.");
    } finally {
      setGenerating(null);
    }
  };

  const availableProviders = (["paystack", "flutterwave", "monnify"] as Provider[]).filter(
    (p) => !accounts.some((a) => a.provider === p),
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 py-8 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading your deposit accounts…
      </div>
    );
  }

  return (
    <motion.div variants={staggerContainer(0.08)} initial="hidden" animate="show" className="space-y-5">
      <AnimatePresence>{errorMsg && <InlineError message={errorMsg} />}</AnimatePresence>

      {/* Intro note */}
      {accounts.length === 0 && (
        <motion.div variants={fadeUp} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-violet-50 border border-violet-200 text-violet-700 text-sm">
          <Landmark className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Generate a dedicated bank account number. Transfer any amount to it at any time — your balance is credited automatically.</span>
        </motion.div>
      )}

      {/* Existing virtual accounts */}
      <AnimatePresence>
        {accounts.map((acct) => {
          const meta = PROVIDER_META[acct.provider];
          return (
            <motion.div
              key={acct.id}
              variants={fadeUp}
              initial="hidden"
              animate="show"
              className={cn("rounded-2xl border-2 overflow-hidden", meta.border)}
            >
              {/* Provider header */}
              <div className={cn("flex items-center justify-between px-4 py-2.5", meta.bg)}>
                <span className={cn("text-xs font-bold uppercase tracking-wide", meta.color)}>{meta.label}</span>
                <span className="text-xs text-muted-foreground">NGN · Permanent account</span>
              </div>

              {/* Account rows */}
              {[
                { label: "Bank",           value: acct.bankName      },
                { label: "Account Name",   value: acct.accountName   },
                { label: "Account Number", value: acct.accountNumber },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-b-0 bg-white">
                  <span className="text-sm text-muted-foreground">{label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground font-mono">{value}</span>
                    <CopyButton text={value} />
                  </div>
                </div>
              ))}
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* Generate new account — provider picker */}
      {availableProviders.length > 0 && (
        <motion.div variants={fadeUp} className="space-y-3">
          {accounts.length > 0 && (
            <p className="text-xs text-muted-foreground">Add another provider</p>
          )}

          <AnimatePresence mode="wait">
            {!showPicker && !generating ? (
              <motion.button
                key="add-btn"
                variants={fadeUp}
                initial="hidden"
                animate="show"
                exit="hidden"
                type="button"
                onClick={() => setShowPicker(true)}
                className="w-full border-2 border-dashed border-border rounded-xl py-4 text-sm font-semibold text-muted-foreground hover:border-primary hover:text-primary flex items-center justify-center gap-2 transition-colors"
              >
                <Plus className="w-4 h-4" />
                {accounts.length === 0 ? "Generate Deposit Account" : "Add Another Provider"}
              </motion.button>
            ) : generating ? (
              <motion.div
                key="generating"
                variants={fadeUp}
                initial="hidden"
                animate="show"
                exit="hidden"
                className="flex items-center gap-3 px-4 py-4 rounded-xl bg-secondary text-sm text-muted-foreground"
              >
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                Generating your {PROVIDER_META[generating].label} account…
              </motion.div>
            ) : (
              <motion.div
                key="picker"
                variants={fadeIn}
                initial="hidden"
                animate="show"
                exit="hidden"
                className="space-y-2"
              >
                <p className="text-sm font-medium text-foreground">Select a provider</p>
                {availableProviders.map((provider) => {
                  const meta = PROVIDER_META[provider];
                  return (
                    <motion.button
                      key={provider}
                      type="button"
                      onClick={() => handleGenerate(provider)}
                      whileHover={{ x: 4, transition: { type: "spring", stiffness: 400, damping: 20 } }}
                      className={cn(
                        "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-colors text-left",
                        meta.bg, meta.border,
                      )}
                    >
                      <span className={cn("text-sm font-semibold", meta.color)}>{meta.label}</span>
                      <ArrowRight className={cn("w-4 h-4", meta.color)} />
                    </motion.button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setShowPicker(false)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors pt-1"
                >
                  Cancel
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Footer note */}
      {accounts.length > 0 && (
        <motion.div variants={fadeUp} className="flex items-start gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-xs">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>These are permanent accounts. Transfer any amount at any time — your balance is credited automatically within minutes of confirmation.</span>
        </motion.div>
      )}
    </motion.div>
  );
}
