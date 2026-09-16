// Run with Electron to preview the disconnect notice without touching the running VPN.
const { app, Notification } = require('electron');
const path = require('node:path');
const { createConnectionNotices } = require('../src/connection-notices');

app.setPath('userData', path.join(app.getPath('temp'), 'temple-notification-preview'));
app.setAppUserModelId('local.templetunnel.app');
let notification;
app.whenReady().then(() => {
  if (!Notification.isSupported()) {
    console.error('Notifications are not supported');
    app.exit(1);
    return;
  }
  const notices = createConnectionNotices((title, body) => {
    notification = new Notification({ title: `Тест: ${title}`, body });
    notification.on('show', () => console.log('Notification shown'));
    notification.on('failed', (_event, error) => {
      console.error('Notification failed:', error);
      app.exit(1);
    });
    notification.show();
  });
  notices.connected('Тест');
  notices.stopped();
  setTimeout(() => app.quit(), 15000);
});
