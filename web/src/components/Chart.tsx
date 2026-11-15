import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import { useI18n } from '../i18n';

/**
 * Single-series chart (bar / horizontal bar / line). One hue per chart — the card title names it, no legend.
 * Thin marks, rounded bar ends, recessive grid, hover tooltip (value + share of total + optional extra line),
 * height adapts to the number of bars, and a data table for accessibility.
 */
export function SimpleChart({ type, labels, values, color, format = (v) => String(v), label, height, share = false, extra }: {
  type: 'bar' | 'hbar' | 'line'; labels: string[]; values: number[]; color: string; label: string;
  format?: (v: number) => string; height?: number; share?: boolean; extra?: (i: number) => string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const total = values.reduce((a, b) => a + b, 0);
  // Horizontal bars: ~34px per row so long labels never overlap; vertical charts: fixed comfortable height.
  const h = height ?? (type === 'hbar' ? Math.max(160, labels.length * 34 + 40) : 240);

  useEffect(() => {
    const narrow = window.innerWidth < 480;
    const chart = new Chart(ref.current!, {
      type: type === 'line' ? 'line' : 'bar',
      data: {
        labels,
        datasets: [{
          label, data: values, backgroundColor: type === 'line' ? `${color}22` : color, borderColor: color,
          borderWidth: type === 'line' ? 2 : 0, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28,
          pointRadius: type === 'line' ? (labels.length > 20 ? 0 : 3) : undefined, pointHoverRadius: 6, tension: 0.3, fill: type === 'line',
        }],
      },
      options: {
        indexAxis: type === 'hbar' ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#2B1D14', padding: 10, displayColors: false, titleFont: { weight: 'bold' },
            callbacks: {
              label: (c) => {
                const v = Number(c.raw);
                const lines = [format(v)];
                if (share && total) lines.push(`${Math.round((v / total) * 100)}%`);
                if (extra) lines.push(extra(c.dataIndex));
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: type === 'hbar', color: '#F1E9DA' }, border: { display: false },
            ticks: { color: '#6B5A4E', maxRotation: 0, autoSkip: true, autoSkipPadding: 8, font: { size: narrow ? 10 : 12 }, ...(type === 'hbar' ? { callback: (v: string | number) => format(Number(v)) } : {}) },
          },
          y: {
            grid: { display: type !== 'hbar', color: '#F1E9DA' }, border: { display: false }, beginAtZero: true,
            ticks: {
              color: '#6B5A4E', font: { size: narrow ? 10 : 12 }, maxTicksLimit: 6,
              callback: type === 'hbar'
                ? function (this: { getLabelForValue: (v: number) => string }, v) { const s = this.getLabelForValue(Number(v)); return s.length > 18 ? `${s.slice(0, 17)}…` : s; }
                : (v) => format(Number(v)),
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [type, JSON.stringify(labels), JSON.stringify(values), color]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-w-0">
      <div style={{ height: h }} className="relative w-full"><canvas ref={ref} role="img" aria-label={label} /></div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted">▦ {t('common.dataTable')}</summary>
        <div className="max-h-64 overflow-y-auto"><table className="w-full mt-1"><tbody>
          {labels.map((l, i) => (
            <tr key={l + i}><td className="td">{l}</td><td className="td text-right tabular-nums">{format(values[i] ?? 0)}</td>
              {share && <td className="td text-right tabular-nums text-muted">{total ? Math.round(((values[i] ?? 0) / total) * 100) : 0}%</td>}</tr>
          ))}
        </tbody></table></div>
      </details>
    </div>
  );
}

/** Part-to-whole as one labelled 100% bar (clearer than a donut for 2–4 parts). Names are direct-labelled. */
export function ShareBar({ parts }: { parts: { label: string; value: number; color: string; display: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-full bg-line gap-[2px]" role="img"
        aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} className="h-full first:rounded-l-full last:rounded-r-full" />)}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 min-w-0"><span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden /><span className="truncate">{p.label}</span></span>
            <span className="tabular-nums font-semibold">{p.display} <span className="text-muted font-normal">· {Math.round((p.value / total) * 100)}%</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
