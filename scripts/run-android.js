const { spawn } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function appleScriptQuote(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\\\"');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function startMetro() {
  let metro;

  if (process.platform === 'darwin') {
    const command = `cd ${shellQuote(projectRoot)} && pnpm start`;
    const script = `tell application "Terminal" to do script "${appleScriptQuote(command)}"`;
    metro = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    metro = spawn(
      'cmd.exe',
      ['/d', '/c', 'start', '""', 'cmd.exe', '/d', '/k', 'pnpm start'],
      {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    );
  } else {
    metro = spawn(pnpmCommand, ['start'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'inherit',
    });
  }

  metro.on('error', error => {
    console.error(`No se pudo iniciar Metro: ${error.message}`);
  });
  metro.unref();
}

startMetro();

const android = spawn(
  pnpmCommand,
  ['exec', 'react-native', 'run-android', '--no-packager', ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: false,
    shell: process.platform === 'win32',
  },
);

android.on('error', error => {
  console.error(`No se pudo ejecutar React Native Android: ${error.message}`);
  process.exitCode = 1;
});

android.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
