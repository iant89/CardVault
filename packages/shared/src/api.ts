import type { Role } from './enums.js';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  role: Role;
}

export interface LoginTile {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_COOKIE = 'cv_csrf';
export const SESSION_COOKIE = 'cv_session';
