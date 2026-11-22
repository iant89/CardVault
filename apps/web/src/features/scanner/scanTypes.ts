import type { CardDTO } from '../../types';

export interface ScanListItem {
  id: string;
  status: string;
  confidence: number | null;
  thumbnail: string | null;
  createdAt: string;
  cardId: string | null;
  cardName: string | null;
  cardImage: string | null;
  collectionItemId: string | null;
}

export interface ScanDetail {
  scan: { id: string; status: string; confidence: number | null; variantId: string | null; collectionItemId: string | null; createdAt: string; image: string; thumbnail: string | null };
  card: CardDTO | null;
  identifications: { cardId: string | null; confidence: number; rank: number; name: string | null; collectorNumber: string | null; setName: string | null; ocrTop: string | null }[];
  jobs: { status: string; stage: string | null; progress: number; error: string | null }[];
  /** copies of this card the scan's owner has (they all share the card's pricing) */
  owned: { copies: number; sameVariant: number } | null;
}

export const STATUS_LABEL: Record<string, string> = {
  UPLOADED: 'Queued',
  IDENTIFYING: 'Identifying…',
  IDENTIFIED: 'Identified',
  NEEDS_VERIFICATION: 'Needs verification',
  MANUAL_REVIEW: 'Needs review',
  RESEARCHING: 'Researching prices…',
  COMPLETED: 'Done',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
};

export const IDENTIFIED = ['IDENTIFIED', 'RESEARCHING', 'COMPLETED'];
export const NEEDS_REVIEW = ['NEEDS_VERIFICATION', 'MANUAL_REVIEW'];
export const IN_PROGRESS = ['UPLOADED', 'IDENTIFYING'];

/** Short capture beep (Web Audio, no asset needed). */
let ac: AudioContext | null = null;
export function beep(): void {
  try {
    ac ??= new AudioContext();
    void ac.resume();
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1320, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.13);
  } catch {
    /* audio unavailable — silent */
  }
}
