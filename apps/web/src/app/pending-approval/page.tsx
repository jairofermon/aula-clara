import { LogoutButton } from "@/components/logout-button";

export const metadata = { title: "Aguardando aprovação" };

export default function PendingApprovalPage() {
  return (
    <main className="grid min-h-screen place-items-center px-5">
      <section className="card max-w-lg p-8 text-center">
        <h1 className="text-3xl font-black">Cadastro aguardando aprovação</h1>
        <p className="mt-3 text-[#61736f]">
          Seu cadastro foi recebido. Um administrador precisa aprová-lo antes do primeiro uso.
        </p>
        <div className="mt-6 flex justify-center">
          <LogoutButton />
        </div>
      </section>
    </main>
  );
}
