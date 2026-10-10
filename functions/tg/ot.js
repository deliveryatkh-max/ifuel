// Telegram → OT Apps Script relay (Cloudflare Pages Function, served at /tg/ot).
// Apps Script answers every POST with a redirect, which Telegram counts as a failed delivery and keeps retrying.
// This relay answers Telegram with a plain 200 and passes the update on to the OT script.
// It only ever calls script.google.com, and it forwards Telegram's secret header so the script can reject anything else.
export async function onRequestPost({ request }) {
  const to = new URL(request.url).searchParams.get('to') || '';
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(to) || !secret) return new Response('Forbidden', { status: 403 });
  let update;
  try { update = await request.json(); } catch (e) { return new Response('Bad request', { status: 400 }); }
  try {
    await fetch('https://script.google.com/macros/s/' + to + '/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'telegram', secret, update }),
    });
  } catch (e) { /* Telegram is still told "ok"; the manager can tap the button again */ }
  return new Response('ok');
}

export function onRequestGet() {
  return new Response('OT relay is running', { headers: { 'Content-Type': 'text/plain' } });
}
