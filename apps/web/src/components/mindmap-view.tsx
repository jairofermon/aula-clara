"use client";

import { useEffect, useRef, useState } from "react";

export function MindmapView({ code }: { code: string }) {
  const id = useRef(`mindmap-${crypto.randomUUID()}`);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([import("mermaid"), import("dompurify")]).then(
      async ([mermaidModule, purifyModule]) => {
        try {
          const mermaid = mermaidModule.default;
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
          const rendered = await mermaid.render(id.current, code);
          if (active)
            setSvg(
              purifyModule.default.sanitize(rendered.svg, {
                USE_PROFILES: { svg: true, svgFilters: true }
              })
            );
        } catch {
          if (active)
            setError("O mapa não pôde ser renderizado. O código Mermaid continua disponível.");
        }
      }
    );
    return () => {
      active = false;
    };
  }, [code]);

  if (error) return <p className="rounded-lg bg-amber-50 p-3 text-sm">{error}</p>;
  if (!svg) return <div className="skeleton h-64" aria-label="Renderizando mapa mental" />;
  return (
    <div
      className="overflow-auto"
      aria-label="Mapa mental"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
