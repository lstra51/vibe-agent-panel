import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { spawn, execFile } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { cpus, loadavg, hostname, platform, release, uptime } from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerAgentSessionRoutes } from './agent-sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/ubuntu/projects';
const DB_PATH = process.env.DB_PATH || '/var/lib/vibe-coding/tasks.db';
const PROFILES_ROOT = process.env.PROFILES_ROOT || '/opt/vibe-coding/profiles';
const HOME = process.env.HOME || '/home/ubuntu';
const PATH_VALUE = `${HOME}/.local/bin:${HOME}/.local/npm/bin:/usr/local/bin:/usr/bin:/bin`;
const TERMINAL_IDLE_MS = Number(process.env.TERMINAL_IDLE_MS || 30 * 60 * 1000);
const LEGACY_LITELLM_ENV = process.env.LEGACY_LITELLM_ENV || '/opt/vibe-coding/litellm/litellm.env';
const LOG_SERVICE_ALLOWLIST = new Set(['mihomo', 'litellm', 'anthropic-deepseek', 'vibe-coding', 'nginx']);

mkdirSync(dirnameSafe(DB_PATH), { recursive: true });
mkdirSync(PROFILES_ROOT, { recursive: true });
mkdirSync(PROJECTS_ROOT, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
migrate();
ensureDefaultProfile();

const running = new Map();
const taskSockets = new Map();
const loginSessions = new Map();
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: join(APP_ROOT, 'dist') });
registerAgentSessionRoutes(app, agentContext());

app.get('/api/status', async () => {
  const [memory, disk, services, versions, ports, network] = await Promise.all([
    memoryInfo(),
    diskInfo('/'),
    serviceStates(['mihomo', 'litellm', 'anthropic-deepseek', 'vibe-coding', 'nginx']),
    commandVersions(),
    listeningPorts(),
    networkInfo()
  ]);
  return {
    ok: true,
    time: new Date().toISOString(),
    host: { hostname: hostname(), platform: platform(), release: release(), uptime: uptime(), loadavg: loadavg(), cpus: cpus().length },
    projectsRoot: PROJECTS_ROOT,
    memory,
    disk,
    network,
    services,
    versions,
    ports
  };
});

app.get('/api/tasks', async (request) => {
  const limit = Math.min(Number(request.query?.limit || 80), 200);
  const rows = db.prepare(`
    SELECT id, agent, profile_id AS profileId, title, project, cwd, prompt, status, pid, exit_code AS exitCode,
      signal, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
    FROM tasks
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR agent = ?)
      AND (? IS NULL OR profile_id = ?)
      AND (? IS NULL OR project = ?)
    ORDER BY id DESC
    LIMIT ?
  `).all(q(request, 'status'), q(request, 'status'), q(request, 'agent'), q(request, 'agent'), q(request, 'profileId'), q(request, 'profileId'), q(request, 'project'), q(request, 'project'), limit);
  return { tasks: rows };
});

app.get('/api/tasks/:id', async (request, reply) => {
  const task = getTask(Number(request.params.id));
  if (!task) return reply.code(404).send({ error: 'task not found' });
  const events = db.prepare('SELECT type, stream, text, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY id ASC').all(task.id);
  return { task, events };
});

