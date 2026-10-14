import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface FileAccessSettings {
  externalFileAccess?: 'deny' | 'ask';
  externalReadDirs?: string[];
  skillDirs?: string[];
}

export const standardSkillRoot = (): string => join(homedir(), '.agents', 'skills');

/** Validate before persisting: relative paths must never silently grant cwd. */
export function directoryList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('目录列表最多允许 100 项');
  const dirs = value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0')) throw new Error('目录路径无效');
    const text = item.trim();
    const expanded = /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text;
    if (!isAbsolute(expanded)) throw new Error('请填写绝对目录路径，或使用 ~/ 开头的用户目录');
    return resolve(expanded);
  });
  return [...new Map(dirs.map((dir) => [process.platform === 'win32' ? dir.toLowerCase() : dir, dir])).values()];
}

export function validateFileAccessPatch(value: FileAccessSettings): FileAccessSettings {
  if (value.externalFileAccess !== undefined && value.externalFileAccess !== 'ask' && value.externalFileAccess !== 'deny') {
    throw new Error('外部文件访问方式无效');
  }
  return {
    ...(value.externalFileAccess !== undefined ? { externalFileAccess: value.externalFileAccess } : {}),
    ...(value.externalReadDirs !== undefined ? { externalReadDirs: directoryList(value.externalReadDirs) } : {}),
    ...(value.skillDirs !== undefined ? { skillDirs: directoryList(value.skillDirs) } : {}),
  };
}
