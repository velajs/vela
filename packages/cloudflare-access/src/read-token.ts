import type { IssuerPreset } from './types';

/** Peel off a leading, case-insensitive `Bearer ` scheme if the value carries one. */
const stripBearer = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 7 && trimmed.slice(0, 7).toLowerCase() === 'bearer ') {
    return trimmed.slice(7).trim();
  }
  return trimmed;
};

/** Look up a single cookie by name inside a raw `Cookie` header, scanning linearly. */
const readCookie = (cookieHeader: string, name: string): string | undefined => {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
};

/**
 * Extract the raw token from an inbound request. The preset's header wins — and
 * `Headers.get` already matches header names case-insensitively — with the
 * `Bearer ` scheme stripped when the preset asks for it. If the header yields
 * nothing and the preset names a cookie, that cookie is consulted next.
 * Everything failing, the result is `undefined`.
 */
export const readToken = (request: Request, preset: IssuerPreset): string | undefined => {
  const headerValue = request.headers.get(preset.header);
  if (headerValue !== null) {
    const token = preset.bearer ? stripBearer(headerValue) : headerValue.trim();
    if (token.length > 0) return token;
  }

  if (preset.cookie !== undefined) {
    const cookieHeader = request.headers.get('cookie');
    if (cookieHeader !== null) return readCookie(cookieHeader, preset.cookie);
  }

  return undefined;
};
