import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-5 py-12">
      <AuthForm mode="login" />
      <div className="flex gap-4 text-sm">
        <Link className="underline" href="/register">
          Criar conta
        </Link>
        <Link className="underline" href="/forgot-password">
          Esqueci a senha
        </Link>
      </div>
    </main>
  );
}
