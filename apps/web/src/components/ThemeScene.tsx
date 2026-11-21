import type { CSSProperties, ReactNode } from 'react';
import { themeFor } from '../themes';

export function ThemeScene({ game, children }: { game?: string | null; children: ReactNode }) {
  const t = themeFor(game);
  const style = {
    '--scene-bg': t.backgroundImage ? `${t.background}, url(${t.backgroundImage})` : t.background,
    '--scene-surface': t.surface,
    '--scene-light': t.light,
  } as CSSProperties;
  return (
    <div className="scene" style={style} data-theme={t.id}>
      <div className="scene-bg" />
      <div className="scene-surface" />
      <div className="scene-light" />
      <div className="scene-content">{children}</div>
    </div>
  );
}
