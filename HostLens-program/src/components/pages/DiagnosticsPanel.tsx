import { FormEvent, useState } from "react";
import {
  CircleCheck,
  CircleX,
  Globe,
  Play,
  Router,
  SearchCode,
  Stethoscope,
  TriangleAlert,
  Waypoints,
  X,
} from "lucide-react";
import { agentRequest, isUnsupported } from "../../agentApi";
import type {
  DiagnosticRequest,
  DiagnosticResult,
  DnsResult,
  PingResult,
  Subscription,
  TcpResult,
  TracerouteResult,
} from "../../types";
import { Card } from "../ui/common";

interface Props {
  subscription: Subscription;
}

type TestType = DiagnosticRequest["type"];
const TYPE_LABEL: Record<TestType, string> = { ping: "Ping", traceroute: "Traceroute", dns: "DNS lookup", tcp: "TCP port" };
const PRESETS = ["1.1.1.1", "google.com", "discord.com", "frontend.cfx-services.net"];
/** Traceroute can take up to ~20 s on a bad route. */
const TIMEOUT_MS = 60_000;

const run = (sub: Subscription, req: DiagnosticRequest) =>
  agentRequest<DiagnosticResult>(sub.url, "POST", "/api/v1/diagnostics", sub.token ?? null, req, TIMEOUT_MS);

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v)} ms`);

// ── Result views ────────────────────────────────────────────────────────

function PingView({ r }: { r: PingResult }) {
  const max = Math.max(1, ...r.samples.map((s) => s ?? 0));
  return (
    <>
      <div className="diag-stats">
        <span className={r.lossPercent > 0 ? "bad-text" : "ok-text"}>
          <b>{r.lossPercent}%</b> loss
        </span>
        <span>
          <b>{ms(r.avgMs)}</b> average
        </span>
        <span>
          <b>
            {ms(r.minMs)} – {ms(r.maxMs)}
          </b>{" "}
          range
        </span>
        <span>
          <b>{ms(r.jitterMs)}</b> jitter
        </span>
      </div>
      <div className="probe-bars" title="One bar per probe">
        {r.samples.map((s, i) =>
          s === null ? (
            <span key={i} className="probe lost" title={`Probe ${i + 1}: lost`}>
              <X size={12} />
            </span>
          ) : (
            <span key={i} className="probe" title={`Probe ${i + 1}: ${s} ms`}>
              <i style={{ height: `${Math.max(8, (s / max) * 100)}%` }} />
            </span>
          ),
        )}
      </div>
    </>
  );
}

function TraceView({ r }: { r: TracerouteResult }) {
  const max = Math.max(1, ...r.hops.map((h) => h.rttMs ?? 0));
  const lastAnswer = [...r.hops].reverse().find((h) => h.address);
  return (
    <>
      <ol className="hop-list">
        {r.hops.map((h) => (
          <li key={h.ttl} className={h.address ? "" : "silent"}>
            <span className="hop-ttl">{h.ttl}</span>
            <span className={`scope-dot ${h.scope ?? ""}`} />
            <span className="hop-name ellipsis" title={h.address ?? undefined}>
              {h.address ? (h.host ?? <span className="mono">{h.address}</span>) : <span className="muted">no reply</span>}
              {h.host && <span className="mono muted"> {h.address}</span>}
            </span>
            <span className="hop-bar">{h.rttMs !== null && <i style={{ width: `${Math.max(3, (h.rttMs / max) * 100)}%` }} />}</span>
            <span className="hop-ms mono">{ms(h.rttMs)}</span>
          </li>
        ))}
      </ol>
      <p className={r.reached ? "ok-text" : "bad-text"}>
        {r.reached
          ? `Reached ${r.address} in ${r.hops.length} hops.`
          : `Didn't reach ${r.address}.${lastAnswer ? ` Last answer from hop ${lastAnswer.ttl} (${lastAnswer.host ?? lastAnswer.address}).` : " No hop answered."} Some routers never answer traceroute, so a silent hop isn't always the problem.`}
      </p>
    </>
  );
}

function DnsView({ r }: { r: DnsResult }) {
  const row = (label: string, part: DnsResult["resolver"]) => (
    <div className="dns-row">
      <span className="label">{label}</span>
      {part.error ? (
        <span className="bad-text">
          <CircleX size={14} /> {part.error}
        </span>
      ) : (
        <span className="ok-text">
          <CircleCheck size={14} /> {part.durationMs} ms
        </span>
      )}
      <span className="mono muted ellipsis" title={part.addresses.join("\n")}>
        {part.addresses.slice(0, 4).join(", ")}
        {part.addresses.length > 4 ? ` +${part.addresses.length - 4}` : ""}
      </span>
    </div>
  );
  return (
    <>
      {row("Name servers", r.resolver)}
      {row("System lookup", r.system)}
      <p className="hint">
        Servers: <span className="mono">{r.servers.join(", ") || "none configured"}</span>. The system lookup also uses
        the hosts file and caches, like apps do.
      </p>
    </>
  );
}

function TcpView({ r }: { r: TcpResult }) {
  return (
    <p className={r.connected ? "ok-text" : "bad-text"}>
      {r.connected ? <CircleCheck size={15} /> : <CircleX size={15} />}{" "}
      {r.connected
        ? `Port ${r.port} on ${r.address} accepts connections (${r.connectMs} ms).`
        : `Couldn't connect to ${r.address ?? r.target}:${r.port}: ${r.error}.`}
    </p>
  );
}

