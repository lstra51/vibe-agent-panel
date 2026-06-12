import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { nanoid } from 'nanoid';

const CODEX_BIN = process.env.CODEX_BIN || '/home/ubuntu/.local/bin/codex';
const MAX_EVENT_TEXT = 128 * 1024;

export function registerAgentSessionRoutes(app, context) {
  const manager = new AgentRuntimeManager(context);

  app.addHook('onClose', async () => {
    manager.shutdownAll();
  });

  app.get('/api/agent-capabilities', async () => ({
    agents: {
      codex: {
        label: 'Codex',
        appServer: true,
        steer: true,
        interrupt: true,
        approvals: true,
        debugEvents: true,
      },
      claude: {
        label: 'Claude Code via DeepSeek',
        appServer: false,
        steer: false,
        interrupt: true,
        approvals: false,
        debugEvents: false,
      },
    },
  }));

  app.get('/api/agent-sessions', async (request) => {
    const limit = Math.min(Number(request.query?.limit || 80), 200);
    return { sessions: context.listAgentSessions(limit) };
  });

  app.post('/api/agent-sessions', async (request, reply) => {
    const body = request.body || {};
    const agent = String(body.agent || '').trim();
    const profileId = String(body.profileId || context.defaultProfile().id);
    const profile = context.getProfile(profileId);
    const title = String(body.title || 'Untitled chat').trim();
    const cwd = context.safeProjectPath(String(body.cwd || context.PROJECTS_ROOT), false);
    if (!['codex', 'claude'].includes(agent)) return reply.code(400).send({ error: 'agent must be codex or claude' });
    if (!profile) return reply.code(400).send({ error: 'profile not found' });
    if (!cwd) return reply.code(400).send({ error: `cwd must be inside ${context.PROJECTS_ROOT}` });
    const session = context.createAgentSession({ agent, profileId, title, cwd });
    context.audit('agent_session.created', { sessionId: session.id, agent, profileId, cwd });
    return reply.code(201).send({ session });
  });

  app.get('/api/agent-sessions/:id', async (request, reply) => {
    const session = context.getAgentSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return {
      session,
      turns: context.listAgentTurns(session.id),
      events: context.listAgentEvents(session.id),
      approvals: context.listAgentApprovals(session.id),
    };
  });

  app.post('/api/agent-sessions/:id/turns', async (request, reply) => {
    const session = context.getAgentSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const message = String(request.body?.message || '').trim();
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const turn = context.createAgentTurn(session.id, message);
    manager.startTurn(session.id, turn.id, message).catch((error) => {
      context.failAgentTurn(turn.id, error);
      context.appendAgentEvent({ sessionId: session.id, turnId: turn.id, source: 'server', type: 'error', text: error.message, payload: errorPayload(error) });
      manager.broadcast(session.id);
    });
    return reply.code(201).send({ turn });
  });

  app.post('/api/agent-sessions/:id/steer', async (request, reply) => {
    const session = context.getAgentSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const message = String(request.body?.message || '').trim();
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const result = await manager.steer(session.id, message);
    return result;
  });

  app.post('/api/agent-sessions/:id/interrupt', async (request, reply) => {
    const session = context.getAgentSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const result = await manager.interrupt(session.id);
    return result;
  });

  app.post('/api/agent-sessions/:id/approvals/:approvalId', async (request, reply) => {
    const session = context.getAgentSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const decision = String(request.body?.decision || '').trim();
    if (!['allow', 'deny'].includes(decision)) return reply.code(400).send({ error: 'decision must be allow or deny' });
    const result = await manager.resolveApproval(session.id, request.params.approvalId, decision);
    return result;
  });

  app.get('/ws/agent-sessions/:id', { websocket: true }, (socket, request) => {
    const sessionId = request.params.id;
    if (!context.getAgentSession(sessionId)) {
      socket.send(JSON.stringify({ type: 'error', error: 'session not found' }));
      socket.close();
      return;
    }
    manager.addSocket(sessionId, socket);
    socket.send(JSON.stringify(snapshot(context, sessionId)));
    socket.on('close', () => manager.removeSocket(sessionId, socket));
  });
}

class AgentRuntimeManager {
  constructor(context) {
    this.context = context;
    this.codex = new Map();
    this.claude = new Map();
    this.sockets = new Map();
  }

