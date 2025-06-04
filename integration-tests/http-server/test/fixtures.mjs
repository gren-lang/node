import * as path from "node:path";
import * as childProc from "node:child_process";

let proc;

export function mochaGlobalSetup() {
  const appPath = path.resolve(import.meta.dirname, "../app");
  proc = childProc.fork(appPath);
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({});
    }, 100);
  })
}

export function mochaGlobalTeardown() {
  proc.kill();
}
