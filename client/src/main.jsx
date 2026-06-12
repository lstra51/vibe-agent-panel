import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import {
  Activity,
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Code2,
  Cpu,
  Database,
  FileText,
  Folder,
  Gauge,
  HardDrive,
  Home,
  KeyRound,
  LayoutGrid,
  Loader2,
  MemoryStick,
  Monitor,
  Network,
  Play,
  Plus,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  UserRound,
  Zap
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

const navItems = [
  { id: 'dashboard', label: '仪表盘', icon: Home },
  { id: 'workbench', label: 'Agent 工作台', icon: Bot },
  { id: 'sessions', label: '会话', icon: Activity },
  { id: 'monitor', label: '服务监控', icon: Monitor },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'logs', label: '日志', icon: FileText },
  { id: 'settings', label: '设置', icon: Settings }
];

const metricColors = {
  cpu: '#3b82f6',
  memory: '#2dd4bf',
  disk: '#8b5cf6',
  network: '#f59e0b',
  load: '#60a5fa'
};

function App() {
  const [view, setView] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [selectedProfileId, setSelectedProfileId] = useState('default');
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const [statusData, taskData, profileData] = await Promise.all([
        api('/api/status'),
        api('/api/tasks?limit=80'),
        api('/api/profiles')
      ]);
      setStatus(statusData);
      setTasks(taskData.tasks || []);
      setProfiles(profileData.profiles || []);
      const defaultProfile = (profileData.profiles || []).find((item) => item.isDefault) || profileData.profiles?.[0];
      if (defaultProfile && !selectedProfileId) setSelectedProfileId(defaultProfile.id);
      setHistory((items) => buildHistory(items, statusData));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const selectedTask = useMemo(() => tasks.find((item) => item.id === selectedTaskId) || tasks[0], [tasks, selectedTaskId]);
  const activeProfile = profiles.find((item) => item.id === selectedProfileId) || profiles.find((item) => item.isDefault) || profiles[0];

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} status={status} />
      <main className="main">
        <Topbar activeProfile={activeProfile} profiles={profiles} onProfileChange={setSelectedProfileId} onRefresh={refresh} error={error} />
        {view === 'dashboard' && <Dashboard status={status} tasks={tasks} history={history} onOpenTask={(id) => { setSelectedTaskId(id); setView('sessions'); }} />}
        {view === 'workbench' && <Workbench profiles={profiles} activeProfile={activeProfile} tasks={tasks} selectedTask={selectedTask} setSelectedTaskId={setSelectedTaskId} onRefresh={refresh} />}
        {view === 'sessions' && <Sessions tasks={tasks} selectedTask={selectedTask} setSelectedTaskId={setSelectedTaskId} />}
        {view === 'monitor' && <MonitorPage status={status} history={history} />}
        {view === 'terminal' && <TerminalPage activeProfile={activeProfile} />}
        {view === 'logs' && <LogsPage />}
        {view === 'settings' && <SettingsPage profiles={profiles} activeProfile={activeProfile} onRefresh={refresh} />}
      </main>
    </div>
  );
}

function Sidebar({ view, setView, status }) {
  return (
    <aside className="sidebar">
      <div className="brand"><Code2 /><span>Vibe Remote</span></div>
      <nav>
        {navItems.map((item) => {
          const Icon = item.icon;
          return <button className={view === item.id ? 'active' : ''} key={item.id} onClick={() => setView(item.id)}><Icon size={18} />{item.label}</button>;
        })}
      </nav>
      <div className="server-card">
        <span className="dot ok" />服务器状态
        <strong>{healthy(status) ? '运行中' : '检查中'}</strong>
        <small>uptime {formatDuration(status?.host?.uptime || 0)}</small>
        <Progress label="CPU" value={cpuPercent(status)} color={metricColors.cpu} />
        <Progress label="内存" value={status?.memory?.percent || 0} color={metricColors.memory} />
        <Progress label="磁盘" value={status?.disk?.percent || 0} color={metricColors.disk} />
      </div>
      <button className="quick-connect"><Terminal size={18} />快速连接</button>
    </aside>
  );
}

