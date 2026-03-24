import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, Lock, User, ArrowRight, Loader2 } from "lucide-react";
import { useRegisterUser } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { AppLayout } from "@/components/layout";

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Valid email required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export default function Register() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const registerMutation = useRegisterUser();
  const [error, setError] = useState("");

  const { register, handleSubmit, formState: { errors } } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = async (data: RegisterFormValues) => {
    try {
      setError("");
      const response = await registerMutation.mutateAsync({ data });
      localStorage.setItem("token", response.token);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setLocation("/dashboard");
    } catch (err: any) {
      setError(err.message || "Failed to register. Please try again.");
    }
  };

  return (
    <AppLayout>
      <div className="min-h-[calc(100vh-5rem)] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-display font-bold">Create Account</h1>
            <p className="text-muted-foreground mt-2">Sign up to claim funds sent to your email.</p>
          </div>

          <div className="glass-panel p-8 rounded-3xl">
            {error && (
              <div className="mb-6 p-4 rounded-xl bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Full Name</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground">
                    <User className="w-5 h-5" />
                  </div>
                  <input 
                    {...register("name")}
                    className={cn(
                      "w-full pl-11 pr-4 py-3 rounded-xl bg-white border-2 border-border focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all outline-none",
                      errors.name && "border-destructive focus:border-destructive"
                    )}
                    placeholder="Satoshi Nakamoto"
                  />
                </div>
                {errors.name && <p className="mt-1.5 text-sm text-destructive">{errors.name.message}</p>}
              </div>

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
                disabled={registerMutation.isPending}
                className="w-full mt-4 flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold text-white bg-foreground hover:bg-foreground/90 transition-all hover:shadow-lg active:scale-[0.98] disabled:opacity-70"
              >
                {registerMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>Create Account <ArrowRight className="w-5 h-5" /></>
                )}
              </button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                Already have an account?{" "}
                <Link href="/login" className="font-semibold text-primary hover:underline">
                  Log in
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
