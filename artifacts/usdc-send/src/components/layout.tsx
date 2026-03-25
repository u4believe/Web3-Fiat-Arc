import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Wallet, LogOut, LayoutDashboard, Send } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useGetCurrentUser } from "@workspace/api-client-react";

export function Navbar() {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data: user, isSuccess } = useGetCurrentUser({
    query: { retry: false }
  });

  const handleLogout = () => {
    localStorage.removeItem("token");
    queryClient.clear();
    setLocation("/");
  };

  return (
    <motion.nav
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-border/50 transition-all duration-300"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white shadow-lg shadow-primary/20 group-hover:shadow-primary/40 group-hover:-translate-y-0.5 transition-all">
              <Send className="w-5 h-5" />
            </div>
            <span className="font-display font-bold text-2xl text-foreground tracking-tight">USDC Send</span>
          </Link>

          <div className="flex items-center gap-4">
            {isSuccess && user ? (
              <>
                <Link href="/dashboard" className="hidden md:flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors">
                  <LayoutDashboard className="w-4 h-4" />
                  Dashboard
                </Link>
                <div className="h-8 w-px bg-border hidden md:block"></div>
                <div className="flex items-center gap-3">
                  <div className="hidden sm:flex flex-col items-end">
                    <span className="text-sm font-medium text-foreground">{user.name}</span>
                    <span className="text-xs text-muted-foreground">{user.email}</span>
                  </div>
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold border border-primary/20">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                  <button 
                    onClick={handleLogout}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                    title="Log out"
                  >
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <Link href="/login" className="px-5 py-2.5 rounded-xl text-sm font-medium text-foreground hover:bg-secondary/80 transition-colors">
                  Log in
                </Link>
                <Link href="/register" className="px-5 py-2.5 rounded-xl text-sm font-medium bg-foreground text-background hover:bg-foreground/90 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </motion.nav>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-20">
        {children}
      </main>
    </div>
  );
}
