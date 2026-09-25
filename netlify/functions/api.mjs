// Online entry point: every /api/* request and /join/<code> link on Netlify.
import pg from 'pg';
import { createPostgresStore } from '../../lib/store-postgres.js';
import { handleApi, HttpError } from '../../lib/api.js';

// KTV_DATABASE_URL is a Postgres connection string (Neon, pooled) set in the Netlify
// environment. Each function instance only needs a couple of connections.
const pool = new pg.Pool({ connectionString: process.env.KTV_DATABASE_URL, max: Number(process.env.KTV_DB_POOL_MAX) || 3 });
const store = createPostgresStore({ pool });

export default async request => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/join/')) {
    const token = await store.joinToken(decodeURIComponent(url.pathname.slice('/join/'.length)));
    if (!token) {
      return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>KTV</title><p style="font:16px sans-serif;padding:24px">找不到這個房間，請重新掃描主持人畫面上的 QR code。</p>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response(null, { status: 302, headers: { Location: `/?token=${encodeURIComponent(token)}`, 'Cache-Control': 'no-store' } });
  }
  const result = await handleApi({
    method: request.method,
    // On a 403/404, Netlify retries the request as "<path>.html", "<path>.htm" and
    // "<path>/index.html" looking for a static page; answer those retries the same way so
    // the original error survives.
    path: url.pathname.replace(/(\/index)?\.html?$/, ''),
    params: url.searchParams,
    token: request.headers.get('authorization')?.replace(/^Bearer /, '') || '',
    json: async (limit = 16_384) => {
      const raw = await request.text();
      if (raw.length > limit) throw new HttpError(413, '資料過大');
      try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'JSON 格式錯誤'); }
    }
  }, store, {
    clientUrl: room => `${url.origin}/join/${room.code}`,
    roomPassword: process.env.KTV_ROOM_PASSWORD
  });
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: ['/api/*', '/join/*'] };
