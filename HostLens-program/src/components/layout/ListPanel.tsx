import type { ReactNode } from "react";
import { Plus, Search } from "lucide-react";

interface Props {
  title: string;
  count: number;
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  onAdd: () => void;
  addLabel: string;
  children: ReactNode;
}

// Secondary column next to the rail: section title, search and the item list.
export function ListPanel({ title, count, query, onQuery, placeholder, onAdd, addLabel, children }: Props) {
  return (
    <aside className="list-panel">
      <div className="list-panel-header">
        <span className="label">
          {title} <span className="count">{count}</span>
        </span>
      </div>
      <div className="list-panel-tools">
        <label className="search">
          <Search size={15} />
          <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} />
        </label>
        <button className="add-button" onClick={onAdd} title={addLabel} aria-label={addLabel}>
          <Plus size={18} />
        </button>
      </div>
      <div className="list-items">{children}</div>
    </aside>
  );
}
