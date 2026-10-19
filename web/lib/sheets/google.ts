import { SignJWT, importPKCS8 } from 'jose';
import type { Cell, SheetInfo, SheetsApi } from './types';

/**
 * Google Sheets API v4 ผ่าน fetch โดยตรง — เข้าสู่ระบบด้วย service account (JWT → access token)
 * ไม่ใช้ googleapis SDK เพื่อให้ไฟล์เล็กและ dependency น้อย
 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

/** อ่าน service account จาก env — รับได้ทั้ง JSON ตรง ๆ และ base64 ของ JSON */
function credentials() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_SERVICE_ACCOUNT_JSON');
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text);
  if (!json.client_email || !json.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON ไม่ใช่ไฟล์ key ของ service account');
  return { email: String(json.client_email), key: String(json.private_key).replace(/\\n/g, '\n') };
}

let token: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.exp - 60 > now) return token.value;
  const { email, key } = credentials();
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importPKCS8(key, 'RS256'));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('ขอสิทธิ์ Google ไม่สำเร็จ: ' + (data.error_description || data.error || res.status));
  token = { value: data.access_token, exp: now + Number(data.expires_in || 3600) };
  return token.value;
}

export function createGoogleSheets(spreadsheetId: string): SheetsApi {
  const base = BASE + encodeURIComponent(spreadsheetId);

  async function call(path: string, init?: { method?: string; body?: unknown; query?: URLSearchParams }) {
    const url = base + path + (init?.query ? '?' + init.query.toString() : '');
    const res = await fetch(url, {
      method: init?.method || 'GET',
      headers: { Authorization: 'Bearer ' + (await accessToken()), 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText;
      if (res.status === 403 || res.status === 404) {
        throw new Error('เปิด Google Sheet ไม่ได้ — ตรวจ SPREADSHEET_ID และแชร์ชีทให้อีเมล service account เป็นผู้แก้ไข (' + msg + ')');
      }
      throw new Error('Google Sheets: ' + msg);
    }
    return data;
  }

  const batch = (requests: unknown[]) => call(':batchUpdate', { method: 'POST', body: { requests } });

  return {
    async listSheets() {
      const data = await call('', { query: new URLSearchParams({ fields: 'sheets.properties(sheetId,title,gridProperties.rowCount)' }) });
      return (data.sheets || []).map((s: { properties: { title: string; sheetId: number; gridProperties?: { rowCount?: number } } }) => ({
        title: s.properties.title, sheetId: s.properties.sheetId, rowCount: s.properties.gridProperties?.rowCount,
      }));
    },

    async getValues(ranges, formatted) {
      if (!ranges.length) return [];
      const q = new URLSearchParams({
        valueRenderOption: formatted ? 'FORMATTED_VALUE' : 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
        majorDimension: 'ROWS',
      });
      ranges.forEach(r => q.append('ranges', r));
      const data = await call('/values:batchGet', { query: q });
      return (data.valueRanges || []).map((vr: { values?: Cell[][] }) => vr.values || []);
    },

    async updateValues(data) {
      if (!data.length) return;
      await call('/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data } });
    },

    async appendRow(sheetTitle, values) {
      const range = "'" + sheetTitle.replace(/'/g, "''") + "'!A1";
      await call('/values/' + encodeURIComponent(range) + ':append', {
        method: 'POST',
        query: new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }),
        body: { values: [values] },
      });
    },

    async copyRowFormat(sheetId, fromRow, toRow, width) {
      await batch([{
        copyPaste: {
          source: { sheetId, startRowIndex: fromRow - 1, endRowIndex: fromRow, startColumnIndex: 0, endColumnIndex: width },
          destination: { sheetId, startRowIndex: toRow - 1, endRowIndex: toRow, startColumnIndex: 0, endColumnIndex: width },
          pasteType: 'PASTE_FORMAT',
        },
      }]);
    },

    async insertRowAfter(sheetId, row) {
      await batch([{ insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 }, inheritFromBefore: true } }]);
    },

    async appendRows(sheetId, count) {
      await batch([{ appendDimension: { sheetId, dimension: 'ROWS', length: count } }]);
    },

    async setNumberFormat(sheetId, row, col, pattern, type) {
      await batch([{
        repeatCell: {
          range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col - 1, endColumnIndex: col },
          cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      }]);
    },

    async addSheet(title) {
      const data = await batch([{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }]);
      const p = data.replies[0].addSheet.properties;
      return { title: p.title, sheetId: p.sheetId };
    },
  };
}