  addSocket(sessionId, socket) {
    if (!this.sockets.has(sessionId)) this.sockets.set(sessionId, new Set());
    this.sockets.get(sessionId).add(socket);
  }

  removeSocket(sessionId, socket) {
    this.sockets.get(sessionId)?.delete(socket);
  }

  broadcast(sessionId, message = snapshot(this.context, sessionId)) {
    const text = JSON.stringify(message);
    for (const socket of this.sockets.get(sessionId) || []) {
      try { socket.send(text); } catch {}
    }
  }

  async startTurn(sessionId, turnId, message) {
    const session = this.context.getAgentSession(sessionId);
    if (!session) throw new Error('session not found');
    if (session.agent === 'codex') {
      await this.startCodexTurn(session, turnId, message);
    } else {
      this.startClaudeTurn(session, turnId, message);
    }
  }

  async startCodexTurn(session, turnId, message) {
    const runtime = await this.ensureCodexRuntime(session);
    this.context.startAgentTurn(turnId);
    this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'user', type: 'user.message', role: 'user', text: message });
    this.broadcast(session.id);
    let threadId = session.threadId;
    if (!threadId) {
      const created = await runtime.request('thread/start', {
        cwd: session.cwd,
      });
      threadId = created?.thread?.id || created?.threadId || created?.id;
      if (!threadId) throw new Error('codex app-server did not return a thread id');
      this.context.setAgentThread(session.id, threadId);
    }
    runtime.activeTurnId = turnId;
    const started = await runtime.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: message }],
      cwd: session.cwd,
    });
    runtime.activeCodexTurnId = started?.turn?.id || started?.turnId || runtime.activeCodexTurnId;
  }

  startClaudeTurn(session, turnId, message) {
    const profile = this.context.getProfile(session.profileId) || this.context.defaultProfile();
    this.context.startAgentTurn(turnId);
    this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'user', type: 'user.message', role: 'user', text: message });
    this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'claude', type: 'turn.started', text: 'Claude turn started' });
    this.broadcast(session.id);
    const child = spawn('claude-deepseek', ['-p', message], {
      cwd: session.cwd,
      env: this.context.profileEnv(profile),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.claude.set(session.id, { child, turnId });
    child.stdout.on('data', (chunk) => {
      const text = trim(chunk);
      this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'claude', type: 'agent.delta', role: 'assistant', text });
      this.broadcast(session.id);
    });
    child.stderr.on('data', (chunk) => {
      const text = trim(chunk);
      this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'claude', type: 'log.stderr', text });
      this.broadcast(session.id);
    });
    child.on('error', (error) => {
      this.context.failAgentTurn(turnId, error);
      this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'claude', type: 'error', text: error.message, payload: errorPayload(error) });
      this.claude.delete(session.id);
      this.broadcast(session.id);
    });
    child.on('close', (code, signal) => {
      const status = signal ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
      this.context.completeAgentTurn(turnId, status);
      this.context.appendAgentEvent({ sessionId: session.id, turnId, source: 'claude', type: 'turn.completed', text: status, payload: { code, signal } });
      this.claude.delete(session.id);
      this.broadcast(session.id);
    });
  }

  async steer(sessionId, message) {
    const session = this.context.getAgentSession(sessionId);
    if (!session) throw new Error('session not found');
    if (session.agent !== 'codex') {
      this.context.appendAgentEvent({ sessionId, source: 'server', type: 'capability.unavailable', text: 'Claude Code does not support realtime steer; send a new turn instead.' });
      this.broadcast(sessionId);
      return { ok: false, supported: false, message: 'Claude Code does not support realtime steer' };
    }
    const runtime = this.codex.get(sessionId);
    if (!runtime) return { ok: false, supported: true, message: 'No active Codex runtime' };
    if (!runtime.activeTurnId) return { ok: false, supported: true, message: 'No active Codex turn' };
    const threadId = session.threadId || runtime.threadId;
    const expectedTurnId = runtime.activeCodexTurnId;
    if (!threadId || !expectedTurnId) return { ok: false, supported: true, message: 'Codex turn is not ready for steer yet' };
    await runtime.request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text: message }] });
    this.context.appendAgentEvent({ sessionId, turnId: runtime.activeTurnId, source: 'user', type: 'user.steer', role: 'user', text: message });
    this.broadcast(sessionId);
    return { ok: true };
  }

  async interrupt(sessionId) {
    const session = this.context.getAgentSession(sessionId);
    if (!session) throw new Error('session not found');
    if (session.agent === 'codex') {
      const runtime = this.codex.get(sessionId);
      if (!runtime) return { ok: false, message: 'No active Codex runtime' };
      if (!runtime.activeTurnId) return { ok: false, message: 'No active Codex turn' };
      const threadId = session.threadId || runtime.threadId;
      const turnId = runtime.activeCodexTurnId;
      if (!threadId || !turnId) return { ok: false, message: 'Codex turn is not ready for interrupt yet' };
      await runtime.request('turn/interrupt', { threadId, turnId });
      this.context.appendAgentEvent({ sessionId, turnId: runtime.activeTurnId, source: 'user', type: 'turn.interrupt.requested', text: 'Interrupt requested' });
      this.broadcast(sessionId);
      return { ok: true };
    }
    const runtime = this.claude.get(sessionId);
    if (!runtime) return { ok: false, message: 'No active Claude process' };
    try {
      process.kill(-runtime.child.pid, 'SIGTERM');
    } catch {
      try { runtime.child.kill('SIGTERM'); } catch {}
    }
    this.context.appendAgentEvent({ sessionId, turnId: runtime.turnId, source: 'user', type: 'turn.interrupt.requested', text: 'Cancel requested' });
    this.broadcast(sessionId);
    return { ok: true };
  }

  async resolveApproval(sessionId, approvalId, decision) {
    const session = this.context.getAgentSession(sessionId);
    const runtime = this.codex.get(sessionId);
    if (!session || !runtime) return { ok: false, message: 'No active Codex runtime' };
    this.context.resolveAgentApproval(approvalId, decision);
    const approval = this.context.getAgentApproval(approvalId);
    const payload = typeof approval?.payload === 'string'
      ? safeJson(approval.payload, {})
      : approval?.payload || {};
    const raw = payload.raw || payload;
    const rpcRequestId = payload.rpcRequestId || raw.id;
    if (!rpcRequestId) return { ok: false, message: 'Approval request is missing an RPC id' };
    runtime.respond(rpcRequestId, approvalResponse(raw.method, decision));
    this.context.appendAgentEvent({ sessionId, turnId: runtime.activeTurnId, source: 'user', type: 'approval.resolved', text: decision, payload: { approvalId, decision } });
    this.broadcast(sessionId);
    return { ok: true };
  }

  async ensureCodexRuntime(session) {
    const existing = this.codex.get(session.id);
    if (existing && existing.alive) return existing;
    const profile = this.context.getProfile(session.profileId) || this.context.defaultProfile();
    const runtime = new CodexAppServerRuntime(session, this.context.profileEnv(profile), (msg) => this.handleCodexNotification(session.id, msg));
    await runtime.start();
    this.codex.set(session.id, runtime);
    return runtime;
  }

  handleCodexNotification(sessionId, msg) {
    const session = this.context.getAgentSession(sessionId);
    if (!session) return;
    const runtime = this.codex.get(sessionId);
    const turnId = runtime?.activeTurnId || null;
    const normalized = normalizeCodexNotification(msg);
    if (normalized.approval) {
      const approval = this.context.createAgentApproval({ sessionId, turnId, payload: { rpcRequestId: msg.id, raw: normalized.raw } });
      normalized.event.payload = { ...normalized.event.payload, approvalId: approval.id };
    }
    this.context.appendAgentEvent({ sessionId, turnId, ...normalized.event });
    if (normalized.threadId) {
      runtime.threadId = normalized.threadId;
      this.context.setAgentThread(sessionId, normalized.threadId);
    }
    if (normalized.codexTurnId) runtime.activeCodexTurnId = normalized.codexTurnId;
    if (normalized.turnStatus) {
      this.context.completeAgentTurn(turnId, normalized.turnStatus);
      if (runtime) {
        runtime.activeTurnId = null;
        runtime.activeCodexTurnId = null;
      }
    }
    this.broadcast(sessionId);
  }

  shutdownAll() {
    for (const runtime of this.codex.values()) runtime.stop();
    for (const runtime of this.claude.values()) {
      try { runtime.child.kill('SIGTERM'); } catch {}
    }
  }
}

