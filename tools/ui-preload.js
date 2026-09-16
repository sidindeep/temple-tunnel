const { contextBridge } = require('electron');

const selectedApplications = [
  { name: 'Telegram', processName: 'Telegram.exe', path: '', custom: false },
  { name: 'ChatGPT', processName: 'ChatGPT.exe', path: '', custom: false }
];
const bypassApplications = [
  { name: 'Example Game', processName: 'ExampleGame.exe', path: 'C:\\Apps\\ExampleGame.exe', custom: true }
];

let mockState = {
  subscriptionConfigured: true,
  subscriptions: [
    { id: 'primary', name: 'Основная', serverCount: 3, active: true, metadata: {upload:1073741824,download:2147483648,total:10737418240,expire:1800000000},updatedAt:Date.now() },
    { id: 'backup', name: 'Резервная', serverCount: 2, active: false }
  ],
  activeSubscriptionId: 'primary',
  servers: [
    { id: 'two', name: '🇫🇮 Финляндия', host: 'fi.example.test', port: 443, transport: 'grpc', security: 'reality', supported: true, latencyStatus: 'ok', latencyMs: 92, latencyKind: 'endpoint' },
    { id: 'three', name: 'XHTTP Preview', host: 'xhttp.example.test', port: 8443, transport: 'xhttp', security: 'reality', supported: true, latencyStatus: 'pending', latencyMs: null, latencyKind: 'endpoint' },
    { id: 'one', name: '🇳🇱 Нидерланды', host: 'nl.example.test', port: 443, transport: 'tcp', security: 'reality', supported: true, latencyStatus: 'ok', latencyMs: 48, latencyKind: 'tunnel' }
  ],
  selectedServerId: 'one',
  applications: selectedApplications,
  suggestedApplications: [
    { name: 'Telegram', processName: 'Telegram.exe', glyph: 'T' },
    { name: 'WhatsApp', processName: 'WhatsApp.exe', glyph: 'W' },
    { name: 'Discord', processName: 'Discord.exe', glyph: 'D' },
    { name: 'Claude', processName: 'Claude.exe', glyph: 'C' },
    { name: 'ChatGPT', processName: 'ChatGPT.exe', glyph: 'G' },
    { name: 'Codex', processName: 'Codex.exe', glyph: '⌘' },
    { name: 'Cursor', processName: 'Cursor.exe', glyph: 'C' },
    { name: 'Slack', processName: 'slack.exe', glyph: 'S' }
  ],
  mode: 'selected',
  status: 'disconnected',
  error: '',
  warning: 'Сервер недоступен. Через 2 секунды переключимся на резервный.',
  recovering: true,
  logs: []
};

contextBridge.exposeInMainWorld('temple', {
  getState: async () => mockState,
  setSubscription: async (subscription) => {
    const id = `subscription-${mockState.subscriptions.length + 1}`;
    mockState.subscriptions = mockState.subscriptions
      .map((item) => ({ ...item, active: false }))
      .concat({ id, name: subscription.name || `Подписка ${mockState.subscriptions.length + 1}`, serverCount: 1, active: true });
    mockState.activeSubscriptionId = id;
    return mockState;
  },
  updateSubscription: async (subscription) => {
    mockState.subscriptions = mockState.subscriptions.map((item) => item.id === subscription.id
      ? { ...item, name: subscription.name || item.name }
      : item);
    return mockState;
  },
  deleteSubscription: async (id) => {
    mockState.subscriptions = mockState.subscriptions.filter((item) => item.id !== id);
    if (mockState.activeSubscriptionId === id) {
      mockState.activeSubscriptionId = mockState.subscriptions[0]?.id || '';
    }
    mockState.subscriptions = mockState.subscriptions.map((item) => ({
      ...item,
      active: item.id === mockState.activeSubscriptionId
    }));
    return mockState;
  },
  selectSubscription: async (id) => {
    mockState.activeSubscriptionId = id;
    mockState.subscriptions = mockState.subscriptions.map((item) => ({ ...item, active: item.id === id }));
    return mockState;
  },
  organizeSubscriptions: async (change) => {
    mockState.subscriptions = change.ids ? change.ids.map(id => mockState.subscriptions.find(s => s.id === id))
      : mockState.subscriptions.map(s => s.id === change.id ? {...s,hidden:change.hidden} : s);
    return mockState;
  },
  refreshSubscription: async () => mockState,
  importSubscriptionFile: async image => ({source:image?'https://example.com/qr':'vless://one\nvless://two',report:'Распознано: 2.'}),
  diagnoseNetwork: async () => 'Выход VPN: доступен. DNS через VPN: работает.',
  installUpdate: async () => 'Подпись проверена.',
  rollbackUpdate: async () => 'Предыдущая версия восстановлена.',
  pingServers: async () => mockState,
  cancelRecovery: async () => {
    mockState = { ...mockState, status: 'disconnected', warning: 'Автоматическое переподключение остановлено пользователем.', recovering: false };
    return mockState;
  },
  addApplications: async () => mockState,
  removeApplication: async () => mockState,
  toggleApplication: async () => mockState,
  updateSettings: async (update) => {
    if (update.customRouting) update = {...update, customRouting:Object.fromEntries(Object.entries(update.customRouting).map(([key,value])=>[key,String(value).split('\n').filter(Boolean)]))};
    if (update.selectedServerId) update = { ...update, connectionStrategy: 'manual' };
    mockState = { ...mockState, ...update };
    if (update.mode) {
      mockState.applications = update.mode === 'bypass' ? bypassApplications : selectedApplications;
    }
    return mockState;
  },
  toggleTunnel: async () => {
    const active = ['connecting', 'connected', 'reconnecting', 'disconnecting'].includes(mockState.status);
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockState = { ...mockState, status: active ? 'disconnected' : 'connected', error: '' };
    return mockState;
  },
  openLogs: async () => '',
  exportLogs: async () => '',
  onStateChanged: () => {}
});
