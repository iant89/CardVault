import { gameModule } from '@cardvault/card-model';

type Atk = { name: string; cost?: string[]; damage?: string; text?: string };

function render(value: unknown, format?: string) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  if (format === 'boolean') return value ? 'Yes' : 'No';
  if (format === 'attacks' && Array.isArray(value))
    return (
      <div>
        {(value as Atk[]).map((a, i) => (
          <div className="attack" key={i}>
            <div className="row between">
              <strong>
                {a.cost?.length ? <span className="faint">[{a.cost.join(' ')}] </span> : null}
                {a.name}
              </strong>
              {a.damage && <strong>{a.damage}</strong>}
            </div>
            {a.text && <div className="muted" style={{ fontSize: 13 }}>{a.text}</div>}
          </div>
        ))}
      </div>
    );
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === 'object' && v ? [(v as { type?: string }).type, (v as { value?: string }).value].filter(Boolean).join(' ') : String(v)))
      .join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Dynamic, game-specific attribute panel driven by the card-model module. */
export function GameFields({ game, metadata }: { game: string; metadata: Record<string, unknown> }) {
  const mod = gameModule(game);
  const fields = mod.displayFields
    .map((f) => ({ ...f, node: render(metadata[f.key], f.format) }))
    .filter((f) => f.node != null);
  if (!fields.length) return null;
  return (
    <dl className="kv" style={{ margin: 0 }}>
      {fields.map((f) => (
        <div key={f.key} className={f.format === 'attacks' || f.format === 'longtext' ? 'wide' : ''}>
          <dt>{f.label}</dt>
          <dd style={f.format === 'longtext' ? { whiteSpace: 'pre-wrap', fontWeight: 400 } : undefined}>{f.node}</dd>
        </div>
      ))}
    </dl>
  );
}
