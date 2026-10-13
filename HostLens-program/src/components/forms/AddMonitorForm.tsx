import { FormEvent, useState } from "react";
import { Gamepad2, Globe, Network, type LucideIcon } from "lucide-react";
import { Modal } from "../ui/Modal";
import { parseFiveMAddress } from "../../fivem";
import { resolveJoinCode, validateTarget } from "../../useChecks";
import type { CheckKind, ServiceCheck } from "../../types";

interface Props {
  onAdd: (check: Omit<ServiceCheck, "id" | "createdAt">) => void;
  onClose: () => void;
}

const KINDS: { kind: CheckKind; label: string; description: string; icon: LucideIcon; placeholder: string }[] = [
  {
    kind: "fivem",
    label: "FiveM server",
    description: "Players, status and outages",
    icon: Gamepad2,
    placeholder: "cfx.re/join/abc123 or 1.2.3.4:30120",
  },
  {
    kind: "http",
    label: "Website / API",
    description: "HTTP(S) responds below 400",
    icon: Globe,
    placeholder: "https://example.com/health",
  },
  {
    kind: "tcp",
    label: "TCP port",
    description: "Port accepts connections",
    icon: Network,
    placeholder: "db.example.com:5432",
  },
];

const INTERVALS = [10, 30, 60, 300];

export function AddMonitorForm({ onAdd, onClose }: Props) {
  const [kind, setKind] = useState<CheckKind>("fivem");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = KINDS.find((k) => k.kind === kind)!;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = target.trim();
    const problem = validateTarget(kind, value);
    if (problem) return setError(problem);

    if (kind !== "fivem") {
      onAdd({ name: name.trim() || value, kind, target: value, intervalSeconds });
      return;
    }
    const address = parseFiveMAddress(value);
    if ("error" in address) return setError(address.error);
    if (address.kind === "url") {
      onAdd({ name: name.trim() || value, kind, target: address.baseUrl, intervalSeconds });
      return;
    }
    // Join codes are looked up in the Cfx.re server list to find the real address.
    setBusy(true);
    try {
      const found = await resolveJoinCode(address.code);
      onAdd({
        name: name.trim() || found.projectName || found.hostname || `cfx.re/join/${address.code}`,
        kind,
        target: found.baseUrl,
        joinCode: address.code,
        intervalSeconds,
      });
    } catch (err) {
      setError(`Couldn't look up that join code: ${String(err)}`);
      setBusy(false);
    }
  }

  return (
    <Modal title="Add monitor" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="kind-picker" role="radiogroup" aria-label="Monitor type">
          {KINDS.map(({ kind: k, label, description, icon: Icon }) => (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={kind === k}
              className={`kind-option ${k} ${kind === k ? "selected" : ""}`}
              onClick={() => {
                setKind(k);
                setError(null);
              }}
            >
              <span className="kind-icon">
                <Icon size={18} />
              </span>
              <span className="kind-text">
                <b>{label}</b>
                <small>{description}</small>
              </span>
            </button>
          ))}
        </div>

        <label className="field">
          <span>{kind === "fivem" ? "Server address or join link" : kind === "http" ? "URL" : "Host and port"}</span>
          <input
            className="mono"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setError(null);
            }}
            placeholder={meta.placeholder}
            autoFocus
            required
          />
          {kind === "fivem" && (
            <small className="hint">
              Use the server's IP (port 30120 is assumed) or its <code>cfx.re/join</code> code. The server must
              allow its <code>/dynamic.json</code> endpoint, which FXServer does by default.
            </small>
          )}
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "fivem" ? "Optional: taken from the server" : "e.g. Main website"}
          />
        </label>
        <div className="field">
          <span>Check every</span>
          <div className="segmented">
            {INTERVALS.map((s) => (
              <button
                type="button"
                key={s}
                className={intervalSeconds === s ? "selected" : ""}
                onClick={() => setIntervalSeconds(s)}
              >
                {s < 60 ? `${s}s` : `${s / 60} min`}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Looking up server…" : "Add monitor"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
