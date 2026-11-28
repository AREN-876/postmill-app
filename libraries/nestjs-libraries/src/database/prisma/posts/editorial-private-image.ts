import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const EDITORIAL_PRIVATE_IMAGE_ROOT = '/var/lib/postmill/editorial-private';
export const EDITORIAL_PRIVATE_IMAGE_PREFIX = 'editorial-private:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 8 * 1024 * 1024;
function denied(): never { throw new Error('editorial_private_storage_unavailable'); }
function inside(root: string, candidate: string): boolean {
  const rel = relative(root,candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function editorialPrivateImageKey(importId: string): string {
  if (!UUID.test(importId)) denied();
  return EDITORIAL_PRIVATE_IMAGE_PREFIX + importId + '.jpg';
}

// No general StorageCapability interface, no URL or generic list/delete.
// Root is provisioned by the operator, never created on an import request.
// Only explicit isolated tests supply alternate roots. Same-UID trusted
// processes and the administrator are outside the filesystem threat boundary.
export class EditorialPrivateImageStore {
  private constructor(private readonly root: string, private readonly dev: number,
    private readonly ino: number, private readonly uid: number) {}

  static async open(root = EDITORIAL_PRIVATE_IMAGE_ROOT,
    uploadRoot = resolve(process.env.UPLOAD_DIRECTORY || './uploads')) {
    if (!isAbsolute(root) || resolve(root) !== root || root === '/') denied();
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0 || await realpath(root) !== root) denied();
    // The production nginx alias is literal /uploads even when the adapter
    // is misconfigured. Check both canonical and configured public roots.
    for (const publicRoot of ['/uploads',resolve(uploadRoot)]) {
      const actual = await realpath(publicRoot).catch(() => publicRoot);
      for (const p of [publicRoot,actual]) {
        if (inside(p,root) || inside(root,p)) denied();
      }
    }
    const st = await lstat(root);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid ||
        (st.mode & 0o7777) !== 0o700) denied();
    return new EditorialPrivateImageStore(root,st.dev,st.ino,uid);
  }

  private async assertRoot() {
    const st = await lstat(this.root);
    if (await realpath(this.root) !== this.root || !st.isDirectory() ||
        st.dev !== this.dev || st.ino !== this.ino || st.uid !== this.uid ||
        (st.mode & 0o7777) !== 0o700) denied();
  }

  private path(key: string): string {
    if (typeof key !== 'string' || !key.startsWith(EDITORIAL_PRIVATE_IMAGE_PREFIX) ||
        !key.endsWith('.jpg')) denied();
    const id = key.slice(EDITORIAL_PRIVATE_IMAGE_PREFIX.length,-4);
    if (editorialPrivateImageKey(id) !== key) denied();
    return join(this.root,id+'.jpg');
  }

  async write(importId: string, bytes: Buffer): Promise<string> {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > LIMIT) denied();
    const key = editorialPrivateImageKey(importId);
    await this.assertRoot();
    // Exclusive creation: no overwrite, no automatic cleanup/retry after an
    // uncertain write. fsync both file and directory before reporting success.
    const fd = await open(this.path(key),constants.O_WRONLY|constants.O_CREAT|
      constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally { await fd.close(); }
    const dir = await open(this.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
    await this.assertRoot();
    return key;
  }

  async read(key: string, size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 4 || size > LIMIT) denied();
    await this.assertRoot();
    const fd = await open(this.path(key),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const st = await fd.stat();
      if (!st.isFile() || st.nlink !== 1 || st.uid !== this.uid ||
          (st.mode & 0o7777) !== 0o600 || st.size !== size) denied();
      const bytes = Buffer.alloc(size);
      let pos=0;
      while (pos<size) {
        const result=await fd.read(bytes,pos,size-pos,pos);
        if (!result.bytesRead) denied();
        pos+=result.bytesRead;
      }
      const end=await fd.stat();
      if (end.size!==size || end.mtimeMs!==st.mtimeMs || end.ctimeMs!==st.ctimeMs ||
          end.nlink!==1 || (end.mode & 0o7777)!==0o600) denied();
      await this.assertRoot();
      return bytes;
    } finally { await fd.close(); }
  }
}