function Topbar({ activeProfile, profiles, onProfileChange, onRefresh, error }) {
  return (
    <header className="topbar">
      <div className="env-select"><Server size={18} />主服务器 · production <ChevronDown size={14} /></div>
      <div className="search"><Search size={16} /><input placeholder="搜索项目、会话、Agent 或命令..." /><kbd>⌘ K</kbd></div>
      <select value={activeProfile?.id || ''} onChange={(e) => onProfileChange(e.target.value)} className="profile-select">
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
      <button className="icon-btn" onClick={onRefresh} title="刷新"><RotateCw size={18} /></button>
      <button className="icon-btn" title="通知"><Bell size={18} /></button>
      <button className="icon-btn" title="帮助"><CircleHelp size={18} /></button>
      <div className="avatar"><UserRound size={18} /></div>
      {error && <div className="toast">{error}</div>}
    </header>
  );
}

function Dashboard({ status, tasks, history, onOpenTask }) {
  const running = tasks.filter((task) => task.status === 'running').length;
  const succeeded = tasks.filter((task) => task.status === 'succeeded').length;
  return (
    <section className="page">
      <PageTitle title="远程 Vibe Coding 控制台" subtitle="集中管理 Agent、会话与服务器资源" />
      <div className="metric-grid six">
        <Metric title="在线 Agent" value={String(running)} detail={`/ ${Math.max(tasks.length, 1)}`} icon={Bot} color={metricColors.cpu} data={history.map((h) => ({ value: h.cpu }))} />
        <Metric title="活跃会话" value={String(tasks.length)} detail={`成功 ${succeeded}`} icon={Activity} color={metricColors.memory} data={history.map((h) => ({ value: h.memory }))} />
        <Metric title="CPU" value={`${cpuPercent(status)}%`} detail={`${status?.host?.loadavg?.[0]?.toFixed?.(2) || '0.00'} load`} icon={Cpu} color={metricColors.cpu} data={history.map((h) => ({ value: h.cpu }))} />
        <Metric title="内存" value={`${status?.memory?.percent || 0}%`} detail={bytes(status?.memory?.used)} icon={MemoryStick} color={metricColors.memory} data={history.map((h) => ({ value: h.memory }))} />
        <Metric title="磁盘" value={`${status?.disk?.percent || 0}%`} detail={bytes(status?.disk?.used)} icon={HardDrive} color={metricColors.disk} data={history.map((h) => ({ value: h.disk }))} />
        <Metric title="网络" value={bytes(status?.network?.rx || 0)} detail="累计接收" icon={Network} color={metricColors.network} data={history.map((h) => ({ value: h.network }))} />
      </div>
      <div className="dashboard-grid">
        <Panel className="span-2" title="最近会话" action="查看全部">
          <TaskTable tasks={tasks.slice(0, 6)} onOpenTask={onOpenTask} />
        </Panel>
        <QuickActions />
        <ServiceSummary status={status} />
        <ResourcePanel history={history} />
        <Timeline tasks={tasks} />
      </div>
    </section>
  );
}

function Workbench({ profiles, activeProfile, tasks, selectedTask, setSelectedTaskId, onRefresh }) {
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('codex');
  const [cwd, setCwd] = useState('/home/ubuntu/projects');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ agent, prompt, cwd, title: title || prompt.slice(0, 32), project: projectName(cwd), profileId: activeProfile?.id })
      });
      setPrompt('');
      setTitle('');
      setSelectedTaskId(created.id);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page workbench">
      <PageTitle title={selectedTask?.title || 'Agent 工作台'} subtitle="提交任务、查看实时输出、在项目内终端辅助操作" />
      <div className="workbench-grid">
        <Panel title="项目文件">
          <FileTree />
        </Panel>
        <Panel className="conversation" title="对话">
          <form className="task-form" onSubmit={submit}>
            <div className="row">
              <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code via DeepSeek</option>
              </select>
              <select value={activeProfile?.id || ''} disabled>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题" />
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/ubuntu/projects" />
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想让 Agent 做什么..." />
            <div className="actions">
              <button className="primary" disabled={busy || !prompt.trim()}><Play size={16} />继续</button>
            </div>
          </form>
          <TaskDetail task={selectedTask} />
        </Panel>
        <Panel title="变更与输出">
          <TaskLive task={selectedTask} />
        </Panel>
        <Panel className="terminal-panel" title="终端">
          <TerminalView profileId={activeProfile?.id} cwd={cwd} compact />
        </Panel>
        <Panel title="会话指标">
          <SessionMetrics task={selectedTask} />
        </Panel>
      </div>
    </section>
  );
}

