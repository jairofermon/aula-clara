import type { MindmapNodeContent } from "@aula-clara/shared";

function MindmapBranch({ node, depth = 0 }: { node: MindmapNodeContent; depth?: number }) {
  return (
    <li className={depth ? "ml-5 border-l-2 border-emerald-200 pl-4" : ""}>
      <div
        className={`inline-block rounded-xl px-4 py-2 font-bold ${depth === 0 ? "bg-[#176b58] text-white" : "bg-[#edf5f1] text-[#173d35]"}`}
      >
        {node.label}
      </div>
      {node.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {node.children.map((child) => (
            <MindmapBranch node={child} depth={depth + 1} key={child.id} />
          ))}
        </ul>
      )}
    </li>
  );
}

function StructuredMindmap({ root }: { root: MindmapNodeContent }) {
  return (
    <div
      className="overflow-auto rounded-xl border border-[#dbe4df] bg-white p-5"
      aria-label="Mapa mental hierárquico"
    >
      <ul>
        <MindmapBranch node={root} />
      </ul>
    </div>
  );
}

export function MindmapView({ root }: { root: MindmapNodeContent }) {
  return <StructuredMindmap root={root} />;
}
