import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, Lock, ArrowRight, Loader2 } from "lucide-react";
import { useLoginUser } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { AppLayout } from "@/components/layout";

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
      <div className="min-h-[calc(100vh-5rem)] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-display font-bold">Welcome back</h1>
            <p className="text-muted-foreground mt-2">Log in to claim and manage your USDC.</p>
          </div>

          <div className="glass-panel p-8 rounded-3xl">
            {error && (
              <div className="mb-6 p-4 rounded-xl bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Email</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground">
                    <Mail className="w-5 h-5" />
                  </div>
                  <input 
                    {...register("email")}
                    className={cn(
                      "w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none",
                      errors.email && "border-destructive focus:border-destructive"
                    )}
                    placeholder="you@example.com"
                  />
                </div>
                {errors.email && <p className="mt-1.5 text-sm text-destructive">{errors.email.message}</p>}
              </div>

              <div>
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
                      errors.password && "border-destructive focus:border-destructive"
                    )}
                    placeholder="••••••••"
                  />
                </div>
                {errors.password && <p className="mt-1.5 text-sm text-destructive">{errors.password.message}</p>}
              </div>

              <button
                type="submit"
                disabled={loginMutation.isPending}
                className="w-full mt-4 flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold text-white bg-primary hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/30 active:scale-[0.98] disabled:opacity-70"
              >
                {loginMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>Log In <ArrowRight className="w-5 h-5" /></>
                )}
              </button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                Don't have an account?{" "}
                <Link href="/register" className="font-semibold text-primary hover:underline">
                  Sign up
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
