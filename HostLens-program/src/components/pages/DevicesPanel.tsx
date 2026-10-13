import { useState } from "react";
import { Laptop, QrCode, Smartphone, Trash2 } from "lucide-react";
import type { DeviceInfo } from "../../../../agent/types";
import { agentRequest, isUnsupported } from "../../agentApi";
import { formatAgo } from "../../format";
import { useAgentPoll } from "../../useAgents";
import type { Subscription } from "../../types";
import { Card, EmptyState } from "../ui/common";

interface Props {
  subscription: Subscription;
  onPair: () => void;
}

const isPhone = (name: string) => /android|ios|iphone|phone|pixel|galaxy/i.test(name);

// Devices paired with this agent, each with its own revocable token.
export function DevicesPanel({ subscription, onPair }: Props) {
  const { data, error, refresh } = useAgentPoll<DeviceInfo[]>(subscription, "/api/v1/devices", 10_000);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function revoke(id: string) {
    setActionError(null);
    try {
      await agentRequest(subscription.url, "DELETE", `/api/v1/devices/${id}`, subscription.token ?? null);
      setConfirming(null);
      refresh();
    } catch (e) {
      setActionError(String(e));
    }
  }

  return (
    <Card
      title="Paired devices"
      icon={Smartphone}
      actions={
        <button className="button ghost small" onClick={onPair}>
          <QrCode size={14} /> Pair device
        </button>
      }
    >
      <p className="muted">
        Each device has its own token. Removing one locks only that device out. The master token (in the agent's
        config folder) always works.
      </p>
      {isUnsupported(error) ? (
        <p className="muted">This agent is too old for pairing. Update it to 1.2 or later.</p>
      ) : error ? (
        <p className="form-error">{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : data.length === 0 ? (
        <EmptyState icon={Smartphone} title="No paired devices">
          {subscription.token ? "This app is connected with the master token." : null}
        </EmptyState>
      ) : (
        <ul className="device-list">
          {data.map((d) => {
            const Icon = isPhone(d.name) ? Smartphone : Laptop;
            return (
              <li key={d.id}>
                <span className="kind-badge">
                  <Icon size={16} />
                </span>
                <div className="device-text">
                  <b>
                    {d.name} {d.current && <span className="tag accent">this device</span>}
                  </b>
                  <span className="muted">
                    Paired {new Date(d.createdAt).toLocaleDateString()} · last seen{" "}
                    {d.lastSeenAt ? formatAgo(Date.parse(d.lastSeenAt)) : "never"}
                  </span>
                </div>
                {confirming === d.id ? (
                  <span className="confirm">
                    <span className="muted small-text">{d.current ? "This app will lose access." : "Remove?"}</span>
                    <button className="button ghost small" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                    <button className="button danger small" onClick={() => revoke(d.id)}>
                      Remove
                    </button>
                  </span>
                ) : (
                  <button className="icon-button danger" onClick={() => setConfirming(d.id)} title="Remove device" aria-label={`Remove ${d.name}`}>
                    <Trash2 size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {actionError && <p className="form-error">{actionError}</p>}
    </Card>
  );
}
