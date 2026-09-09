import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.HF_WORKSPACE || '/workspace/projects');
const MAX_OUTPUT = 4 * 1024 * 1024;
const COMMAND_TIMEOUT = Number(process.env.HF_COMMAND_TIMEOUT_MS || 15 * 60 * 1000);
const HYPERFRAMES_BIN = process.env.HYPERFRAMES_BIN || '/usr/local/bin/hyperframes';
const DEFAULT_BROWSER = '/usr/local/bin/hyperframes-chromium';

await fs.mkdir(ROOT, { recursive: true });

function projectPath(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) throw new Error('Invalid project name. Use letters, numbers, dot, dash, or underscore only.');
  const resolved = path.resolve(ROOT, name);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw new Error('Project path escapes workspace.');
  return resolved;
}
function relativeSafe(projectDir, filePath) {
  const resolved = path.resolve(projectDir, filePath);
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) throw new Error('File path escapes the project directory.');
  return resolved;
}
async function runHyperframes(args, cwd = ROOT) {
  const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.HYPERFRAMES_BROWSER_PATH || DEFAULT_BROWSER;
  const { stdout, stderr } = await execFileAsync(HYPERFRAMES_BIN, args, {
    cwd,
    env: {
      ...process.env,
      CI: '1',
      PUPPETEER_EXECUTABLE_PATH: browserPath,
      HYPERFRAMES_BROWSER_PATH: browserPath,
    },
    timeout: COMMAND_TIMEOUT,
    maxBuffer: MAX_OUTPUT,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
function textResult(text) { return { content: [{ type: 'text', text: String(text) }] }; }
function jsonResult(value) { return textResult(JSON.stringify(value, null, 2)); }
function errorText(error) { const message = error?.stderr || error?.stdout || error?.message || String(error); return message.length > MAX_OUTPUT ? message.slice(0, MAX_OUTPUT) + '\n[output truncated]' : message; }

function registerTools(server) {
  server.registerTool('hyperframes_doctor', { title: 'HyperFrames Doctor', description: 'Check the HyperFrames, Node, FFmpeg and Chromium environment.', inputSchema: z.object({}) }, async () => { try { return textResult((await runHyperframes(['doctor'])).stdout); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_init', { title: 'Create HyperFrames Project', description: 'Create a new HyperFrames project.', inputSchema: z.object({ name: z.string().min(1).max(80), example: z.string().optional(), resolution: z.string().optional(), fps: z.number().int().positive().max(120).optional() }) }, async ({ name, example, resolution, fps }) => { try { const args = ['init', name, '--non-interactive']; if (example) args.push('--example', example); if (resolution) args.push('--resolution', resolution); if (fps) args.push('--fps', String(fps)); const r = await runHyperframes(args); return textResult(r.stdout || r.stderr || `Created ${name}`); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_info', { title: 'Project Info', description: 'Inspect a HyperFrames project.', inputSchema: z.object({ project: z.string().min(1) }) }, async ({ project }) => { try { const r = await runHyperframes(['info', '--json'], projectPath(project)); try { return jsonResult(JSON.parse(r.stdout)); } catch { return textResult(r.stdout || r.stderr); } } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_lint', { title: 'Lint Project', description: 'Run HyperFrames linting.', inputSchema: z.object({ project: z.string().min(1), json: z.boolean().optional() }) }, async ({ project, json }) => { try { const args = ['lint']; if (json) args.push('--json'); const r = await runHyperframes(args, projectPath(project)); return textResult(r.stdout || r.stderr || 'Lint passed.'); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_validate', { title: 'Validate Project', description: 'Run HyperFrames validation.', inputSchema: z.object({ project: z.string().min(1) }) }, async ({ project }) => { try { return textResult((await runHyperframes(['validate'], projectPath(project))).stdout); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_compositions', { title: 'List Compositions', description: 'List composition IDs and durations.', inputSchema: z.object({ project: z.string().min(1) }) }, async ({ project }) => { try { return textResult((await runHyperframes(['compositions'], projectPath(project))).stdout); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_render', { title: 'Render Video', description: 'Render a HyperFrames project.', inputSchema: z.object({ project: z.string().min(1), quality: z.enum(['draft', 'standard', 'high']).optional(), output: z.string().optional(), fps: z.number().int().positive().max(120).optional(), format: z.enum(['mp4', 'mov', 'webm']).optional(), workers: z.number().int().positive().max(32).optional(), crf: z.number().int().min(0).max(51).optional(), videoBitrate: z.string().optional(), gpu: z.boolean().optional(), docker: z.boolean().optional() }) }, async ({ project, quality, output, fps, format, workers, crf, videoBitrate, gpu, docker }) => { try { const cwd = projectPath(project), args = ['render']; if (quality) args.push('--quality', quality); if (output) { relativeSafe(cwd, output); args.push('--output', output); } if (fps) args.push('--fps', String(fps)); if (format) args.push('--format', format); if (workers) args.push('--workers', String(workers)); if (crf !== undefined) args.push('--crf', String(crf)); if (videoBitrate) args.push('--video-bitrate', videoBitrate); if (gpu) args.push('--gpu'); if (docker) args.push('--docker'); const r = await runHyperframes(args, cwd); return textResult(r.stdout || r.stderr || 'Render completed.'); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_transcribe', { title: 'Transcribe Media', description: 'Run HyperFrames media transcription.', inputSchema: z.object({ project: z.string().min(1), input: z.string().min(1), model: z.string().optional(), json: z.boolean().optional() }) }, async ({ project, input, model, json }) => { try { const cwd = projectPath(project); relativeSafe(cwd, input); const args = ['transcribe', input]; if (model) args.push('--model', model); if (json) args.push('--json'); const r = await runHyperframes(args, cwd); return textResult(r.stdout || r.stderr); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_tts', { title: 'Generate Voiceover', description: 'Generate TTS audio through HyperFrames.', inputSchema: z.object({ project: z.string().min(1), text: z.string().min(1).max(20000), voice: z.string().optional(), output: z.string().min(1) }) }, async ({ project, text, voice, output }) => { try { const cwd = projectPath(project); relativeSafe(cwd, output); const args = ['tts', text, '--output', output]; if (voice) args.push('--voice', voice); const r = await runHyperframes(args, cwd); return textResult(r.stdout || r.stderr); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_catalog', { title: 'Browse HyperFrames Catalog', description: 'Browse catalog blocks or components.', inputSchema: z.object({ project: z.string().min(1), type: z.enum(['block', 'component']).optional() }) }, async ({ project, type }) => { try { const args = ['catalog']; if (type) args.push('--type', type); return textResult((await runHyperframes(args, projectPath(project))).stdout); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_add', { title: 'Install Catalog Item', description: 'Install a HyperFrames catalog item.', inputSchema: z.object({ project: z.string().min(1), name: z.string().min(1).max(200) }) }, async ({ project, name }) => { try { return textResult((await runHyperframes(['add', name], projectPath(project))).stdout); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_docs', { title: 'HyperFrames Docs', description: 'Return HyperFrames CLI documentation.', inputSchema: z.object({ topic: z.string().min(1).max(100) }) }, async ({ topic }) => { try { return textResult((await runHyperframes(['docs', topic])).stdout); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('project_list_files', { title: 'List Project Files', description: 'List files in a HyperFrames project.', inputSchema: z.object({ project: z.string().min(1), subdir: z.string().optional() }) }, async ({ project, subdir }) => { try { const cwd = projectPath(project), start = subdir ? relativeSafe(cwd, subdir) : cwd, entries = []; async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (['node_modules', '.git', 'renders'].includes(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else entries.push(path.relative(cwd, full)); } } await walk(start); return jsonResult(entries.sort()); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('project_read_file', { title: 'Read Project File', description: 'Read a UTF-8 text file.', inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1) }) }, async ({ project, file }) => { try { const cwd = projectPath(project); return textResult(await fs.readFile(relativeSafe(cwd, file), 'utf8')); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('project_write_file', { title: 'Write Project File', description: 'Create or replace a UTF-8 text file.', inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1), content: z.string().max(2_000_000) }) }, async ({ project, file, content }) => { try { const cwd = projectPath(project), target = relativeSafe(cwd, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return textResult(`Wrote ${path.relative(cwd, target)} (${content.length} characters).`); } catch (e) { return textResult(errorText(e)); } });
  server.registerTool('hyperframes_cli', { title: 'HyperFrames CLI', description: 'Advanced HyperFrames CLI escape hatch; no arbitrary shell commands.', inputSchema: z.object({ command: z.enum(['doctor', 'init', 'info', 'lint', 'validate', 'preview', 'render', 'compositions', 'catalog', 'add', 'transcribe', 'tts', 'upgrade', 'docs']), project: z.string().optional(), args: z.array(z.string()).max(30).optional() }) }, async ({ command, project, args = [] }) => { try { const cwd = project ? projectPath(project) : ROOT; const r = await runHyperframes([command, ...args], cwd); return textResult(r.stdout || r.stderr || 'Command completed.'); } catch (e) { return textResult(errorText(e)); } });
}

function buildServer() {
  const server = new McpServer({ name: 'hyperframes-mcp-server', version: '1.1.0' }, { capabilities: { tools: {} }, instructions: 'Use HyperFrames tools to create, edit, validate and render HTML-native video projects.' });
  registerTools(server); return server;
}
const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);
const httpServer = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'hyperframes-mcp-server' })); return; }
  if (req.url === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('HyperFrames MCP server is running. MCP endpoint: /mcp'); return; }
  nodeHandler(req, res);
});
httpServer.listen(PORT, HOST, () => { console.log(`HyperFrames MCP server listening on http://${HOST}:${PORT}/mcp`); console.log(`HyperFrames binary: ${HYPERFRAMES_BIN}`); });
