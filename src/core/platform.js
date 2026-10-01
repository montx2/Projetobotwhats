// Detecção de plataforma: Termux, Linux, Windows ou macOS.
// No Termux o pareamento é SEMPRE por código (sem QR Code).

export function detectPlatform() {
  if (
    process.env.TERMUX_VERSION ||
    String(process.env.PREFIX || '').includes('com.termux') ||
    String(process.env.HOME || '').includes('com.termux') ||
    String(process.env.PREFIX_PATH || '').includes('com.termux')
  ) {
    return 'termux';
  }
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

export const PLATFORM = detectPlatform();

export const isTermux = () => PLATFORM === 'termux';
export const isWindows = () => PLATFORM === 'windows';

export const PLATFORM_LABEL = {
  termux: '🤖 Termux (Android)',
  windows: '🪟 Windows',
  macos: '🍎 macOS',
  linux: '🐧 Linux'
};

export function platformBanner() {
  const label = PLATFORM_LABEL[PLATFORM] || PLATFORM;
  return `${label} · Node ${process.version}`;
}
