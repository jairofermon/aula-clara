export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const safe = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-[#61736f]">
        <span>{label ?? "Progresso"}</span>
        <span>{safe}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-[#e4ebe7]"
        role="progressbar"
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? "Progresso"}
      >
        <div
          className="h-full rounded-full bg-[#176b58] transition-[width]"
          style={{ width: `${safe}%` }}
        />
      </div>
    </div>
  );
}