app.post('/api/tasks', async (request, reply) => {
  const body = request.body || {};
  const agent = String(body.agent || '').trim();
  const prompt = String(body.prompt || '').trim();
  const profileId = String(body.profileId || defaultProfile().id);
  const profile = getProfile(profileId);
  const title = String(body.title || prompt.slice(0, 42) || 'Untitled task').trim();
  const project = String(body.project || 'default').trim();
  const cwdInput = String(body.cwd || PROJECTS_ROOT).trim();
  if (!['codex', 'claude'].includes(agent)) return reply.code(400).send({ error: 'agent must be codex or claude' });
  if (!profile) return reply.code(400).send({ error: 'profile not found' });
  if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
  const cwd = safeProjectPath(cwdInput, false);
  if (!cwd) return reply.code(400).send({ error: `cwd must be inside ${PROJECTS_ROOT}` });
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  const info = db.prepare(`
    INSERT INTO tasks (agent, profile_id, title, project, cwd, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(agent, profileId, title, project, cwd, prompt, now());
  audit('task.created', { taskId: info.lastInsertRowid, agent, profileId, cwd });
  startTask(Number(info.lastInsertRowid));
  return reply.code(201).send({ id: info.lastInsertRowid });
});

app.post('/api/tasks/:id/cancel', async (request, reply) => {
  const id = Number(request.params.id);
  const child = running.get(id);
  if (!child) return reply.code(404).send({ error: 'task is not running' });
  try {
    process.kill(-child.pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 5000).unref();
    audit('task.cancelled', { taskId: id });
    return { ok: true };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

app.get('/api/profiles', async () => {
  const profiles = db.prepare(`
    SELECT id, name, is_default AS isDefault, codex_home AS codexHome, created_at AS createdAt, updated_at AS updatedAt
    FROM profiles ORDER BY is_default DESC, created_at ASC
  `).all().map(enrichProfile);
  return { profiles };
});

app.post('/api/profiles', async (request, reply) => {
  const name = String(request.body?.name || '').trim();
  if (!name) return reply.code(400).send({ error: 'name is required' });
  const id = slug(name) || `profile-${nanoid(6)}`;
  if (getProfile(id)) return reply.code(409).send({ error: 'profile already exists' });
  createProfile(id, name, false);
  audit('profile.created', { profileId: id });
  return reply.code(201).send({ profile: enrichProfile(getProfile(id)) });
});

app.patch('/api/profiles/:id', async (request, reply) => {
  const profile = getProfile(request.params.id);
  if (!profile) return reply.code(404).send({ error: 'profile not found' });
  const name = String(request.body?.name || profile.name).trim();
  const isDefault = Boolean(request.body?.isDefault ?? profile.is_default);
  db.prepare('UPDATE profiles SET name = ?, is_default = ?, updated_at = ? WHERE id = ?').run(name, isDefault ? 1 : 0, now(), profile.id);
  if (isDefault) db.prepare('UPDATE profiles SET is_default = 0 WHERE id != ?').run(profile.id);
  audit('profile.updated', { profileId: profile.id, isDefault });
  return { profile: enrichProfile(getProfile(profile.id)) };
});

app.post('/api/profiles/:id/activate', async (request, reply) => {
  const profile = getProfile(request.params.id);
  if (!profile) return reply.code(404).send({ error: 'profile not found' });
  db.prepare('UPDATE profiles SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(profile.id);
  audit('profile.activated', { profileId: profile.id });
  return { ok: true, profile: enrichProfile(getProfile(profile.id)) };
});

app.post('/api/profiles/:id/deepseek', async (request, reply) => {
  const profile = getProfile(request.params.id);
  if (!profile) return reply.code(404).send({ error: 'profile not found' });
  const apiKey = String(request.body?.apiKey || '').trim();
  const model = String(request.body?.model || 'deepseek-chat').trim();
  const baseUrl = String(request.body?.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (!apiKey && !deepseekConfig(profile.id).keyPresent) return reply.code(400).send({ error: 'apiKey is required for first setup' });
  const existing = readJson(profileFile(profile.id, 'deepseek.json'), {});
  const next = {
    apiKey: apiKey || existing.apiKey,
    model,
    baseUrl,
    anthropicToken: existing.anthropicToken || `vibe_${nanoid(32)}`,
    updatedAt: now()
  };
  writeSecretJson(profileFile(profile.id, 'deepseek.json'), next);
  audit('profile.deepseek.updated', { profileId: profile.id, model, baseUrl });
  return { profile: enrichProfile(getProfile(profile.id)) };
});

app.post('/api/profiles/:id/codex-login/start', async (request, reply) => {
  const profile = getProfile(request.params.id);
  if (!profile) return reply.code(404).send({ error: 'profile not found' });
  const sessionId = nanoid(12);
  const child = spawn('codex', ['login', '--device-auth'], {
    cwd: PROJECTS_ROOT,
    env: profileEnv(profile),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  const session = { id: sessionId, profileId: profile.id, output: '', status: 'running', pid: child.pid, startedAt: now() };
  loginSessions.set(sessionId, session);
  child.stdout.on('data', (chunk) => { session.output += trimChunk(chunk); });
  child.stderr.on('data', (chunk) => { session.output += trimChunk(chunk); });
  child.on('close', (code, signal) => {
    session.status = code === 0 ? 'succeeded' : 'finished';
    session.exitCode = code;
    session.signal = signal;
    session.finishedAt = now();
  });
  audit('codex.login.started', { profileId: profile.id, sessionId });
  return reply.code(201).send({ sessionId, pid: child.pid });
});

app.get('/api/profiles/:id/codex-login/:sessionId', async (request, reply) => {
  const session = loginSessions.get(request.params.sessionId);
  if (!session || session.profileId !== request.params.id) return reply.code(404).send({ error: 'login session not found' });
  return { session };
});

app.get('/api/logs', async (request, reply) => {
  const service = String(request.query?.service || 'vibe-coding');
  const lines = Math.min(Number(request.query?.lines || 160), 500);
  if (!LOG_SERVICE_ALLOWLIST.has(service)) return reply.code(400).send({ error: 'service is not allowed' });
  const result = await run('journalctl', ['-u', service, '-n', String(lines), '--no-pager']);
  return { service, text: result.stdout || result.stderr || result.error || '' };
});

app.get('/ws/tasks/:id', { websocket: true }, (socket, request) => {
  const id = Number(request.params.id);
  if (!taskSockets.has(id)) taskSockets.set(id, new Set());
  taskSockets.get(id).add(socket);
  const events = db.prepare('SELECT type, stream, text, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY id ASC').all(id);
  socket.send(JSON.stringify({ type: 'snapshot', events, task: getTask(id) }));
  socket.on('close', () => taskSockets.get(id)?.delete(socket));
});

app.get('/ws/terminal', { websocket: true }, async (socket, request) => {
  const cwd = safeProjectPath(String(request.query?.cwd || PROJECTS_ROOT), false);
  const profile = getProfile(String(request.query?.profileId || defaultProfile().id));
  if (!cwd || !existsSync(cwd) || !profile) {
    socket.send(JSON.stringify({ type: 'error', message: 'invalid terminal cwd or profile' }));
    socket.close();
    return;
  }
  let pty;
  try {
    pty = await import('node-pty');
  } catch (error) {
    socket.send(JSON.stringify({ type: 'error', message: `node-pty unavailable: ${error.message}` }));
    socket.close();
    return;
  }
  const term = pty.spawn('/bin/bash', ['-l'], {
    name: 'xterm-color',
    cols: Number(request.query?.cols || 100),
    rows: Number(request.query?.rows || 28),
    cwd,
    env: profileEnv(profile)
  });
  audit('terminal.opened', { profileId: profile.id, cwd, pid: term.pid });
  let idle = refreshIdle();
  term.onData((data) => socket.send(JSON.stringify({ type: 'data', data })));
  term.onExit(({ exitCode, signal }) => {
    clearTimeout(idle);
    socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
    socket.close();
  });
  socket.on('message', (raw) => {
    idle = refreshIdle(idle);
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'data') term.write(String(msg.data || ''));
    if (msg.type === 'resize') term.resize(Number(msg.cols || 100), Number(msg.rows || 28));
  });
  socket.on('close', () => {
    clearTimeout(idle);
    try { term.kill(); } catch {}
  });
  function refreshIdle(old) {
    if (old) clearTimeout(old);
    return setTimeout(() => {
      try { term.kill(); } catch {}
      audit('terminal.timeout', { profileId: profile.id, cwd });
    }, TERMINAL_IDLE_MS).unref();
  }
});

app.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith('/api/') || request.raw.url?.startsWith('/ws/')) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.sendFile('index.html');
});

await app.listen({ host: HOST, port: PORT });

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      cwd TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      exit_code INTEGER,
      signal TEXT,
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      codex_home TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      stream TEXT,
      text TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      user_message TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      role TEXT,
      summary TEXT,
      text TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  addColumn('tasks', 'profile_id', 'TEXT');
  addColumn('tasks', 'title', 'TEXT');
  addColumn('tasks', 'project', 'TEXT');
  db.prepare("UPDATE tasks SET profile_id = COALESCE(profile_id, 'default'), title = COALESCE(title, substr(prompt, 1, 42)), project = COALESCE(project, 'default')").run();
}

function addColumn(table, column, spec) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
}

function startTask(id) {
  const task = getTask(id);
  if (!task) return;
  const profile = getProfile(task.profileId) || defaultProfile();
  const spec = task.agent === 'codex'
    ? { cmd: 'codex', args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', task.prompt] }
    : { cmd: 'claude-deepseek', args: ['-p', task.prompt] };
  db.prepare('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?').run('running', now(), id);
  appendEvent(id, 'status', null, 'running');
  const child = spawn(spec.cmd, spec.args, { cwd: task.cwd, env: profileEnv(profile), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(id, child);
  db.prepare('UPDATE tasks SET pid = ? WHERE id = ?').run(child.pid, id);
  child.stdout.on('data', (chunk) => {
    const text = trimChunk(chunk);
    db.prepare('UPDATE tasks SET stdout = stdout || ? WHERE id = ?').run(text, id);
    appendEvent(id, 'output', 'stdout', text);
  });
  child.stderr.on('data', (chunk) => {
    const text = trimChunk(chunk);
    db.prepare('UPDATE tasks SET stderr = stderr || ? WHERE id = ?').run(text, id);
    appendEvent(id, 'output', 'stderr', text);
  });
  child.on('error', (error) => {
    db.prepare('UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE id = ?').run('failed', error.message, now(), id);
    appendEvent(id, 'error', null, error.message);
    running.delete(id);
  });
  child.on('close', (code, signal) => {
    const status = signal ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
    db.prepare('UPDATE tasks SET status = ?, exit_code = ?, signal = ?, finished_at = ? WHERE id = ?').run(status, code, signal, now(), id);
    appendEvent(id, 'status', null, status);
    running.delete(id);
  });
}

function appendEvent(taskId, type, stream, text) {
  const event = { type, stream, text, createdAt: now() };
  db.prepare('INSERT INTO task_events (task_id, type, stream, text, created_at) VALUES (?, ?, ?, ?, ?)').run(taskId, type, stream, text, event.createdAt);
  const sockets = taskSockets.get(taskId);
  if (sockets) for (const socket of sockets) socket.send(JSON.stringify({ type: 'event', event, task: getTask(taskId) }));
}

function getTask(id) {
  return db.prepare(`
    SELECT id, agent, profile_id AS profileId, title, project, cwd, prompt, status, pid, exit_code AS exitCode,
      signal, stdout, stderr, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
    FROM tasks WHERE id = ?
  `).get(id);
}

function createProfile(id, name, isDefault) {
  const codexHome = join(PROFILES_ROOT, id, 'codex');
  mkdirSync(codexHome, { recursive: true });
  db.prepare('INSERT INTO profiles (id, name, codex_home, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, codexHome, isDefault ? 1 : 0, now(), now());
  writeSecretJson(profileFile(id, 'deepseek.json'), {
    apiKey: '',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    anthropicToken: `vibe_${nanoid(32)}`,
    updatedAt: now()
  });
}

function ensureDefaultProfile() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count;
  if (count === 0) createProfile('default', 'Default', true);
  importLegacyDeepSeekKey();
  importLegacyCodexAuth();
}

function defaultProfile() {
  return db.prepare('SELECT * FROM profiles WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1').get()
    || db.prepare('SELECT * FROM profiles ORDER BY created_at ASC LIMIT 1').get();
}

function getProfile(id) {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
}

function enrichProfile(profile) {
  if (!profile) return null;
  const codexHome = profile.codex_home || profile.codexHome;
  const deepseek = deepseekConfig(profile.id);
  const authPath = join(codexHome, 'auth.json');
  return {
    id: profile.id,
    name: profile.name,
    isDefault: Boolean(profile.is_default ?? profile.isDefault),
    codexHome,
    codex: { authenticated: existsSync(authPath), authPath },
    deepseek,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at
  };
}

function deepseekConfig(profileId) {
  const cfg = readJson(profileFile(profileId, 'deepseek.json'), {});
  return {
    keyPresent: Boolean(String(cfg.apiKey || '').trim()),
    keyMask: cfg.apiKey ? maskSecret(cfg.apiKey) : '',
    model: cfg.model || 'deepseek-chat',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com',
    tokenPresent: Boolean(cfg.anthropicToken)
  };
}

function importLegacyDeepSeekKey() {
  const profile = getProfile('default') || defaultProfile();
  if (!profile || deepseekConfig(profile.id).keyPresent || !existsSync(LEGACY_LITELLM_ENV)) return;
  const env = parseEnvFile(LEGACY_LITELLM_ENV);
  if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY === '__FILL_DEEPSEEK_API_KEY__') return;
  const existing = readJson(profileFile(profile.id, 'deepseek.json'), {});
  writeSecretJson(profileFile(profile.id, 'deepseek.json'), {
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.ANTHROPIC_MODEL || env.DEEPSEEK_MODEL || existing.model || 'deepseek-chat',
    baseUrl: env.DEEPSEEK_API_BASE || existing.baseUrl || 'https://api.deepseek.com',
    anthropicToken: existing.anthropicToken || `vibe_${nanoid(32)}`,
    updatedAt: now()
  });
  audit('profile.deepseek.imported_legacy', { profileId: profile.id, source: LEGACY_LITELLM_ENV });
}

function parseEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const index = trimmed.indexOf('=');
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      out[key] = value;
    }
  } catch {}
  return out;
}

function importLegacyCodexAuth() {
  const profile = getProfile('default') || defaultProfile();
  if (!profile) return;
  const codexHome = profile.codex_home || profile.codexHome;
  const targetAuth = join(codexHome, 'auth.json');
  const sourceAuth = join(HOME, '.codex', 'auth.json');
  if (existsSync(targetAuth) || !existsSync(sourceAuth)) return;
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(sourceAuth, targetAuth);
  try { chmodSync(targetAuth, 0o600); } catch {}
  const sourceConfig = join(HOME, '.codex', 'config.toml');
  const targetConfig = join(codexHome, 'config.toml');
  if (!existsSync(targetConfig) && existsSync(sourceConfig)) {
    copyFileSync(sourceConfig, targetConfig);
    try { chmodSync(targetConfig, 0o600); } catch {}
  }
  audit('profile.codex.imported_legacy', { profileId: profile.id, source: sourceAuth });
}

function profileEnv(profile) {
  const cfg = readJson(profileFile(profile.id, 'deepseek.json'), {});
  return {
    ...process.env,
    PATH: PATH_VALUE,
    HOME,
    CODEX_HOME: profile.codex_home,
    VIBE_PROFILE_ID: profile.id,
    VIBE_PROFILES_ROOT: PROFILES_ROOT,
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: '127.0.0.1,localhost',
    DEEPSEEK_API_BASE: cfg.baseUrl || 'https://api.deepseek.com',
    ANTHROPIC_MODEL: cfg.model || 'deepseek-chat'
  };
}

function profileFile(profileId, name) {
  const dir = join(PROFILES_ROOT, profileId);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function writeSecretJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  try { chmodSync(path, 0o600); } catch {}
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function audit(type, payload) {
  db.prepare('INSERT INTO audit_events (type, payload, created_at) VALUES (?, ?, ?)').run(type, JSON.stringify(payload), now());
}

function agentContext() {
  return {
    PROJECTS_ROOT,
    defaultProfile,
    getProfile,
    profileEnv,
    safeProjectPath,
    audit,
    listAgentSessions,
    createAgentSession,
    getAgentSession,
    setAgentThread,
    listAgentTurns,
    createAgentTurn,
    startAgentTurn,
    completeAgentTurn,
    failAgentTurn,
    listAgentEvents,
    appendAgentEvent,
    listAgentApprovals,
    createAgentApproval,
    getAgentApproval,
    resolveAgentApproval,
  };
}

function listAgentSessions(limit = 80) {
  return db.prepare(`
    SELECT id, agent, profile_id AS profileId, title, cwd, status, thread_id AS threadId,
      created_at AS createdAt, updated_at AS updatedAt
    FROM agent_sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

function createAgentSession({ agent, profileId, title, cwd }) {
  const id = `sess_${nanoid(12)}`;
  db.prepare(`
    INSERT INTO agent_sessions (id, agent, profile_id, title, cwd, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)
  `).run(id, agent, profileId, title, cwd, now(), now());
  return getAgentSession(id);
}

function getAgentSession(id) {
  return db.prepare(`
    SELECT id, agent, profile_id AS profileId, title, cwd, status, thread_id AS threadId,
      created_at AS createdAt, updated_at AS updatedAt
    FROM agent_sessions
    WHERE id = ?
  `).get(id);
}

function setAgentThread(sessionId, threadId) {
  db.prepare('UPDATE agent_sessions SET thread_id = ?, updated_at = ? WHERE id = ?').run(threadId, now(), sessionId);
}

function listAgentTurns(sessionId) {
  return db.prepare(`
    SELECT id, session_id AS sessionId, status, user_message AS userMessage, error,
      created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
    FROM agent_turns
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId);
}

function createAgentTurn(sessionId, userMessage) {
  const id = `turn_${nanoid(12)}`;
  db.prepare(`
    INSERT INTO agent_turns (id, session_id, status, user_message, created_at)
    VALUES (?, ?, 'queued', ?, ?)
  `).run(id, sessionId, userMessage, now());
  db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run('running', now(), sessionId);
  return getAgentTurn(id);
}

function getAgentTurn(id) {
  return db.prepare(`
    SELECT id, session_id AS sessionId, status, user_message AS userMessage, error,
      created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
    FROM agent_turns
    WHERE id = ?
  `).get(id);
}

function startAgentTurn(turnId) {
  const turn = getAgentTurn(turnId);
  if (!turn) return;
  db.prepare('UPDATE agent_turns SET status = ?, started_at = ? WHERE id = ?').run('running', now(), turnId);
  db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run('running', now(), turn.sessionId);
}

function completeAgentTurn(turnId, status = 'succeeded') {
  if (!turnId) return;
  const turn = getAgentTurn(turnId);
  if (!turn) return;
  db.prepare('UPDATE agent_turns SET status = ?, completed_at = ? WHERE id = ?').run(status, now(), turnId);
  db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status === 'succeeded' ? 'idle' : status, now(), turn.sessionId);
}

function failAgentTurn(turnId, error) {
  if (!turnId) return;
  const turn = getAgentTurn(turnId);
  if (!turn) return;
  db.prepare('UPDATE agent_turns SET status = ?, error = ?, completed_at = ? WHERE id = ?').run('failed', error.message, now(), turnId);
  db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run('failed', now(), turn.sessionId);
}

function listAgentEvents(sessionId) {
  return db.prepare(`
    SELECT id, session_id AS sessionId, turn_id AS turnId, source, type, role, summary, text, payload,
      created_at AS createdAt
    FROM agent_events
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId).map(parsePayload);
}

function appendAgentEvent({ sessionId, turnId = null, source, type, role = null, summary = null, text = '', payload = {} }) {
  db.prepare(`
    INSERT INTO agent_events (session_id, turn_id, source, type, role, summary, text, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, turnId, source, type, role, summary, text, JSON.stringify(payload || {}), now());
  db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
}

function listAgentApprovals(sessionId) {
  return db.prepare(`
    SELECT id, session_id AS sessionId, turn_id AS turnId, status, decision, payload,
      created_at AS createdAt, resolved_at AS resolvedAt
    FROM agent_approvals
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId).map(parsePayload);
}

function createAgentApproval({ sessionId, turnId = null, payload = {} }) {
  const id = `approval_${nanoid(12)}`;
  db.prepare(`
    INSERT INTO agent_approvals (id, session_id, turn_id, status, payload, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(id, sessionId, turnId, JSON.stringify(payload || {}), now());
  return getAgentApproval(id);
}

function getAgentApproval(id) {
  const row = db.prepare(`
    SELECT id, session_id AS sessionId, turn_id AS turnId, status, decision, payload,
      created_at AS createdAt, resolved_at AS resolvedAt
    FROM agent_approvals
    WHERE id = ?
  `).get(id);
  return row ? parsePayload(row) : null;
}

function resolveAgentApproval(id, decision) {
  db.prepare('UPDATE agent_approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ?').run('resolved', decision, now(), id);
}

function parsePayload(row) {
  if (!row?.payload || typeof row.payload !== 'string') return row;
  try {
    return { ...row, payload: JSON.parse(row.payload) };
  } catch {
    return { ...row, payload: {} };
  }
}

async function memoryInfo() {
  const out = await run('free', ['-b']);
  const line = out.stdout.split('\n').find((item) => item.startsWith('Mem:'));
  if (!line) return { total: 0, used: 0, free: 0, percent: 0 };
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [total, used, free] = parts;
  return { total, used, free, percent: total ? Math.round((used / total) * 100) : 0 };
}

async function diskInfo(path) {
  const out = await run('df', ['-B1', path]);
  const line = out.stdout.trim().split('\n')[1];
  if (!line) return { total: 0, used: 0, available: 0, percent: 0 };
  const parts = line.trim().split(/\s+/);
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const available = Number(parts[3]);
  return { total, used, available, percent: total ? Math.round((used / total) * 100) : 0, mount: parts[5] };
}

async function networkInfo() {
  try {
    const text = readFileSync('/proc/net/dev', 'utf8');
    const rows = text.split('\n').slice(2).map((line) => line.trim()).filter(Boolean);
    const totals = rows.reduce((acc, row) => {
      const [ifaceRaw, ...values] = row.replace(':', ' ').split(/\s+/);
      if (ifaceRaw === 'lo') return acc;
      acc.rx += Number(values[0] || 0);
      acc.tx += Number(values[8] || 0);
      return acc;
    }, { rx: 0, tx: 0 });
    return totals;
  } catch {
    return { rx: 0, tx: 0 };
  }
}

async function serviceStates(names) {
  const entries = await Promise.all(names.map(async (name) => {
    const res = await run('systemctl', ['is-active', name]);
    return [name, res.stdout.trim() || 'unknown'];
  }));
  return Object.fromEntries(entries);
}

async function commandVersions() {
  const specs = {
    ubuntu: ['lsb_release', ['-ds']],
    node: ['node', ['-v']],
    npm: ['npm', ['-v']],
    codex: ['codex', ['--version']],
    claude: ['claude', ['--version']],
    mihomo: ['mihomo', ['-v']]
  };
  const out = {};
  for (const [name, [cmd, args]] of Object.entries(specs)) {
    const res = await run(cmd, args);
    out[name] = (res.stdout || res.stderr || res.error || '').split('\n')[0].replace(/^"|"$/g, '').trim();
  }
  return out;
}

async function listeningPorts() {
  const out = await run('ss', ['-ltnp']);
  return out.stdout.split('\n').slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return null;
    return { state: parts[0], local: parts[3], process: parts.slice(6).join(' ') };
  }).filter(Boolean);
}

function safeProjectPath(input, mustExist) {
  const full = resolve(input.startsWith('/') ? input : join(PROJECTS_ROOT, input));
  const rel = relative(PROJECTS_ROOT, full);
  if (rel.startsWith('..') || rel === '..' || full === '/') return null;
  if (mustExist && !existsSync(full)) return null;
  return full;
}

function q(request, key) {
  const value = request.query?.[key];
  return value ? String(value) : null;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function maskSecret(value) {
  return value.length <= 10 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function now() {
  return new Date().toISOString();
}

function dirnameSafe(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

function trimChunk(chunk) {
  const text = chunk.toString('utf8');
  return text.length > 65536 ? text.slice(-65536) : text;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, env: { ...process.env, PATH: PATH_VALUE } }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error?.message || null });
    });
  });
}
