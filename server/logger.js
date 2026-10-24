import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const logDirectory = path.join(serverDirectory, 'logs');
const logFile = path.join(logDirectory, 'nrvi.log');
const errorLogFile = path.join(logDirectory, 'nrvi-errors.log');
const conversationLogFile = path.join(logDirectory, 'nrvi-conversations.log');
const MAX_VALUE_LENGTH = 2000;
const MAX_SESSION_LOG_CHARACTERS = 2000;
const MAX_SESSION_LOG_AGE_MS = 5 * 60 * 1000;

let activeSessionId = null;
let sessionCharacters = 0;
let sessionLogStartedAt = 0;
let logQueue = Promise.resolve();

const limitValue = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return text;
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
};

const ensureLogDirectory = () => mkdir(logDirectory, { recursive: true });

const resetSessionLog = async sessionId => {
  activeSessionId = sessionId || activeSessionId;
  sessionCharacters = 0;
  sessionLogStartedAt = Date.now();
  await ensureLogDirectory();
  await writeFile(logFile, '', 'utf8');
};

const errorSignature = (event, details) => [
  event,
  details.provider || '',
  details.status || '',
  details.error || ''
].join('|');

const updatePersistentError = async (entry, details) => {
  await ensureLogDirectory();
  let entries = [];
  try {
    const content = await readFile(errorLogFile, 'utf8');
    entries = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const signature = errorSignature(entry.event, details);
  const existing = entries.find(item => item.signature === signature && item.sessionId === entry.sessionId);
  if (existing) {
    existing.count += 1;
    existing.lastTimestamp = entry.timestamp;
  } else {
    entries.push({
      timestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
      sessionId: entry.sessionId || 'unassigned',
      signature,
      count: 1,
      level: entry.level,
      event: entry.event,
      ...details
    });
  }
  await writeFile(errorLogFile, `${entries.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');
};

const writeEntry = async (level, event, details = {}) => {
  const sessionId = details.sessionId || activeSessionId;
  if (sessionId && !activeSessionId) {
    activeSessionId = sessionId;
  }
  if (!sessionLogStartedAt) sessionLogStartedAt = Date.now();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
    ...(sessionId ? { sessionId } : {})
  };
  const serialized = `${JSON.stringify(entry)}\n`;
  if (
    sessionCharacters + serialized.length > MAX_SESSION_LOG_CHARACTERS
    || (sessionLogStartedAt && Date.now() - sessionLogStartedAt >= MAX_SESSION_LOG_AGE_MS)
  ) {
    await resetSessionLog(sessionId);
  }
  await appendFile(logFile, serialized, 'utf8');
  sessionCharacters += serialized.length;
  if (level === 'error' || level === 'warn') await updatePersistentError(entry, details);
};

const writeConversationEntry = async (event, details = {}) => {
  await ensureLogDirectory();
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...details
  };
  await appendFile(conversationLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
};

export function writeLog(level, event, details = {}) {
  logQueue = logQueue
    .then(() => writeEntry(level, event, details))
    .catch(error => console.error('[NRVI] No se pudo escribir el log:', error.message));
  return logQueue;
}

export function endLogSession(sessionId) {
  logQueue = logQueue.then(async () => {
    if (!sessionId || sessionId === activeSessionId) activeSessionId = null;
  }).catch(error => console.error('[NRVI] No se pudo cerrar el log:', error.message));
  return logQueue;
}

export const logFilePath = logFile;
export const errorLogFilePath = errorLogFile;
export const conversationLogFilePath = conversationLogFile;
export const safeLogValue = limitValue;
export function writeConversationLog(event, details = {}) {
  logQueue = logQueue
    .then(() => writeConversationEntry(event, details))
    .catch(error => console.error('[NRVI] No se pudo escribir la conversación:', error.message));
  return logQueue;
}
