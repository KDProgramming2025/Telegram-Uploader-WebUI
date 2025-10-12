import dotenv from 'dotenv';
import path from 'path';

// Load .env exactly as original
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const PORT = process.env.PORT || 11000;
export const API_ID = process.env.API_ID as string | undefined;
export const API_HASH = process.env.API_HASH as string | undefined;
export const TARGET_CHATID = process.env.TARGET_CHATID as string | undefined;
export const UI_USERNAME = process.env.UI_USERNAME as string | undefined;
export const UI_PASSWORD = process.env.UI_PASSWORD as string | undefined;
// PUBLIC_BASE_URL removed: clients should use relative URLs resolved by the browser's origin.
