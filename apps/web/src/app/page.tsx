import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-16">
      <span className="mb-5 w-fit rounded-full bg-[#e2efe9] px-4 py-2 text-sm font-bold text-[#176b58]">
        Aula Clara · versão inicial
      </span>
      <h1 className="max-w-4xl text-5xl font-black tracking-tight sm:text-7xl">
        A gravação termina. O estudo começa claro.
      </h1>
      <p className="mt-7 max-w-2xl text-lg leading-8 text-[#61736f]">
        Transcrição com timestamps, revisão humana e materiais de estudo derivados da versão que
        você validou.
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link className="btn btn-primary" href="/register">
          Criar minha conta
        </Link>
        <Link className="btn btn-secondary" href="/login">
          Entrar
        </Link>
      </div>
      <p className="mt-10 max-w-2xl border-l-4 border-[#e6b85c] pl-4 text-sm text-[#61736f]">
        Ao usar o produto, confirme que possui autorização para gravar e processar a aula.
      </p>
    </main>
  );
}
