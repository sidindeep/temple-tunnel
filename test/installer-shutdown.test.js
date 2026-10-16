const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const run = promisify(execFile);
const project = path.resolve(__dirname, '..');

test('installer shutdown closes gracefully, stops hung descendants and preserves unrelated apps', { skip: process.platform !== 'win32' }, async () => {
  const diagnostics = path.join(project, 'diagnostics');
  await fs.mkdir(diagnostics, { recursive: true });
  const root = await fs.mkdtemp(path.join(diagnostics, 'installer-shutdown-'));
  const image = `Temple Installer Fixture-${path.basename(root)}.exe`;
  const fixture = path.join(root, image);
  const decoy = path.join(root, 'UnrelatedInstallerFixture.exe');
  const childFixture = path.join(root, 'BundledCoreFixture.exe');
  const processes = [];
  const alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  try {
    const source = path.join(root, 'fixture.cs');
    await fs.writeFile(source, `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
class FixtureForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x80; return value; } }
}
class Fixture {
  [STAThread] static void Main(string[] args) {
    if (args[0] == "child") { Thread.Sleep(Timeout.Infinite); return; }
    var child = Process.Start(new ProcessStartInfo(args[2], "child") { UseShellExecute = false, CreateNoWindow = true });
    var form = new FixtureForm { Text = "Installer shutdown fixture", Opacity = 0, StartPosition = FormStartPosition.Manual, Left = -30000, Top = -30000 };
    form.Shown += (sender, e) => File.WriteAllText(args[1], child.Id.ToString());
    form.FormClosing += (sender, e) => { if (args[0] == "hung") e.Cancel = true; };
    form.FormClosed += (sender, e) => { if (args[0] != "orphan") { child.Kill(); child.WaitForExit(1000); } File.WriteAllText(args[1] + ".closed", "graceful"); };
    Application.Run(form);
  }
}`);
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -Path ${quote(source)} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${quote(fixture)} -OutputType WindowsApplication`],
    { windowsHide: true, timeout: 15000 });
    await fs.copyFile(fixture, decoy);
    await fs.copyFile(fixture, childFixture);
    // Execute the real compiled NSIS hook, including its embedded-file path and
    // nsExec command. Testing only the source PowerShell helper misses packaging.
    const rb = createRequire(require.resolve('electron-builder'));
    const ar = createRequire(rb.resolve('app-builder-lib'));
    const nsisTools = ar('./toolsets/windows.js');
    const [compiler, plugins] = await Promise.all([nsisTools.getMakeNsisPath(), nsisTools.getNsisPluginsPath()]);
    const includes = path.join(path.dirname(rb.resolve('app-builder-lib')), '../templates/nsis/include');
    const nativeSetup = path.join(root, 'shutdown-hook.exe');
    const installTarget = path.join(root, 'installation-target');
    const success = path.join(root, 'nsis-success.txt');
    const nativeScript = path.join(root, 'shutdown-hook.nsi');
    await fs.writeFile(nativeScript, `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
OutFile "${nativeSetup}"
!addincludedir "${includes}"
!addplugindir /x86-unicode "${path.join(plugins, 'x86-unicode')}"
!include "LogicLib.nsh"
!include "nsProcess.nsh"
!define APP_EXECUTABLE_FILENAME "${image}"
!define PRODUCT_NAME "Installer fixture"
!define BUILD_RESOURCES_DIR "${path.join(project, 'build')}"
!include "${path.join(project, 'build/installer.nsh')}"
Section
  SetOutPath "${installTarget}"
  !insertmacro customCheckAppRunning
  FileOpen $0 "${success}" w
  FileWrite $0 "$OUTDIR"
  FileClose $0
  SetErrorLevel 0
SectionEnd
`);
    await run(compiler.path, ['/V2', nativeScript], { windowsHide: true, timeout: 10000, env: { ...process.env, ...compiler.env } });
    const unrelated = spawn(decoy, ['child'], { windowsHide: true, stdio: 'ignore' });
    processes.push(unrelated.pid);
    for (const mode of ['normal', 'nsis', 'hung', 'orphan']) {
      const marker = path.join(root, `${mode}.ready`);
      // The off-screen, transparent form never activates. SW_HIDE would prevent
      // Windows from identifying it as a main window for CloseMainWindow.
      const app = spawn(fixture, [mode, marker, childFixture], { stdio: 'ignore' });
      processes.push(app.pid);
      let childPid;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { childPid = Number(await fs.readFile(marker, 'utf8')); break; } catch { await delay(50); }
      }
      assert.ok(childPid, 'Fixture window did not become ready');
      processes.push(childPid);
      const window = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${app.pid}).MainWindowHandle.ToInt64()`], { windowsHide: true, timeout: 5000 });
      assert.ok(Number(window.stdout.trim()), 'Fixture did not expose a closeable main window');
      if (mode === 'nsis') {
        await run(nativeSetup, ['/S'], { windowsHide: true, timeout: 25000 });
        assert.equal(await fs.readFile(success, 'utf8'), installTarget);
        await assert.rejects(fs.access(path.join(installTarget, 'temple-close-app.ps1')));
      } else {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(project, 'build/close-app.ps1'), '-ProcessName', image, '-GracefulTimeoutSeconds', '1'],
        { windowsHide: true, timeout: 20000 });
        assert.match(stdout, /Application stopped/);
      }
      assert.equal(alive(app.pid), false, `${mode} parent remains running`);
      assert.equal(alive(childPid), false, `${mode} child remains running`);
      assert.equal(alive(unrelated.pid), true, 'Unrelated app was terminated');
      if (mode !== 'hung') assert.equal(await fs.readFile(`${marker}.closed`, 'utf8'), 'graceful');
      else await assert.rejects(fs.access(`${marker}.closed`));
    }
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(project, 'build/close-app.ps1'), '-ProcessName', image], { windowsHide: true, timeout: 10000 });
    assert.match(stdout, /Application stopped/);
    assert.equal(alive(unrelated.pid), true);
  } finally {
    for (const pid of processes) { try { process.kill(pid); } catch {} }
    await delay(200);
    assert.ok(root.startsWith(`${diagnostics}${path.sep}`));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
