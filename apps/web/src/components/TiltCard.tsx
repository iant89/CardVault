import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

const MAX_TILT = 9; // degrees — tactile, not a casino
const HOLO = new Set(['HOLO', 'REVERSE_HOLO', 'FOIL', 'ETCHED_FOIL', 'SECRET_RARE', 'FULL_ART', 'ALT_ART', 'PARALLEL']);

interface Props {
  image: string | null;
  name: string;
  subtitle?: string;
  variant?: string | null;
  quantity?: number;
  flash?: boolean;
  onOpen?: () => void;
  size?: 'grid' | 'large';
  /** game slug — only used to tint the image placeholder */
  game?: string;
}

const PH: Record<string, [string, string]> = {
  pokemon: ['#ffcb05', 'Pokémon'],
  magic: ['#b088ff', 'Magic'],
  yugioh: ['#7fd7ff', 'Yu-Gi-Oh!'],
  football: ['#7ee787', 'Football'],
  baseball: ['#ff8a65', 'Baseball'],
  basketball: ['#ff9f43', 'Basketball'],
  hockey: ['#4aa3ff', 'Hockey'],
};

/**
 * A card that physically sits on the table: follows the pointer with a
 * subtle rotateX/rotateY, lifts on hover (scale 1.08, translateZ 20px) and
 * springs back on leave. Knows nothing about scene themes.
 */
export function TiltCard({ image, name, subtitle, variant, quantity, flash, onOpen, size = 'grid', game }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [broken, setBroken] = useState(false);
  const raf = useRef(0);

  const move = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      el.style.setProperty('--ry', `${(x - 0.5) * 2 * MAX_TILT}deg`);
      el.style.setProperty('--rx', `${(0.5 - y) * 2 * MAX_TILT}deg`);
      el.style.setProperty('--mx', `${x * 100}%`);
      el.style.setProperty('--my', `${y * 100}%`);
    });
  };
  const enter = () => {
    setHover(true);
    ref.current?.style.setProperty('--s', size === 'large' ? '1.02' : '1.08');
    ref.current?.style.setProperty('--tz', '20px');
  };
  const leave = () => {
    setHover(false);
    cancelAnimationFrame(raf.current);
    const el = ref.current;
    if (!el) return;
    for (const [k, v] of [['--rx', '0deg'], ['--ry', '0deg'], ['--s', '1'], ['--tz', '0px']]) el.style.setProperty(k!, v!);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen?.();
    }
  };

  return (
    <div
      className={`tcard ${hover ? 'hovering' : ''} ${variant && HOLO.has(variant) ? 'holo' : ''}`}
      ref={ref}
      tabIndex={onOpen ? 0 : -1}
      role={onOpen ? 'button' : undefined}
      aria-label={onOpen ? `Open ${name}` : name}
      onPointerMove={move}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onClick={onOpen}
      onKeyDown={key}
      style={{} as CSSProperties}
    >
      <div className={`tcard-inner ${flash ? 'tcard-flash' : ''}`}>
        {image && !broken ? (
          <img className="tcard-img" src={image} alt={name} loading="lazy" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <div className="tcard-placeholder" style={{ ['--ph' as string]: PH[game ?? '']?.[0] }}>
            {game && PH[game] && <div className="ph-game">{PH[game][1]}</div>}
            <div>
              <div className="ph-name">{name}</div>
              {subtitle && <div style={{ marginTop: 6 }}>{subtitle}</div>}
            </div>
          </div>
        )}
        <div className="tcard-shine" />
        <div className="tcard-edge" />
        {quantity && quantity > 1 ? <div className="tcard-qty">×{quantity}</div> : null}
      </div>
    </div>
  );
}
