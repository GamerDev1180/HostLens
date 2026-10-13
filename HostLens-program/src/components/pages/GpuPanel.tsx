import { MonitorCog } from "lucide-react";
import type { AgentState } from "../../types";
import { formatBytes } from "../../format";
import { HISTORY_LENGTH } from "../../useAgents";
import { AreaChart } from "../ui/AreaChart";
import { Gauge } from "../ui/Gauge";
import { Card } from "../ui/common";

/** GPUs run hotter than CPUs; most throttle in the mid-80s °C. */
export const tempColor = (c: number | null) =>
  c === null ? "var(--text-3)" : c >= 85 ? "var(--danger)" : c >= 72 ? "var(--warning)" : "var(--success)";

const secondsAgo = (n: number) => (n === 0 ? "now" : `${n} s ago`);
const orDash = (v: number | null, unit: string, digits = 0) => (v === null ? "–" : `${v.toFixed(digits)} ${unit}`);

export function GpuPanel({ state }: { state: AgentState }) {
  const gpus = state.metrics?.gpus;
  // Agents before 1.3 don't send the field at all; show nothing for them.
  if (!gpus) return null;

  if (gpus.length === 0) {
    return (
      <Card title="GPU" icon={MonitorCog}>
        <p className="muted">
          No supported graphics card found. HostLens currently reads NVIDIA GPUs through <code>nvidia-smi</code>, which
          comes with the NVIDIA driver; AMD and Intel support is planned.
        </p>
      </Card>
    );
  }

  return (
    <>
      {gpus.map((gpu, i) => {
        const vram =
          gpu.memoryTotalBytes && gpu.memoryUsedBytes !== null ? (gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100 : null;
        const history = state.gpuHistory[i] ?? { util: [], vram: [] };
        return (
          <Card key={gpu.index} title={`GPU ${gpus.length > 1 ? `${gpu.index} ` : ""}· ${gpu.name}`} icon={MonitorCog}>
            <div className="gpu-grid">
              <div className="gpu-gauges">
                <Gauge value={gpu.utilizationPercent} label="Load" size={96} color="var(--accent)" />
                <Gauge
                  value={vram}
                  label="VRAM"
                  size={96}
                  color="var(--purple)"
                  detail={
                    gpu.memoryTotalBytes !== null && gpu.memoryUsedBytes !== null
                      ? `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`
                      : undefined
                  }
                />
                <Gauge
                  // Shown on a 0–100 °C scale.
                  value={gpu.temperatureC}
                  label="Temperature"
                  size={96}
                  color={tempColor(gpu.temperatureC)}
                  centerText={
                    gpu.temperatureC === null ? "–" : (
                      <>
                        {gpu.temperatureC}
                        <small>°C</small>
                      </>
                    )
                  }
                />
              </div>
              <dl className="facts gpu-facts">
                <dt>Power</dt>
                <dd>
                  {orDash(gpu.powerDrawW, "W", 1)}
                  {gpu.powerLimitW !== null && <span className="muted"> of {gpu.powerLimitW.toFixed(0)} W</span>}
                </dd>
                <dt>Fan</dt>
                <dd>{gpu.fanPercent === null ? "–" : `${gpu.fanPercent}%`}</dd>
                <dt>Core clock</dt>
                <dd>{orDash(gpu.coreClockMhz, "MHz")}</dd>
                <dt>Memory clock</dt>
                <dd>{orDash(gpu.memoryClockMhz, "MHz")}</dd>
                <dt>Driver</dt>
                <dd className="mono">{gpu.driverVersion ?? "–"}</dd>
              </dl>
            </div>
            <AreaChart
              series={[
                { label: "Load", values: history.util, color: "var(--accent)" },
                { label: "VRAM", values: history.vram, color: "var(--purple)" },
              ]}
              length={HISTORY_LENGTH}
              max={100}
              format={(v) => `${Math.round(v)}%`}
              xLabels={["60 s ago", "now"]}
              slotLabel={secondsAgo}
              height={120}
            />
          </Card>
        );
      })}
    </>
  );
}
