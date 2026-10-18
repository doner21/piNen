import { CustomEditor, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
const windows = createRequire(__filename)('../../window/window.cjs');

export default function (pi: ExtensionAPI) {
 const command = {
  description: 'New separate Pi window: new <name> [instruction] | open "<folder>" [instruction]',
  handler: async (args: string, ctx: ExtensionContext) => {
   try { const result = await windows.openWindow(windows.parseCommand(args)); ctx.ui.notify(`New window topic: ${result.label}`, 'info'); }
   catch { ctx.ui.notify('New window refused or startup/logon not confirmed. Check /window syntax and local window configuration.', 'warning'); }
  }
 };
 pi.on('session_start', async (_, ctx) => {
  if (ctx.mode === 'tui') {
   // Core trims both Editor submission and InteractiveMode input. Snapshot only
   // during this synchronous key dispatch; never retain unrelated editor text.
   ctx.ui.setEditorComponent((tui, theme, keybindings) => new class extends CustomEditor {
    handleInput(data: string) {
     const raw = this.getExpandedText();
     const match = raw.match(/^\s*\/window\s+([\s\S]*)$/);
     if (!match) return super.handleInput(data);
     if (keybindings.matches(data, 'app.message.followUp') && !this.disableSubmit) {
      this.setText(''); this.addToHistory(raw); void command.handler(match[1], ctx); return;
     }
     const submit = this.onSubmit;
     this.onSubmit = () => { this.addToHistory(raw); void command.handler(match[1], ctx); };
     try { super.handleInput(data); }
     finally { this.onSubmit = submit; }
    }
   }(tui, theme, keybindings));
  }
  // Loaded after Telegram by bootstrap. A broken/missing adapter must not
  // leave a known startup failure looking like a successful launch.
  if (!process.env.PI_WINDOW_REQUEST) return;
  const request = JSON.parse(await fs.readFile(process.env.PI_WINDOW_REQUEST, 'utf8'));
  await windows.publishReady(request, { error: 'Telegram adapter did not confirm startup.' });
  delete process.env.PI_WINDOW_REQUEST;
 });
 pi.registerTool({
  name: 'open_window', label: 'Open a new Pi window',
  description: 'Open a brand-new separate Pi TUI in a NEW Windows Terminal window, automatically logged on to its own Telegram topic. Use for requests like “open a new window for X”, “start a new project called Y”, or “open a new window in an existing folder”. new creates a git project; open requires an existing folder under home; auto opens an existing bare name or creates a valid project name. Optional instruction is its first user message, not a shell command. Never continues or stops this session.',
  parameters: Type.Object({
   mode: Type.Union([Type.Literal('new'), Type.Literal('open'), Type.Literal('auto')]),
   target: Type.String({ description: 'Project name or existing folder, without surrounding quotes.' }),
   instruction: Type.Optional(Type.String({ description: 'Optional literal first user instruction.' }))
  }),
  async execute(_id, input) {
   const result = await windows.openWindow(input);
   return { content: [{ type: 'text', text: `New window topic: ${result.label}` }], details: result };
  }
 });
 pi.registerCommand('window', command);
}
