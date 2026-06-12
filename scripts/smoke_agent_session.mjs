import WebSocket from 'ws';

const base = process.env.VIBE_BASE_URL || 'http://127.0.0.1:3000';
const wsBase = base.replace(/^http/, 'ws');
const agent = process.env.VIBE_SMOKE_AGENT || 'codex';
const message = process.env.VIBE_SMOKE_MESSAGE || 'Reply with exactly: agent beta ok';

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const created = await api('/api/agent-sessions', {
  method: 'POST',
  body: JSON.stringify({
    agent,
    profileId: 'default',
    cwd: '/home/ubuntu/projects',
    title: `agent beta smoke ${agent}`,
  }),
});

const sessionId = created.session.id;
console.log('session', sessionId);

const ws = new WebSocket(`${wsBase}/ws/agent-sessions/${sessionId}`);
const messages = [];
ws.on('message', (raw) => {
  messages.push(JSON.parse(raw.toString()));
});
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
  setTimeout(() => reject(new Error('websocket open timeout')), 10000).unref();
});

const turn = await api(`/api/agent-sessions/${sessionId}/turns`, {
  method: 'POST',
  body: JSON.stringify({ message }),
});
console.log('turn', turn.turn.id);

let final = null;
for (let i = 0; i < 90; i += 1) {
  const data = await api(`/api/agent-sessions/${sessionId}`);
  final = data;
  const active = data.turns.find((item) => item.id === turn.turn.id);
  if (active && !['queued', 'running'].includes(active.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
ws.close();

const activeTurn = final.turns.find((item) => item.id === turn.turn.id);
const text = final.events.map((event) => event.text || event.summary || '').join('\n');
console.log(JSON.stringify({
  agent,
  sessionId,
  turnId: turn.turn.id,
  status: activeTurn?.status,
  events: final.events.length,
  wsMessages: messages.length,
  preview: text.slice(-500),
}, null, 2));

if (!activeTurn || activeTurn.status !== 'succeeded') {
  throw new Error(`turn did not succeed: ${activeTurn?.status || 'missing'}`);
}

if (agent === 'codex' && final.events.length < 2) {
  throw new Error('codex event stream was too small');
}
