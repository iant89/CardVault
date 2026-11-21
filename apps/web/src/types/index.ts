export interface CardDTO {
  id: string;
  game: { slug: string; name: string };
  set: { id: string; name: string; code: string | null; releaseDate: string | null; totalCards: number | null } | null;
  name: string;
  collectorNumber: string;
  rarity: string | null;
  artist: string | null;
  releaseDate: string | null;
  imageUrl: string | null;
  metadata: Record<string, unknown>;
  externalIds: Record<string, string>;
  variants: { id: string; type: string; description: string | null }[];
  price: { market: number | null; soldMedian: number | null; trend30d: number | null; updatedAt: string | null } | null;
  lastResearchedAt: string | null;
}

export interface CollectionItem {
  id: string;
  userId: string;
  ownerName: string;
  card: CardDTO;
  variant: { id: string; type: string } | null;
  condition: string;
  grading: { status?: string; company?: string; grade?: string; certNumber?: string };
  quantity: number;
  purchasePrice: number | null;
  purchaseDate: string | null;
  source: string | null;
  notes: string | null;
  favorite: boolean;
  scanThumbnail: string | null;
  unitValue: number | null;
  totalValue: number | null;
  trend30d: number | null;
  createdAt: string;
}

export interface JobDTO {
  id: string;
  queue: string;
  status: string;
  stage: string | null;
  label: string | null;
  progress: number;
  attempts: number;
  priority: number;
  error: string | null;
  scanId: string | null;
  cardId: string | null;
  ownerName: string | null;
  thumbnail: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  role: 'ADMIN' | 'USER';
  active?: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export interface MarketSummary {
  marketPrice: number | null;
  listed: { count: number; median: number | null; average: number | null; min: number | null; max: number | null };
  sold: { count: number; median: number | null; average: number | null; min: number | null; max: number | null };
  avg30d: number | null;
  avg90d: number | null;
  avg1y: number | null;
  recentSoldAverage: number | null;
  recentSoldMedian: number | null;
  trend30d: number | null;
  volatility: number | null;
}