function ResultView({ r }: { r: DiagnosticResult }) {
  switch (r.type) {
    case "ping":
      return <PingView r={r} />;
    case "traceroute":
      return <TraceView r={r} />;
    case "dns":
      return <DnsView r={r} />;
    case "tcp":
      return <TcpView r={r} />;
  }
}

interface Entry {
  id: number;
  request: DiagnosticRequest;
  result: DiagnosticResult | null;
  error: string | null;
}

// ── Connectivity check: local network → internet → DNS ──────────────────

type Tone = "ok" | "warn" | "bad";

interface Assessment {
  tone: Tone;
  verdict: string;
  steps: { icon: typeof Router; label: string; tone: Tone; detail: string }[];
}

function assess(trace: TracerouteResult | null, ping: PingResult | null, dns: DnsResult | null): Assessment {
  const gateway = trace?.hops[0];
  const gatewayOk = !!gateway?.address;
  const internetOk = !!ping && ping.received > 0;
  const dnsOk = !!dns && (!dns.resolver.error || !dns.system.error);
  const dnsMs = dns ? Math.min(dns.resolver.error ? Infinity : dns.resolver.durationMs, dns.system.error ? Infinity : dns.system.durationMs) : null;

  const steps: Assessment["steps"] = [
    {
      icon: Router,
      label: "Local network",
      tone: gatewayOk ? ((gateway.rttMs ?? 0) > 20 ? "warn" : "ok") : "bad",
      detail: gatewayOk ? `Router ${gateway.host ?? gateway.address} answers in ${ms(gateway.rttMs)}` : "The router didn't answer",
    },
    {
      icon: Globe,
      label: "Internet",
      tone: !internetOk ? "bad" : ping.lossPercent > 0 || (ping.avgMs ?? 0) > 100 ? "warn" : "ok",
      detail: internetOk ? `1.1.1.1: ${ms(ping.avgMs)} average, ${ping.lossPercent}% loss` : "1.1.1.1 doesn't answer",
    },
    {
      icon: SearchCode,
      label: "DNS",
      tone: !dnsOk ? "bad" : (dnsMs ?? 0) > 500 ? "warn" : "ok",
      detail: dnsOk ? `google.com resolved in ${ms(dnsMs)}` : `Can't resolve names (${dns?.resolver.error ?? "error"})`,
    },
  ];

  let tone: Tone = "ok";
  let verdict = "Everything looks fine.";
  if (!gatewayOk && !internetOk) {
    tone = "bad";
    verdict = "The local network looks down: the router doesn't answer. Check the cable or Wi-Fi and the router itself.";
  } else if (!internetOk) {
    const last = trace ? [...trace.hops].reverse().find((h) => h.address) : undefined;
    tone = "bad";
    verdict = `The local network works, but the internet isn't reachable${last ? `: traffic stops after hop ${last.ttl} (${last.host ?? last.address})` : ""}. That points at the internet provider or the route.`;
  } else if (!dnsOk) {
    tone = "bad";
    verdict = "The internet works, but names can't be resolved: a DNS problem. Check the DNS servers set on the router or this machine.";
  } else if (ping.lossPercent > 0) {
    tone = "warn";
    verdict = `Connected, but ${ping.lossPercent}% of packets were lost, which causes lag and disconnects.`;
  } else if ((ping.avgMs ?? 0) > 100) {
    tone = "warn";
    verdict = `Connected, but latency is high (${ms(ping.avgMs)} average).`;
  } else if (steps.some((s) => s.tone === "warn")) {
    tone = "warn";
    verdict = "Connected, with something slower than usual. See below.";
  }
  return { tone, verdict, steps };
}

