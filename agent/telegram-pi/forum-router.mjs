#!/usr/bin/env node
// No Pi child, no session killing, no token files. Reuses the boot daemon entry point in topics mode.
import core from '../extensions/telegram-pi/multi-session.cjs';
import windows from '../window/window.cjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared by production startup and isolated transport regressions. Only terminal
// presentation is injectable; authorization and request transport remain real.
export function windowLauncher(dir, config, presentation) {
 return async text => windows.telegramNew(text, { ...config || await windows.loadConfig(), telegramRuntime: dir }, presentation);
}
export async function main() {
 const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
 if (!token) throw Error('Set TELEGRAM_BOT_TOKEN in the router environment (never a CLI argument or token file).');
 const baseDir = dirname(fileURLToPath(import.meta.url));
 const selected = core.selectRuntime(baseDir);
 const config = selected.config?.mode === 'topics' ? selected.config : null;
 // An approved deployment pins group and allowlist; inherited legacy IDs cannot override it.
 const chatId = config ? config.chatId : Number(process.env.TELEGRAM_CHAT_ID);
 const allowlist = config ? config.allowlist
  : (process.env.TELEGRAM_ALLOWED_FROM || '').split(',').filter(s => s.trim()).map(s => /^\d+$/.test(s.trim()) ? Number(s) : NaN);
 const dir = selected.dir;
 const router = new core.Router({ dir, api: new core.BotApi(token), chatId, allowlist,
  launchWindow: windowLauncher(dir) });
 let fence;
 const service = await core.serve({ router, token, expectedUsername: config?.botUsername,
  beforePoll: config ? async (router, abort) => {
   fence = await core.legacyFence({ dir: baseDir, onConflict: e => { router.lastError = router.safe(e.message); abort.abort(); } });
   // Preserve the drained legacy offset; never replay already-handled private-chat updates.
   if (!router.state.legacyOffsetSeeded) {
    const offset = fence.previous?.offset;
    if (Number.isSafeInteger(offset) && offset >= 0 && offset > router.state.offset) router.state.offset = offset;
    router.state.legacyOffsetSeeded = true; await router.save();
   }
  } : undefined,
  beforeRelease: async () => { await fence?.close(); }
 });
 if (config) {
  const health = setInterval(() => { if (!router.polling) { clearInterval(health); void service.close().catch(() => {}); } }, 1000);
  health.unref(); void service.closed.then(() => clearInterval(health), () => clearInterval(health));
 }
 console.log('Telegram topic router ready. Token not displayed. Sessions may /telegram logon.');
 let stopping = false;
 const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
 process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
 void service.closed.then(() => console.log('Telegram topic router stopped; no Pi sessions stopped.'), () => { console.error('Router shutdown could not be confirmed.'); process.exitCode = 1; });
 return service;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 main().catch(e => { console.error(core.redact(e.message, process.env.TELEGRAM_BOT_TOKEN)); process.exitCode = 1; });
}
