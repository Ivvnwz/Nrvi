import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const logDirectory = path.join(serverDirectory, 'logs');
const logFile = path.join(logDirectory, 'nrvi.log');
const MAX_VALUE_LENGTH = 2000;

const limitValue = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return text;
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
};

export async function writeLog(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details
  };

  try {
    await mkdir(logDirectory, { recursive: true });
    await appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[NRVI] No se pudo escribir el log:', error.message);
  }
}

export const logFilePath = logFile;
export const safeLogValue = limitValue;