function ConnectivityCheck({ subscription }: Props) {
  const [state, setState] = useState<{ running: boolean; step: string; result: Assessment | null; error: string | null }>({
    running: false,
    step: "",
    result: null,
    error: null,
  });

  async function check() {
    const step = (s: string) => setState((st) => ({ ...st, step: s }));
    setState({ running: true, step: "Tracing route to the internet…", result: null, error: null });
    try {
      const attempt = async <T,>(req: DiagnosticRequest) => {
        try {
          return (await run(subscription, req)) as T;
        } catch (e) {
          // A test that couldn't run (e.g. can't resolve) counts as failed, not as a crash.
          if (/^422\b/.test(String(e))) return null;
          throw e;
        }
      };
      const trace = await attempt<TracerouteResult>({ type: "traceroute", target: "1.1.1.1" });
      step("Pinging 1.1.1.1…");
      const ping = await attempt<PingResult>({ type: "ping", target: "1.1.1.1", count: 5 });
      step("Resolving google.com…");
      const dns = await attempt<DnsResult>({ type: "dns", target: "google.com" });
      setState({ running: false, step: "", result: assess(trace, ping, dns), error: null });
    } catch (e) {
      setState({ running: false, step: "", result: null, error: String(e) });
    }
  }

  const r = state.result;
  return (
    <Card
      title="Connectivity check"
      icon={Stethoscope}
      actions={
        <button className="button primary small" onClick={check} disabled={state.running}>
          <Play size={13} /> {state.running ? "Checking…" : r ? "Run again" : "Run check"}
        </button>
      }
    >
      <p className="muted">
        Checks, from {subscription.name}, whether a problem is in the local network, the internet connection or DNS.
        Takes a few seconds.
      </p>
      {state.running && <p className="hint waiting">{state.step}</p>}
      {state.error && <p className="form-error">{isUnsupported(state.error) ? "Diagnostics need agent 1.3 or later." : state.error}</p>}
      {r && (
        <>
          <div className={`banner ${r.tone === "ok" ? "ok" : r.tone === "warn" ? "warn" : "danger"}`}>
            {r.tone === "ok" ? <CircleCheck size={18} /> : <TriangleAlert size={18} />}
            <b>{r.verdict}</b>
          </div>
          <div className="check-steps">
            {r.steps.map((s) => (
              <div key={s.label} className={`check-step ${s.tone}`}>
                <span className="step-icon">
                  <s.icon size={16} />
                </span>
                <div>
                  <b>{s.label}</b>
                  <span className="muted">{s.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────

let nextId = 1;

export function DiagnosticsPanel({ subscription }: Props) {
  const [type, setType] = useState<TestType>("ping");
  const [target, setTarget] = useState("1.1.1.1");
  const [port, setPort] = useState("30120");
  const [entries, setEntries] = useState<Entry[]>([]);
  const running = entries.some((e) => !e.result && !e.error);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = target.trim();
    if (!t) return;
    const request: DiagnosticRequest =
      type === "tcp" ? { type, target: t, port: Number(port) } : type === "ping" ? { type, target: t, count: 5 } : { type, target: t };
    const id = nextId++;
    setEntries((list) => [{ id, request, result: null, error: null }, ...list].slice(0, 8));
    try {
      const result = await run(subscription, request);
      setEntries((list) => list.map((x) => (x.id === id ? { ...x, result } : x)));
    } catch (err) {
      const message = String(err);
      const error = isUnsupported(message)
        ? "Diagnostics need agent 1.3 or later."
        : message.replace(/^\d{3}\s*/, "");
      setEntries((list) => list.map((x) => (x.id === id ? { ...x, error } : x)));
    }
  }

  return (
    <>
      <ConnectivityCheck subscription={subscription} />

      <Card title="Run a test" icon={Waypoints}>
        <form className="diag-form" onSubmit={submit}>
          <span className="segmented">
            {(Object.keys(TYPE_LABEL) as TestType[]).map((t) => (
              <button type="button" key={t} className={type === t ? "selected" : ""} onClick={() => setType(t)}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </span>
          <div className="diag-inputs">
            <input
              className="mono"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Hostname or IP, e.g. 1.1.1.1"
              aria-label="Target"
            />
            {type === "tcp" && (
              <input
                className="mono port-input"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                placeholder="Port"
                aria-label="Port"
              />
            )}
            <button type="submit" className="button primary" disabled={running}>
              <Play size={14} /> {running ? "Running…" : "Run"}
            </button>
          </div>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button type="button" key={p} className="tag" onClick={() => setTarget(p)}>
                {p}
              </button>
            ))}
          </div>
        </form>
        <p className="hint">Tests run from the host's machine, not from this device.</p>
      </Card>

      {entries.map((entry) => (
        <Card
          key={entry.id}
          className="diag-result"
          title={`${TYPE_LABEL[entry.request.type]} · ${entry.request.target}${entry.request.type === "tcp" ? `:${entry.request.port}` : ""}`}
          actions={
            entry.result ? (
              <span className="muted small-text">
                {new Date(entry.result.startedAt).toLocaleTimeString()} · {(entry.result.durationMs / 1000).toFixed(1)} s
              </span>
            ) : undefined
          }
        >
          {entry.error ? (
            <p className="form-error">{entry.error}</p>
          ) : entry.result ? (
            <ResultView r={entry.result} />
          ) : (
            <p className="hint waiting">Running on {subscription.name}…</p>
          )}
        </Card>
      ))}
    </>
  );
}
