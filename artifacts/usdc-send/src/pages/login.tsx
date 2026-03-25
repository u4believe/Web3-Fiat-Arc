import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, Lock, ArrowRight, Loader2, Send } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useLoginUser } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { AppLayout } from "@/components/layout";
import { fadeUp, scaleIn, staggerContainer } from "@/lib/motion";

const loginSchema = z.object({
  email: z.string().email("Valid email required"),
  password: z.string().min(1, "Password required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const loginMutation = useLoginUser();
  const [error, setError] = useState("");

  const { register, handleSubmit, formState: { errors } } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormValues) => {
    try {
      setError("");
      const response = await loginMutation.mutateAsync({ data });
      localStorage.setItem("token", response.token);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setLocation("/dashboard");
    } catch (err: any) {
      setError(err.message || "Failed to login. Please check your credentials.");
    }
  };

  return (
    <AppLayout>
      {/* Animated background orbs */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="orb orb-blue w-[600px] h-[600px] top-[-200px] right-[-100px]" />
        <div className="orb orb-cyan w-[400px] h-[400px] bottom-[-100px] left-[-100px]" />
      </div>

      <div className="min-h-[calc(100vh-5rem)] flex items-center justify-center p-4">
        <motion.div
          variants={staggerContainer(0.1, 0)}
          initial="hidden"
          animate="show"
          className="w-full max-w-md"
        >
          {/* Logo mark */}
          <motion.div variants={fadeUp} className="flex justify-center mb-8">
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: "easeInOut" }}
              className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white shadow-xl shadow-primary/25"
            >
              <Send className="w-7 h-7" />
            </motion.div>
          </motion.div>

          {/* Headline */}
          <motion.div variants={fadeUp} className="text-center mb-8">
            <h1 className="text-3xl font-display font-bold">Welcome back</h1>
            <p className="text-muted-foreground mt-2">Log in to claim and manage your USDC.</p>
          </motion.div>

          {/* Card */}
          <motion.div variants={scaleIn} className="glass-panel p-8 rounded-3xl">
            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: -8 }}
                  animate={{ opacity: 1, height: "auto", y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                  className="mb-6 p-4 rounded-xl bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20 overflow-hidden"
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.form
              onSubmit={handleSubmit(onSubmit)}
              variants={staggerContainer(0.08, 0.1)}
              initial="hidden"
              animate="show"
              className="space-y-5"
            >
              {/* Email */}
              <motion.div variants={fadeUp}>
                <label className="block text-sm font-medium text-foreground mb-2">Email</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground">
                    <Mail className="w-5 h-5" />
                  </div>
                  <input
                    {...register("email")}
                    className={cn(
                      "w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none",
                      errors.email && "border-destructive focus:border-destructive",
                    )}
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                </div>
                <AnimatePresence>
                  {errors.email && (
                    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-destructive">
                      {errors.email.message}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>

              {/* Password */}
              <motion.div variants={fadeUp}>
                <label className="block text-sm font-medium text-foreground mb-2">Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground">
                    <Lock className="w-5 h-5" />
                  </div>
                  <input
                    type="password"
                    {...register("password")}
                    className={cn(
                      "w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none",
                      errors.password && "border-destructive focus:border-destructive",
                    )}
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                </div>
                <AnimatePresence>
                  {errors.password && (
                    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-destructive">
                      {errors.password.message}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>

              {/* Submit */}
              <motion.div variants={fadeUp} className="pt-1">
                <motion.button
                  type="submit"
                  disabled={loginMutation.isPending}
                  whileHover={!loginMutation.isPending ? { scale: 1.02, y: -1 } : {}}
                  whileTap={!loginMutation.isPending ? { scale: 0.98 } : {}}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold text-white bg-primary hover:shadow-lg hover:shadow-primary/30 transition-shadow disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {loginMutation.isPending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>Log In <ArrowRight className="w-5 h-5" /></>
                  )}
                </motion.button>
              </motion.div>
            </motion.form>

            <motion.div variants={fadeUp} initial="hidden" animate="show" transition={{ delay: 0.5 }} className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                Don't have an account?{" "}
                <Link href="/register" className="font-semibold text-primary hover:underline">
                  Sign up
                </Link>
              </p>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </AppLayout>
  );
}
