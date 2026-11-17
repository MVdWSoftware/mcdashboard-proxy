/** Minimal Prometheus text exposition, no dependency. */
export class Metrics {
  private readonly counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const l = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/[\\"\n]/g, "")}"`).join(",");
    const key = l ? `${name}{${l}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  render(gauges: Record<string, number> = {}): string {
    const lines: string[] = [];
    for (const [k, v] of [...this.counters].sort()) lines.push(`${k} ${v}`);
    for (const [k, v] of Object.entries(gauges)) lines.push(`${k} ${v}`);
    return lines.join("\n") + "\n";
  }
}
