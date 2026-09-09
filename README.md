# HyperFrames MCP Server

Remote MCP server for HyperFrames. It exposes HyperFrames project creation, file authoring, linting, validation, composition inspection, rendering, transcription, TTS, catalog access, documentation, and an advanced HyperFrames CLI tool over Streamable HTTP.

## Architecture

Claude → Streamable HTTP MCP → this server → HyperFrames CLI → Chromium/FFmpeg → rendered video

This repository does **not** copy Nate Herk's student kit into your repository. It uses the public HyperFrames npm package directly. The student kit is MIT licensed, while its included AIS brand assets are not licensed for reuse; do not copy those assets into this server.

## Local run

Requirements: Node.js 22+, FFmpeg, Chromium/Chrome.

```bash
npm install
npm start
```

The MCP endpoint is:

`http://localhost:10000/mcp`

Health check:

`http://localhost:10000/health`

## Render deployment

This repo includes `Dockerfile` and `render.yaml`.

1. In Render, create a **Web Service** from this GitHub repository.
2. Select the Docker runtime (the Blueprint already specifies it).
3. Deploy the `main` branch.
4. After deployment, verify `/health` returns JSON with `ok: true`.
5. Your MCP endpoint is:

`https://YOUR-SERVICE.onrender.com/mcp`

Render web services must listen on `0.0.0.0` and the `PORT` environment variable; this server does that by default. The included health check uses `/health`.

## Claude MCP connector

Use the deployed HTTPS endpoint ending in `/mcp` as a **remote Streamable HTTP MCP server**.

Example:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

After connecting, Claude should discover tools such as:

- `hyperframes_init`
- `project_write_file`
- `project_read_file`
- `project_list_files`
- `hyperframes_lint`
- `hyperframes_validate`
- `hyperframes_compositions`
- `hyperframes_render`
- `hyperframes_transcribe`
- `hyperframes_tts`
- `hyperframes_catalog`
- `hyperframes_add`
- `hyperframes_docs`
- `hyperframes_doctor`
- `hyperframes_cli`

## Important storage limitation

The default Render filesystem is ephemeral. A project created during one running instance is not a permanent cloud drive and can disappear after instance replacement/redeploy. For serious production use, add persistent storage or object storage for project media and renders.

## Security

The service is designed to be easy to connect first. If you expose it publicly, protect the MCP endpoint before using it with untrusted clients. Do not put private media, credentials, or secrets into project files.

## HyperFrames

HyperFrames is an HTML-native video framework/CLI. The server uses the installed npm package and its CLI rather than attempting to reimplement the rendering engine.
