import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { chmod,link,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorialPrivateImageStore,editorialPrivateImageKey } from './editorial-private-image';

const id='11111111-1111-4111-8111-111111111111';
const key=editorialPrivateImageKey(id);
const data=Buffer.from('ffd8ffd9','hex');
describe('editorial private bytes (filesystem isolation, not image decoder)',()=>{
 let base:string,root:string,uploads:string;
 beforeEach(async()=>{
  base=await mkdtemp(join(tmpdir(),'ed-private-'));
  root=join(base,'private');uploads=join(base,'uploads');
  await mkdir(root,{mode:0o700});await mkdir(uploads,{mode:0o700});
 });
 afterEach(async()=>{await rm(base,{recursive:true,force:true});});
 it('exclusive immutable key; no bytes in public upload tree',async()=>{
  const store=await EditorialPrivateImageStore.open(root,uploads);
  expect(await store.write(id,data)).toBe(key);
  expect(await store.read(key,data.length)).toEqual(data);
  expect(await readFile(join(root,id+'.jpg'))).toEqual(data);
  expect(await readdir(uploads)).toEqual([]);
  await expect(store.write(id,Buffer.from('changed'))).rejects.toThrow();
  expect(await store.read(key,data.length)).toEqual(data);
 });
 it('rejects public overlap, aliases, missing roots and broad permissions',async()=>{
  const child=join(uploads,'private');await mkdir(child,{mode:0o700});
  await expect(EditorialPrivateImageStore.open(child,uploads)).rejects.toThrow();
  await expect(EditorialPrivateImageStore.open(base,uploads)).rejects.toThrow();
  const alias=join(base,'alias');await symlink(root,alias);
  await expect(EditorialPrivateImageStore.open(alias,uploads)).rejects.toThrow();
  await expect(EditorialPrivateImageStore.open(root,alias)).rejects.toThrow();
  await expect(EditorialPrivateImageStore.open(join(base,'missing'),uploads)).rejects.toThrow();
  await chmod(root,0o755);
  await expect(EditorialPrivateImageStore.open(root,uploads)).rejects.toThrow();
 });
 it('rejects public URLs, traversal, encoded names, symlinks, hardlinks, incorrect size and permissions',async()=>{
  const store=await EditorialPrivateImageStore.open(root,uploads);
  for(const invalid of ['/uploads/'+id+'.jpg','https://example.invalid/'+id+'.jpg',
    'editorial-private:v1:../'+id+'.jpg','editorial-private:v1:%2e%2e%2f'+id+'.jpg',key+'?x=1']){
   await expect(store.read(invalid,4)).rejects.toThrow();
  }
  const outside=join(uploads,'source.jpg');await writeFile(outside,data,{mode:0o600});
  const dest=join(root,id+'.jpg');await symlink(outside,dest);
  await expect(store.read(key,4)).rejects.toThrow();
  await expect(store.write(id,data)).rejects.toThrow();
  await rm(dest);await link(outside,dest);
  await expect(store.read(key,4)).rejects.toThrow();
  await rm(dest);await store.write(id,data);
  await expect(store.read(key,5)).rejects.toThrow();
  await expect(store.read(key,8*1024*1024+1)).rejects.toThrow();
  await chmod(dest,0o644);
  await expect(store.read(key,4)).rejects.toThrow();
 });
});
