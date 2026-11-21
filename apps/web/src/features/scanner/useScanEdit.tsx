import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../services/api';
import { toast } from '../../stores/toasts';
import { CardDetailDialog } from '../cards/CardDetailDialog';
import type { CollectionItem } from '../../types';
import { NEEDS_REVIEW } from './scanTypes';

/**
 * "Edit" for a scan: identified cards open the copy editor in place;
 * cards awaiting review jump to that scan in Manual Review.
 */
export function useScanEdit() {
  const nav = useNavigate();
  const [item, setItem] = useState<CollectionItem | null>(null);

  const edit = async (scan: { id: string; status: string; collectionItemId: string | null }) => {
    if (NEEDS_REVIEW.includes(scan.status)) {
      nav(`/review?scan=${scan.id}`);
      return;
    }
    if (!scan.collectionItemId) {
      toast('This card can be edited once it has been identified', 'info');
      return;
    }
    try {
      const r = await api.get<{ item: CollectionItem }>(`/api/collection/${scan.collectionItemId}`);
      setItem(r.item);
    } catch {
      toast('Could not load this card', 'error');
    }
  };

  const dialog = <CardDetailDialog cardId={item?.card.id ?? null} item={item} initialTab="copy" onClose={() => setItem(null)} />;
  return { edit, dialog };
}

export const canEdit = (status: string, collectionItemId: string | null) => NEEDS_REVIEW.includes(status) || !!collectionItemId;
