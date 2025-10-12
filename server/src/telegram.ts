import fs from 'fs';
import path from 'path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { API_ID, API_HASH } from './config';

// Session path identical to original
const stringSessionPath = path.join(__dirname, '../../session.txt');
let stringSession = '';
if (fs.existsSync(stringSessionPath)) {
  stringSession = fs.readFileSync(stringSessionPath, 'utf8').trim();
}

export const client = new TelegramClient(
  new StringSession(stringSession),
  Number(API_ID),
  API_HASH || '',
  { connectionRetries: 3 }
);

let clientReady = false;
export async function ensureClient() {
  if (!clientReady) {
    await client.connect();
    clientReady = true;
  }
}

export function isClientReady() {
  return clientReady;
}

export function setClientReady(val: boolean) {
  clientReady = val;
}

export function hasSavedSession() {
  return !!stringSession;
}

export function saveCurrentSession() {
  const saved = (client.session as any).save();
  if (saved) {
    const str = saved as string;
    fs.writeFileSync(stringSessionPath, str, { mode: 0o600 });
    stringSession = str;
  }
}

export { Api };
