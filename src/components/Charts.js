export function fmtRp(n) {
  return "Rp" + new Intl.NumberFormat("id-ID").format(Number(n || 0));
}

const STATUS_META = {
  lunas: { label: "Lunas", color: "#22c55e" },
  dp: { label: "DP", color: "#f59e0b" },
  belum: { label: "Belum bayar", color: "#EA580C" },
};

export function BarChart({ labels, values, onSelect }) {
  const max = Math.max(0, ...values);
  if (!values.length || !max) return <p className="text-sm text-zinc-400">Belum ada data pada periode ini.</p>;
  const W = 600, H = 220, padB = 34, padT = 30;
  const bw = Math.min(48, (W - 16 - 6 * (values.length - 1)) / values.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Grafik batang pemasukan">
      {values.map((v, i) => {
        const bh = ((v / max) * (H - padT - padB));
        const x = 8 + i * (bw + 6);
        const y = padT + (H - padT - padB) - bh;
        return (
          <g key={i} onClick={onSelect ? () => onSelect(labels[i], v) : undefined}
            style={onSelect ? { cursor: "pointer" } : undefined}>
            <title>{`${labels[i]}: ${fmtRp(v)}`}</title>
            <rect x={x} y={y} width={bw} height={bh} fill="var(--accent)" />
            {bw >= 28 && <text x={x + bw / 2} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="700" className="chart-label">{fmtRp(v)}</text>}
            <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#667085">{labels[i].slice(5)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function DonutChart({ parts, onSelect }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <p className="text-sm text-zinc-400">Belum ada data pada periode ini.</p>;
  const R = 70, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-48 h-48">
        <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90" role="img" aria-label="Grafik donat status pembayaran">
          <circle cx="100" cy="100" r={R} fill="none" stroke="currentColor" strokeWidth="26" className="donut-track" />
          {parts.map((p) => {
            const len = (p.value / total) * C;
            const el = (
              <circle key={p.label} cx="100" cy="100" r={R} fill="none" stroke={p.color} strokeWidth="26"
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
                onClick={onSelect && p.value ? () => onSelect(p) : undefined}
                style={onSelect && p.value ? { cursor: "pointer" } : undefined}>
                <title>{`${p.label}: ${fmtRp(p.value)}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none px-6">
          <div className="font-black text-lg leading-tight break-words">{fmtRp(total)}</div>
          <div className="text-xs text-zinc-400">Total periode</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 justify-center text-sm">
        {parts.map((p) => {
          const inner = (<><i className="w-3 h-3 rounded-sm inline-block" style={{ background: p.color }} />{p.label}: {fmtRp(p.value)}</>);
          return onSelect && p.value ? (
            <button key={p.label} type="button" onClick={() => onSelect(p)} className="inline-flex items-center gap-2 cursor-pointer">{inner}</button>
          ) : (
            <span key={p.label} className="inline-flex items-center gap-2">{inner}</span>
          );
        })}
      </div>
    </div>
  );
}

export function HBarChart({ rows }) {
  const max = Math.max(0, ...rows.map((r) => Number(r.total)));
  if (!rows.length || !max) return <p className="text-sm text-zinc-400">Belum ada data pada periode ini.</p>;
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.service_type} className="grid grid-cols-[140px_1fr_auto] gap-3 items-center text-sm max-sm:grid-cols-[1fr_auto] max-sm:[&>*:first-child]:col-span-2">
          <span className="truncate font-medium">{r.service_type}</span>
          <div className="h-5 bg-zinc-800 rounded-sm overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${(Number(r.total) / max) * 100}%` }} />
          </div>
          <span className="text-zinc-300 whitespace-nowrap">{fmtRp(r.total)}</span>
        </div>
      ))}
    </div>
  );
}

export function statusPill(status) {
  const meta = STATUS_META[status] || { label: status, color: "#a1a1aa" };
  const cls = status === "lunas" ? "bg-emerald-500/15 text-emerald-400"
    : status === "dp" ? "bg-amber-500/15 text-amber-400" : "bg-orange-500/15 text-orange-400";
  return <span className={`inline-block self-start shrink-0 px-3 py-0.5 rounded-full text-xs font-bold ${cls}`}>{meta.label}</span>;
}

export function statusParts(totals) {
  return [
    { label: "Lunas", value: Number(totals.total_lunas || 0), color: "#22c55e" },
    { label: "DP", value: Number(totals.total_dp || 0), color: "#f59e0b" },
    { label: "Belum bayar", value: Number(totals.total_belum || 0), color: "#EA580C" },
  ];
}

export function groupByDate(jobs) {
  const map = {};
  jobs.forEach((j) => { map[j.job_date] = (map[j.job_date] || 0) + Number(j.amount); });
  const dates = Object.keys(map).sort();
  return { dates, values: dates.map((d) => map[d]) };
}