function Sessions({ tasks, selectedTask, setSelectedTaskId }) {
  return (
    <section className="page sessions">
      <PageTitle title="会话中心 / 会话详情" subtitle="管理与查看所有远程 Agent 会话" />
      <div className="session-grid">
        <Panel title="会话列表" className="session-list-panel">
          <TaskTable tasks={tasks} selectedId={selectedTask?.id} onOpenTask={setSelectedTaskId} />
        </Panel>
        <div className="session-detail">
          <Panel title={selectedTask?.title || '选择一个会话'}>
            <TaskDetail task={selectedTask} detailed />
          </Panel>
          <Panel title="终端 / 日志">
            <TaskLive task={selectedTask} />
          </Panel>
        </div>
      </div>
    </section>
  );
}

function MonitorPage({ status, history }) {
  return (
    <section className="page">
      <PageTitle title="服务器监控与运维概览" subtitle="实时监控服务器状态、服务运行情况与系统资源使用" />
      <div className="metric-grid six">
        <Metric title="CPU" value={`${cpuPercent(status)}%`} detail={`${status?.host?.cpus || 0} Core`} icon={Cpu} color={metricColors.cpu} data={history.map((h) => ({ value: h.cpu }))} />
        <Metric title="内存" value={`${status?.memory?.percent || 0}%`} detail={bytes(status?.memory?.total)} icon={MemoryStick} color={metricColors.memory} data={history.map((h) => ({ value: h.memory }))} />
        <Metric title="磁盘" value={`${status?.disk?.percent || 0}%`} detail={bytes(status?.disk?.total)} icon={HardDrive} color={metricColors.disk} data={history.map((h) => ({ value: h.disk }))} />
        <Metric title="网络" value={bytes(status?.network?.tx || 0)} detail="累计发送" icon={Network} color={metricColors.network} data={history.map((h) => ({ value: h.network }))} />
        <Metric title="负载" value={status?.host?.loadavg?.[0]?.toFixed?.(2) || '0.00'} detail="1m load" icon={Gauge} color={metricColors.load} data={history.map((h) => ({ value: h.load }))} />
        <Metric title="在线服务" value={`${activeServices(status)}`} detail="全部监听中" icon={ShieldCheck} color={metricColors.memory} data={history.map((h) => ({ value: activeServices(status) }))} />
      </div>
      <div className="monitor-grid">
        <ServiceTable status={status} />
        <Versions status={status} />
        <Ports status={status} />
        <ResourcePanel history={history} wide />
        <SystemInfo status={status} />
      </div>
    </section>
  );
}

function TerminalPage({ activeProfile }) {
  const [cwd, setCwd] = useState('/home/ubuntu/projects');
  return (
    <section className="page">
      <PageTitle title="项目终端" subtitle="在 /home/ubuntu/projects 内打开受控实时终端" />
      <Panel title="实时终端">
        <div className="terminal-toolbar">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
          <span className="badge">{activeProfile?.name || 'Default'}</span>
        </div>
        <TerminalView profileId={activeProfile?.id} cwd={cwd} />
      </Panel>
    </section>
  );
}

