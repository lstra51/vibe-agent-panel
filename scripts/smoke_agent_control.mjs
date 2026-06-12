const base = process.env.VIBE_BASE_URL || 'http://127.0.0.1:3000';

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const created = await api('/api/agent-sessions', {
  method: 'POST',
  body: JSON.stringify({
    agent: 'codex',
    profileId: 'default',
    cwd: '/home/ubuntu/projects',
    title: 'agent beta control smoke',
  }),
});
const sessionId = created.session.id;
console.log('session', sessionId);

const turn = await api(`/api/agent-sessions/${sessionId}/turns`, {
  method: 'POST',
  body: JSON.stringify({
    message: 'Run a short diagnostic and wait briefly before answering. If interrupted, stop cleanly.',
  }),
});
console.log('turn', turn.turn.id);

await new Promise((resolve) => setTimeout(resolve, 2000));
const steer = await api(`/api/agent-sessions/${sessionId}/steer`, {
  method: 'POST',
  body: JSON.stringify({ message: 'Additional instruction: keep the final answer concise.' }),
});
console.log('steer', JSON.stringify(steer));

await new Promise((resolve) => setTimeout(resolve, 2000));
const interrupted = await api(`/api/agent-sessions/${sessionId}/interrupt`, {
  method: 'POST',
  body: '{}',
});
console.log('interrupt', JSON.stringify(interrupted));

await new Promise((resolve) => setTimeout(resolve, 3000));
const final = await api(`/api/agent-sessions/${sessionId}`);
const activeTurn = final.turns.find((item) => item.id === turn.turn.id);
console.log(JSON.stringify({
  sessionId,
  turnId: turn.turn.id,
  turnStatus: activeTurn?.status,
  eventTypes: final.events.map((event) => event.type),
}, null, 2));

if (!steer || steer.ok !== true) throw new Error('steer did not return ok');
if (!interrupted || interrupted.ok !== true) throw new Error('interrupt did not return ok');
