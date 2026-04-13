import { open, rename, unlink } from "node:fs/promises";

export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const fd = await open(tmp, "w");
  try {
    await fd.writeFile(content, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function appendLineSynced(path: string, line: string): Promise<void> {
  const fd = await open(path, "a");
  try {
    await fd.writeFile(line, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
}
