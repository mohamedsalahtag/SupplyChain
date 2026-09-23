/** App-wide look: font size, site name and icon. Applies to every user. */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/schema.js';
import { readSetting, writeSetting } from './store.js';

/** Real on-screen pixel sizes. */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 16;
export const FONT_SIZE_DEFAULT = 13;

export const appearanceSchema = z.object({
  fontSize: z.number().int().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
});
export type Appearance = z.infer<typeof appearanceSchema>;

const ICON_MAX_BYTES = 256 * 1024;
const ICON_DATA_URL = /^data:image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/]+=*)$/;

export const brandingSchema = z.object({
  siteName: z.string().trim().min(1, 'Enter a site name').max(60),
  /** null = the built-in icon. */
  iconDataUrl: z
    .string()
    .regex(ICON_DATA_URL, 'The icon must be a PNG, JPG, SVG, WEBP or ICO image')
    .refine((s) => Buffer.byteLength(s.split(',')[1] ?? '', 'base64') <= ICON_MAX_BYTES, 'The icon must be 256 KB or smaller')
    .nullable(),
});
export type Branding = z.infer<typeof brandingSchema>;

const DEFAULT_BRANDING: Branding = { siteName: 'Supply Chain', iconDataUrl: null };

export async function loadUi(db: Kysely<Database>): Promise<Appearance & Branding> {
  const [appearance, branding] = await Promise.all([readSetting(db, 'ui.appearance'), readSetting(db, 'ui.branding')]);
  const a = appearanceSchema.safeParse(appearance);
  const b = brandingSchema.safeParse(branding);
  return {
    fontSize: a.success ? a.data.fontSize : FONT_SIZE_DEFAULT,
    ...(b.success ? b.data : DEFAULT_BRANDING),
  };
}

export const saveAppearance = (db: Kysely<Database>, input: Appearance) =>
  writeSetting(db, 'ui.appearance', appearanceSchema.parse(input));

export const saveBranding = (db: Kysely<Database>, input: Branding) =>
  writeSetting(db, 'ui.branding', brandingSchema.parse(input));
