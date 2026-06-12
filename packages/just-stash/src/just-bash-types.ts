import type { BufferEncoding, IFileSystem } from "just-bash";

export type DirentEntry = Awaited<
  ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>
>[number];

export type ReadFileOptions = Exclude<
  Parameters<IFileSystem["readFile"]>[1],
  BufferEncoding | undefined
>;

export type WriteFileOptions = Exclude<
  Parameters<IFileSystem["writeFile"]>[2],
  BufferEncoding | undefined
>;
