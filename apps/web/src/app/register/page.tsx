import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-5 py-12">
      <AuthForm mode="register" />
      <Link className="text-sm underline" href="/login">
        Já tenho conta
      </Link>
    </main>
  );
}
