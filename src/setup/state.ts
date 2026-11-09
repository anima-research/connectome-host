import { readWithoutWaiting } from '../update/contract.js';

export interface SetupState {
  v: 1;
  shell: boolean;
  finished?: string;
}

export type KeptState = { state: SetupState } | { unreadable: string } | { absent: true };

export function readSetupState(path: string): KeptState {
  let text: string;
  try {
    text = readWithoutWaiting(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    return { unreadable: (error as Error).message };
  }
  let state: Partial<SetupState> | null;
  try {
    state = JSON.parse(text) as Partial<SetupState> | null;
  } catch {
    return { unreadable: 'it isn\'t JSON' };
  }
  if (state?.v !== 1 || typeof state.shell !== 'boolean' || (state.finished !== undefined && !isStamp(state.finished))) {
    return { unreadable: 'it isn\'t the answers this setup keeps' };
  }
  return { state: state as SetupState };
}

function isStamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}