function LogsPage() {
  const [service, setService] = useState('vibe-coding');
  const [text, setText] = useState('');
  async function load() {
    const data = await api(`/api/logs?service=${encodeURIComponent(service)}&lines=220`);
    setText(data.text);
  }
  useEffect(() => { load(); }, [service]);
  return (
    <section className="page">
      <PageTitle title="日志" subtitle="查看允许列表内的 systemd 服务日志" />
      <Panel title="服务日志" action={<button className="ghost" onClick={load}><RotateCw size={16} />刷新</button>}>
        <div className="terminal-toolbar">
          <select value={service} onChange={(e) => setService(e.target.value)}>
            {['vibe-coding', 'anthropic-deepseek', 'litellm', 'mihomo', 'nginx'].map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <pre className="log-box">{text}</pre>
      </Panel>
    </section>
  );
}

function SettingsPage({ profiles, activeProfile, onRefresh }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-chat');
  const [login, setLogin] = useState(null);

  async function createProfile(event) {
    event.preventDefault();
    await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) });
    setName('');
    await onRefresh();
  }

  async function saveDeepSeek(event) {
    event.preventDefault();
    await api(`/api/profiles/${activeProfile.id}/deepseek`, { method: 'POST', body: JSON.stringify({ apiKey, baseUrl, model }) });
    setApiKey('');
    await onRefresh();
  }

  async function startLogin() {
    const data = await api(`/api/profiles/${activeProfile.id}/codex-login/start`, { method: 'POST', body: '{}' });
    setLogin({ sessionId: data.sessionId, output: '启动 Codex device login...\n' });
  }

  useEffect(() => {
    if (!login || !activeProfile) return;
    const timer = setInterval(async () => {
      const data = await api(`/api/profiles/${activeProfile.id}/codex-login/${login.sessionId}`);
      setLogin(data.session);
    }, 1500);
    return () => clearInterval(timer);
  }, [login?.sessionId, activeProfile?.id]);

  return (
    <section className="page">
      <PageTitle title="设置" subtitle="管理 Codex Profile、DeepSeek Key 与默认运行身份" />
      <div className="settings-grid">
        <Panel title="Profiles">
          <div className="profile-list">
            {profiles.map((profile) => (
              <div className="profile-row" key={profile.id}>
                <div><strong>{profile.name}</strong><small>{profile.id}</small></div>
                <div className="profile-state">
                  <span className={profile.codex.authenticated ? 'badge ok' : 'badge warn'}>Codex {profile.codex.authenticated ? '已登录' : '未登录'}</span>
                  <span className={profile.deepseek.keyPresent ? 'badge ok' : 'badge warn'}>DeepSeek {profile.deepseek.keyPresent ? profile.deepseek.keyMask : '未配置'}</span>
                </div>
              </div>
            ))}
          </div>
          <form className="inline-form" onSubmit={createProfile}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新 Profile 名称" />
            <button className="primary" disabled={!name.trim()}><Plus size={16} />新建</button>
          </form>
        </Panel>
        <Panel title="Codex 登录">
          <p className="muted">网页只发起 CLI device auth，不接收 OpenAI 密码。按终端输出打开链接并输入验证码。</p>
          <button className="primary" onClick={startLogin} disabled={!activeProfile}><KeyRound size={16} />启动 Codex 登录</button>
          <pre className="log-box small">{login?.output || '尚未启动登录流程'}</pre>
        </Panel>
        <Panel title="DeepSeek API">
          <form className="task-form" onSubmit={saveDeepSeek}>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="deepseek-chat">deepseek-chat</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
            </select>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="新的 DeepSeek API Key" />
            <button className="primary" disabled={!activeProfile}><ShieldCheck size={16} />保存到当前 Profile</button>
          </form>
        </Panel>
      </div>
    </section>
  );
}

function TerminalView({ profileId, cwd, compact = false }) {
  const ref = useRef(null);
  const socketRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !profileId) return undefined;
    ref.current.innerHTML = '';
    const term = new XTerm({ cursorBlink: true, fontSize: compact ? 12 : 13, theme: { background: '#060b12', foreground: '#d6e4ff' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/terminal?profileId=${encodeURIComponent(profileId)}&cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;
    socket.onopen = () => term.writeln(`connected: ${cwd}`);
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'data') term.write(msg.data);
      if (msg.type === 'error') term.writeln(`\r\nerror: ${msg.message}`);
      if (msg.type === 'exit') term.writeln(`\r\n[exit ${msg.exitCode ?? ''}]`);
    };
    term.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'data', data })));
    const onResize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      socket.close();
      term.dispose();
    };
  }, [profileId, cwd, compact]);
  return <div ref={ref} className={compact ? 'xterm-host compact' : 'xterm-host'} />;
}