class CodexAppServerRuntime {
  constructor(session, env, onNotification) {
    this.session = session;
    this.env = env;
    this.onNotification = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.alive = false;
    this.activeTurnId = null;
    this.activeCodexTurnId = null;
    this.threadId = session.threadId || null;
  }

  async start() {
    this.child = spawn(CODEX_BIN, ['app-server', '--stdio'], {
      cwd: this.session.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.onNotification({ method: 'server/stderr', params: { text: trim(chunk) } });
    });
    this.child.on('close', (code, signal) => {
      this.alive = false;
      for (const pending of this.pending.values()) pending.reject(new Error(`codex app-server exited ${code ?? ''} ${signal ?? ''}`.trim()));
      this.pending.clear();
      this.onNotification({ method: 'server/closed', params: { code, signal } });
    });
    await this.request('initialize', {
      clientInfo: { name: 'vibe_agent_panel', title: 'Vibe Agent Panel', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onNotification({ method: 'server/raw', params: { text: line } });
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }
    this.onNotification(msg);
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, 120000).unref();
    });
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  stop() {
    try { this.child.kill('SIGTERM'); } catch {}
  }
}

function normalizeCodexNotification(msg) {
  const method = msg.method || msg.type || 'codex.event';
  const params = msg.params || msg;
  const item = params.item || params;
  const itemType = item.type || method;
  const raw = { method, params };
  let type = method.replace(/\//g, '.');
  let text = readableText(item) || readableText(params) || '';
  let role = item.role || params.role || null;
  let summary = item.summary || params.summary || null;
  let payload = raw;
  let source = 'codex';
  let approval = false;
  let threadId = params.thread?.id || params.threadId || params.thread_id || null;
  let codexTurnId = params.turn?.id || params.turnId || params.turn_id || null;
  let turnStatus = null;

  if (method.includes('agentMessage') || itemType === 'agent_message') {
    type = method.includes('delta') ? 'agent.delta' : 'agent.message';
    role = 'assistant';
  } else if (itemType.includes?.('reasoning') || method.toLowerCase().includes('reasoning')) {
    type = 'reasoning.summary';
  } else if (itemType.includes?.('plan') || method.toLowerCase().includes('plan')) {
    type = 'plan.update';
  } else if (itemType.includes?.('command') || item.command) {
    type = method.includes('completed') || item.status === 'completed' ? 'command.completed' : 'command.started';
    text = item.command || text;
  } else if (itemType.includes?.('file') || item.path) {
    type = 'file.changed';
    text = item.path || text;
  } else if (method.toLowerCase().includes('approval') || itemType.toLowerCase?.().includes('approval')) {
    type = 'approval.requested';
    approval = true;
  } else if (method === 'turn/completed' || method === 'turn.completed') {
    type = 'turn.completed';
    turnStatus = 'succeeded';
    codexTurnId = params.turn?.id || codexTurnId;
  } else if (method === 'turn/failed' || method === 'turn.failed' || method === 'error') {
    type = 'error';
    turnStatus = method.includes('turn') ? 'failed' : null;
  } else if (method === 'server/closed') {
    type = 'runtime.closed';
    source = 'server';
  } else if (method === 'server/stderr' || method === 'server/raw') {
    type = 'log.stderr';
    source = 'server';
  }

  return {
    event: { source, type, role, summary, text: trim(text), payload },
    approval,
    raw,
    threadId,
    codexTurnId,
    turnStatus,
  };
}

function approvalResponse(method = '', decision) {
  const allow = decision === 'allow';
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: allow ? 'accept' : 'decline' };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: allow ? 'accept' : 'decline' };
  }
  return { decision: allow ? 'approved' : 'denied' };
}

function readableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.delta === 'string') return value.delta;
  if (value.delta?.text) return value.delta.text;
  if (value.content && typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return value.content.map(readableText).filter(Boolean).join('\n');
  return '';
}

function snapshot(context, sessionId) {
  return {
    type: 'snapshot',
    session: context.getAgentSession(sessionId),
    turns: context.listAgentTurns(sessionId),
    events: context.listAgentEvents(sessionId),
    approvals: context.listAgentApprovals(sessionId),
  };
}

function errorPayload(error) {
  return { message: error.message, stack: error.stack };
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function trim(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  return text.length > MAX_EVENT_TEXT ? text.slice(-MAX_EVENT_TEXT) : text;
}
