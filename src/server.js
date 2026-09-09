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

await fs.mkdir(ROOT, { recursive: true });

function projectPath(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) {
    throw new Error('Invalid project name. Use letters, numbers, dot, dash, or underscore only.');
  }
  const resolved = path.resolve(ROOT, name);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error('Project path escapes workspace.');
  }
  return resolved;
}

function relativeSafe(projectDir, filePath) {
  const resolved = path.resolve(projectDir, filePath);
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
    throw new Error('File path escapes the project directory.');
  }
  return resolved;
}

async function runHyperframes(args, cwd = ROOT) {
  const { stdout, stderr } = await execFileAsync(
    'npx',
    ['--no-install', 'hyperframes', ...args],
    {
      cwd,
      env: {
        ...process.env,
        CI: '1',
        PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
      },
      timeout: COMMAND_TIMEOUT,
      maxBuffer: MAX_OUTPUT
    }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

function errorText(error) {
  const message = error?.stderr || error?.stdout || error?.message || String(error);
  return message.length > MAX_OUTPUT ? message.slice(0, MAX_OUTPUT) + '\n[output truncated]' : message;
}

function registerTools(server) {
  server.registerTool(
    'hyperframes_doctor',
    {
      title: 'HyperFrames Doctor',
      description: 'Check the HyperFrames, Node, FFmpeg and Chromium environment.',
      inputSchema: z.object({})
    },
    async () => {
      try { return textResult((await runHyperframes(['doctor'])).stdout); }
      catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_init',
    {
      title: 'Create HyperFrames Project',
      description: 'Create a new HyperFrames project in the server workspace.',
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        width: z.number().int().positive().optional().describe('Optional project width in pixels.'),
        height: z.number().int().positive().optional().describe('Optional project height in pixels.'),
        fps: z.number().int().positive().max(120).optional().describe('Optional frames per second.')
      })
    },
    async ({ name, width, height, fps }) => {
      try {
        const args = ['init', name];
        if (width) args.push('--width', String(width));
        if (height) args.push('--height', String(height));
        if (fps) args.push('--fps', String(fps));
        const result = await runHyperframes(args, ROOT);
        return textResult(result.stdout || result.stderr || `Created ${name}`);
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_info',
    {
      title: 'Project Info',
      description: 'Inspect a HyperFrames project and return machine-readable project statistics when supported.',
      inputSchema: z.object({ project: z.string().min(1) })
    },
    async ({ project }) => {
      try {
        const result = await runHyperframes(['info', '--json'], projectPath(project));
        try { return jsonResult(JSON.parse(result.stdout)); } catch { return textResult(result.stdout || result.stderr); }
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_lint',
    {
      title: 'Lint Project',
      description: 'Run HyperFrames static composition linting.',
      inputSchema: z.object({ project: z.string().min(1), json: z.boolean().optional() })
    },
    async ({ project, json }) => {
      try {
        const args = ['lint'];
        if (json) args.push('--json');
        const result = await runHyperframes(args, projectPath(project));
        return textResult(result.stdout || result.stderr || 'Lint passed.');
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_validate',
    {
      title: 'Validate Project',
      description: 'Run HyperFrames project validation.',
      inputSchema: z.object({ project: z.string().min(1) })
    },
    async ({ project }) => {
      try { return textResult((await runHyperframes(['validate'], projectPath(project))).stdout); }
      catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_compositions',
    {
      title: 'List Compositions',
      description: 'List composition IDs and resolved durations in a HyperFrames project.',
      inputSchema: z.object({ project: z.string().min(1) })
    },
    async ({ project }) => {
      try { return textResult((await runHyperframes(['compositions'], projectPath(project))).stdout); }
      catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_render',
    {
      title: 'Render Video',
      description: 'Render a HyperFrames project to MP4, MOV, or WebM using the HyperFrames CLI.',
      inputSchema: z.object({
        project: z.string().min(1),
        quality: z.enum(['draft', 'standard', 'high']).optional(),
        output: z.string().optional().describe('Output path relative to the project, e.g. renders/final.mp4.'),
        fps: z.number().int().positive().max(120).optional(),
        format: z.enum(['mp4', 'mov', 'webm']).optional(),
        workers: z.number().int().positive().max(32).optional(),
        crf: z.number().int().min(0).max(51).optional(),
        videoBitrate: z.string().optional(),
        gpu: z.boolean().optional(),
        docker: z.boolean().optional()
      })
    },
    async ({ project, quality, output, fps, format, workers, crf, videoBitrate, gpu, docker }) => {
      try {
        const cwd = projectPath(project);
        const args = ['render'];
        if (quality) args.push('--quality', quality);
        if (output) {
          relativeSafe(cwd, output);
          args.push('--output', output);
        }
        if (fps) args.push('--fps', String(fps));
        if (format) args.push('--format', format);
        if (workers) args.push('--workers', String(workers));
        if (crf !== undefined) args.push('--crf', String(crf));
        if (videoBitrate) args.push('--video-bitrate', videoBitrate);
        if (gpu) args.push('--gpu');
        if (docker) args.push('--docker');
        const result = await runHyperframes(args, cwd);
        return textResult(result.stdout || result.stderr || 'Render completed.');
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_transcribe',
    {
      title: 'Transcribe Media',
      description: 'Run HyperFrames word-level media transcription on a project asset.',
      inputSchema: z.object({
        project: z.string().min(1),
        input: z.string().min(1).describe('Media path relative to the project.'),
        model: z.string().optional().describe('Whisper model supported by the installed HyperFrames CLI.'),
        json: z.boolean().optional()
      })
    },
    async ({ project, input, model, json }) => {
      try {
        const cwd = projectPath(project);
        relativeSafe(cwd, input);
        const args = ['transcribe', input];
        if (model) args.push('--model', model);
        if (json) args.push('--json');
        const result = await runHyperframes(args, cwd);
        return textResult(result.stdout || result.stderr);
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_tts',
    {
      title: 'Generate Voiceover',
      description: 'Generate on-device TTS audio through HyperFrames.',
      inputSchema: z.object({
        project: z.string().min(1),
        text: z.string().min(1).max(20000),
        voice: z.string().optional(),
        output: z.string().min(1).describe('Audio output path relative to the project.')
      })
    },
    async ({ project, text, voice, output }) => {
      try {
        const cwd = projectPath(project);
        relativeSafe(cwd, output);
        const args = ['tts', text, '--output', output];
        if (voice) args.push('--voice', voice);
        const result = await runHyperframes(args, cwd);
        return textResult(result.stdout || result.stderr);
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_catalog',
    {
      title: 'Browse HyperFrames Catalog',
      description: 'Browse available HyperFrames catalog blocks or components.',
      inputSchema: z.object({
        project: z.string().min(1),
        type: z.enum(['block', 'component']).optional()
      })
    },
    async ({ project, type }) => {
      try {
        const args = ['catalog'];
        if (type) args.push('--type', type);
        return textResult((await runHyperframes(args, projectPath(project))).stdout);
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_add',
    {
      title: 'Install Catalog Item',
      description: 'Install a HyperFrames catalog block or component into a project.',
      inputSchema: z.object({ project: z.string().min(1), name: z.string().min(1).max(200) })
    },
    async ({ project, name }) => {
      try { return textResult((await runHyperframes(['add', name], projectPath(project))).stdout); }
      catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_docs',
    {
      title: 'HyperFrames Docs',
      description: 'Return HyperFrames CLI documentation for a topic.',
      inputSchema: z.object({ topic: z.string().min(1).max(100) })
    },
    async ({ topic }) => {
      try { return textResult((await runHyperframes(['docs', topic], ROOT)).stdout); }
      catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'project_list_files',
    {
      title: 'List Project Files',
      description: 'List files in a HyperFrames project so the model can inspect and edit the workspace.',
      inputSchema: z.object({ project: z.string().min(1), subdir: z.string().optional() })
    },
    async ({ project, subdir }) => {
      try {
        const cwd = projectPath(project);
        const start = subdir ? relativeSafe(cwd, subdir) : cwd;
        const entries = [];
        async function walk(dir) {
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'renders'].includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else entries.push(path.relative(cwd, full));
          }
        }
        await walk(start);
        return jsonResult(entries.sort());
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'project_read_file',
    {
      title: 'Read Project File',
      description: 'Read a UTF-8 text file from a HyperFrames project.',
      inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1) })
    },
    async ({ project, file }) => {
      try {
        const cwd = projectPath(project);
        const target = relativeSafe(cwd, file);
        return textResult(await fs.readFile(target, 'utf8'));
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'project_write_file',
    {
      title: 'Write Project File',
      description: 'Create or replace a UTF-8 text file inside a HyperFrames project. Use this for HTML, CSS, JS, JSON, Markdown, SVG, and similar text assets.',
      inputSchema: z.object({
        project: z.string().min(1),
        file: z.string().min(1),
        content: z.string().max(2_000_000)
      })
    },
    async ({ project, file, content }) => {
      try {
        const cwd = projectPath(project);
        const target = relativeSafe(cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
        return textResult(`Wrote ${path.relative(cwd, target)} (${content.length} characters).`);
      } catch (error) { return textResult(errorText(error)); }
    }
  );

  server.registerTool(
    'hyperframes_cli',
    {
      title: 'HyperFrames CLI',
      description: 'Advanced escape hatch for HyperFrames CLI commands. This only invokes the HyperFrames CLI; it does not execute arbitrary shell commands. Use dedicated tools when available.',
      inputSchema: z.object({
        command: z.enum(['doctor', 'init', 'info', 'lint', 'validate', 'preview', 'render', 'compositions', 'catalog', 'add', 'transcribe', 'tts', 'upgrade', 'docs']),
        project: z.string().optional(),
        args: z.array(z.string()).max(30).optional()
      })
    },
    async ({ command, project, args = [] }) => {
      try {
        const cwd = project ? projectPath(project) : ROOT;
        const result = await runHyperframes([command, ...args], cwd);
        return textResult(result.stdout || result.stderr || 'Command completed.');
      } catch (error) { return textResult(errorText(error)); }
    }
  );
}

function buildServer() {
  const server = new McpServer(
    { name: 'hyperframes-mcp-server', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Use HyperFrames tools to create and edit HTML-native video projects. Prefer project_write_file for composition authoring, then lint/validate, then render. Keep all project files inside the named project workspace. Do not assume local user files exist on this server unless they were explicitly uploaded or written here.'
    }
  );
  registerTools(server);
  return server;
}

const mcpHandler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(mcpHandler);

const httpServer = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'hyperframes-mcp-server' }));
    return;
  }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('HyperFrames MCP server is running. MCP endpoint: /mcp');
    return;
  }

  if (req.url?.split('?')[0] !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    await nodeHandler(req, res);
  } catch (error) {
    console.error('[mcp]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal MCP server error' }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`HyperFrames MCP server listening on http://${HOST}:${PORT}`);
  console.log(`Workspace: ${ROOT}`);
  console.log('MCP endpoint: /mcp');
});

process.on('SIGTERM', async () => {
  try { await mcpHandler.close(); } catch {}
  httpServer.close(() => process.exit(0));
});