function TaskLive({ task }) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    if (!task?.id) return undefined;
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/tasks/${task.id}`;
    const socket = new WebSocket(url);
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot') setEvents(msg.events || []);
      if (msg.type === 'event') setEvents((items) => [...items, msg.event]);
    };
    return () => socket.close();
  }, [task?.id]);
  const text = events.map((event) => event.text).filter(Boolean).join('');
  return <pre className="log-box">{text || '暂无实时输出'}</pre>;
}

function TaskTable({ tasks, selectedId, onOpenTask }) {
  return (
    <div className="table">
      {tasks.map((task) => (
        <button className={`table-row ${selectedId === task.id ? 'selected' : ''}`} key={task.id} onClick={() => onOpenTask(task.id)}>
          <span className="session-icon"><Bot size={18} /></span>
          <span><strong>{task.title || task.prompt?.slice(0, 28)}</strong><small>#{task.id} · {task.project || projectName(task.cwd)}</small></span>
          <span>{agentName(task.agent)}</span>
          <span>{relativeTime(task.createdAt)}</span>
          <Status status={task.status} />
        </button>
      ))}
      {!tasks.length && <p className="muted">暂无会话</p>}
    </div>
  );
}

function TaskDetail({ task, detailed = false }) {
  if (!task) return <p className="muted">暂无任务</p>;
  return (
    <div className="task-detail">
      <div className="detail-head"><h3>{task.title}</h3><Status status={task.status} /></div>
      <p>{task.prompt}</p>
      <div className="detail-grid">
        <Info label="Agent" value={agentName(task.agent)} />
        <Info label="Profile" value={task.profileId} />
        <Info label="工作区" value={task.cwd} />
        <Info label="开始时间" value={task.startedAt ? new Date(task.startedAt).toLocaleString() : '-'} />
        {detailed && <Info label="退出码" value={task.exitCode ?? '-'} />}
        {detailed && <Info label="错误" value={task.error || '-'} />}
      </div>
    </div>
  );
}

function QuickActions() {
  const actions = [
    [Plus, '新建会话', '创建一个新的 Agent 会话'],
    [Folder, '打开工作区', '浏览并打开项目工作区'],
    [Terminal, '启动终端', '打开新的终端会话'],
    [FileText, '查看日志', '查看系统与应用日志']
  ];
  return (
    <Panel title="快捷操作">
      <div className="quick-grid">{actions.map(([Icon, title, text]) => <button className="quick-card" key={title}><Icon /> <strong>{title}</strong><small>{text}</small></button>)}</div>
    </Panel>
  );
}

function ServiceSummary({ status }) {
  return (
    <Panel title="服务器服务状态">
      <div className="service-mini-grid">
        {Object.entries(status?.services || {}).map(([name, state]) => <ServicePill key={name} name={name} state={state} />)}
      </div>
    </Panel>
  );
}

function ServiceTable({ status }) {
  return (
    <Panel className="span-2" title="服务状态">
      <div className="service-table">
        {Object.entries(status?.services || {}).map(([name, state]) => (
          <div className="service-row" key={name}><span>{name}</span><span>systemd</span><Status status={state === 'active' ? 'running' : 'failed'} label={state} /><span>重启</span></div>
        ))}
      </div>
    </Panel>
  );
}

function ResourcePanel({ history, wide }) {
  return (
    <Panel className={wide ? 'span-2' : ''} title="资源监控">
      <Chart title="CPU 使用率 (%)" data={history} keyName="cpu" color={metricColors.cpu} />
      <Chart title="内存使用率 (%)" data={history} keyName="memory" color={metricColors.memory} />
    </Panel>
  );
}

function Versions({ status }) {
  return <Panel title="软件版本">{Object.entries(status?.versions || {}).map(([k, v]) => <Info key={k} label={k} value={v || '-'} />)}</Panel>;
}

function Ports({ status }) {
  return <Panel title="开放端口">{(status?.ports || []).slice(0, 10).map((p) => <Info key={p.local + p.process} label={p.local} value={p.process || p.state} />)}</Panel>;
}

function SystemInfo({ status }) {
  return (
    <Panel title="系统信息">
      <Info label="主机名" value={status?.host?.hostname} />
      <Info label="系统" value={`${status?.host?.platform || ''} ${status?.host?.release || ''}`} />
      <Info label="CPU 核心" value={status?.host?.cpus} />
      <Info label="运行时间" value={formatDuration(status?.host?.uptime || 0)} />
      <Info label="项目根目录" value={status?.projectsRoot} />
    </Panel>
  );
}

function Timeline({ tasks }) {
  return (
    <Panel title="活动时间线">
      <div className="timeline">
        {tasks.slice(0, 6).map((task) => <div className="timeline-item" key={task.id}><span /><strong>{task.title}</strong><small>{relativeTime(task.createdAt)} · {task.status}</small></div>)}
      </div>
    </Panel>
  );
}

function FileTree() {
  return (
    <div className="file-tree">
      {['/home/ubuntu/projects', 'default', 'src', 'tests', 'README.md', 'package.json'].map((item, index) => (
        <div style={{ paddingLeft: index > 1 ? 18 : 0 }} key={item}>{index < 4 ? <Folder size={15} /> : <FileText size={15} />}{item}</div>
      ))}
    </div>
  );
}

function SessionMetrics({ task }) {
  return (
    <div className="metric-stack">
      <Info label="运行时间" value={task?.startedAt ? relativeTime(task.startedAt) : '-'} />
      <Info label="状态" value={task?.status || '-'} />
      <Info label="Agent" value={task ? agentName(task.agent) : '-'} />
      <Info label="Profile" value={task?.profileId || '-'} />
    </div>
  );
}

function Metric({ title, value, detail, icon: Icon, color, data }) {
  return (
    <article className="metric">
      <div className="metric-head"><span style={{ color }}><Icon size={20} /></span><small>{title}</small></div>
      <strong>{value}</strong>
      <em>{detail}</em>
      <ResponsiveContainer height={34} width="100%">
        <LineChart data={data}><Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} /></LineChart>
      </ResponsiveContainer>
    </article>
  );
}

function Chart({ title, data, keyName, color }) {
  return (
    <div className="chart">
      <div className="chart-title">{title}<strong>{Math.round(data.at(-1)?.[keyName] || 0)}%</strong></div>
      <ResponsiveContainer height={120} width="100%">
        <AreaChart data={data}>
          <defs><linearGradient id={`g-${keyName}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={color} stopOpacity={0.35}/><stop offset="95%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid stroke="#223149" strokeDasharray="3 3" />
          <XAxis dataKey="time" stroke="#789" fontSize={11} />
          <YAxis stroke="#789" fontSize={11} domain={[0, 100]} />
          <Tooltip contentStyle={{ background: '#0b1624', border: '1px solid #26364e' }} />
          <Area type="monotone" dataKey={keyName} stroke={color} fill={`url(#g-${keyName})`} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Panel({ title, action, className = '', children }) {
  return <article className={`panel ${className}`}><div className="panel-head"><h2>{title}</h2>{typeof action === 'string' ? <button className="link-btn">{action}</button> : action}</div>{children}</article>;
}

