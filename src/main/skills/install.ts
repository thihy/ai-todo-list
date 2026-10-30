import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { standardSkillRoot } from '../dsh/file-access';

export async function installLocalSkill(source: string, destinationRoot = standardSkillRoot()): Promise<{ name: string; path: string }> {
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('请选择 Skill 文件夹的绝对路径');
  const directory = realpathSync(source);
  if (!lstatSync(directory).isDirectory() || !existsSync(join(directory, 'SKILL.md'))) throw new Error('文件夹中没有 SKILL.md');
  let files = 0; let bytes = 0;
  const check = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Skill 包不能包含符号链接或 junction，请复制实际文件后安装');
    if (++files > 2000 || (bytes += stat.size) > 20 * 1024 * 1024) throw new Error('Skill 包过大（最多 2000 项、20 MB）');
    if (stat.isDirectory()) for (const entry of readdirSync(path)) check(join(path, entry));
    else if (!stat.isFile()) throw new Error('Skill 包包含不支持的文件类型');
  };
  check(directory);
  const provider = new FileSystemSkillProvider({ get: () => undefined, logger: { warn: () => {} } } as never,
    { invalidate: () => {}, signal: new AbortController().signal } as never,
    { includeDefaultRoots: false, customSkillDirs: [dirname(directory)], watch: false });
  let name: string;
  try {
    const listing = await provider.list({});
    const candidates = Array.isArray(listing) ? listing : listing.candidates;
    const candidate = candidates.find((item) => item.path && resolve(dirname(item.path)) === directory);
    if (!candidate || !await provider.get(candidate, {})) throw new Error('DSH 无法识别此 Skill，请检查 SKILL.md 的 name 和 description');
    name = candidate.name;
  } finally { await provider.dispose(); }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Skill 名称无效');
  mkdirSync(destinationRoot, { recursive: true });
  const destination = join(destinationRoot, name);
  if (existsSync(destination)) throw new Error(`Skill ${name} 已存在，未覆盖`);
  const temporary = resolve(destinationRoot, `.install-${basename(directory)}-${randomUUID()}`);
  if (!temporary.startsWith(resolve(destinationRoot) + sep)) throw new Error('安装临时目录无效');
  try {
    cpSync(directory, temporary, { recursive: true, errorOnExist: true, force: false, dereference: false });
    files = 0; bytes = 0;
    check(temporary);
    if (existsSync(destination)) throw new Error(`Skill ${name} 已存在，未覆盖`);
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return { name, path: destination };
}
