/** POSIX path helpers standing in for node:path (a hooks module has no Node). */

export const isAbsolute = (p: string): boolean => p.startsWith("/");

export function relative(from: string, to: string): string {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/** UTF-8 byte length (Buffer.byteLength stand-in). */
export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** The session's directory, set by the hooks module (process.cwd() stand-in). */
let sessionCwd = "";
export const setSessionCwd = (cwd: string): void => {
  sessionCwd = cwd;
};
export const getSessionCwd = (): string => sessionCwd;