function PageTitle({ title, subtitle }) {
  return <div className="page-title"><h1>{title}</h1><p>{subtitle}</p></div>;
}

function Info({ label, value }) {
  return <div className="info"><span>{label}</span><strong>{String(value ?? '-')}</strong></div>;
}

function Status({ status, label }) {
  const cls = ['failed', 'cancelled', 'inactive', 'unknown'].includes(status) ? 'danger' : status === 'succeeded' || status === 'active' ? 'ok' : status === 'running' ? 'ok' : 'warn';
  return <span className={`badge ${cls}`}>{label || status}</span>;
}

function ServicePill({ name, state }) {
  return <div className="service-pill"><span className={state === 'active' ? 'dot ok' : 'dot warn'} />{name}<Status status={state === 'active' ? 'active' : 'failed'} label={state} /></div>;
}

function Progress({ label, value, color }) {
  return <div className="progress"><div><span>{label}</span><span>{value}%</span></div><i><b style={{ width: `${value}%`, background: color }} /></i></div>;
}

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function buildHistory(items, status) {
  const item = {
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu: cpuPercent(status),
    memory: status?.memory?.percent || 0,
    disk: status?.disk?.percent || 0,
    network: Math.min(100, Math.round(((status?.network?.rx || 0) / 1024 / 1024) % 100)),
    load: Math.min(100, Math.round((status?.host?.loadavg?.[0] || 0) * 20))
  };
  return [...items.slice(-23), item];
}

function cpuPercent(status) {
  const load = status?.host?.loadavg?.[0] || 0;
  const cores = status?.host?.cpus || 1;
  return Math.min(100, Math.round((load / cores) * 100));
}

function activeServices(status) {
  return Object.values(status?.services || {}).filter((item) => item === 'active').length;
}

function healthy(status) {
  return status && activeServices(status) >= 3;
}

function bytes(value = 0) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i += 1; }
  return `${size.toFixed(size >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function relativeTime(value) {
  if (!value) return '-';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days} 天 ${hours} 小时`;
}

function projectName(cwd = '') {
  return cwd.split('/').filter(Boolean).at(-1) || 'projects';
}

function agentName(agent) {
  return agent === 'claude' ? 'Claude Code' : 'Codex';
}

createRoot(document.getElementById('root')).render(<App />);
