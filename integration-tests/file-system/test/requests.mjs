import assert from "node:assert/strict";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const app = path.resolve("bin/app");
const tmp = os.tmpdir();

// File names baked into the Gren app (see src/Main.gren). Mirrored here so the
// runner can set up preconditions and verify outcomes.
const file = {
  writeFile: path.join(tmp, "gren-fs-write.txt"),
  appendToFile: path.join(tmp, "gren-fs-appendto.txt"),
  wfsReplace: path.join(tmp, "gren-fs-wfs-replace.txt"),
  wfsReplaceFrom: path.join(tmp, "gren-fs-wfs-replacefrom.txt"),
  append: path.join(tmp, "gren-file-system-append.txt"),
  truncate: path.join(tmp, "gren-fs-truncate.txt"),
  truncatePad: path.join(tmp, "gren-fs-truncate-pad.txt"),
  copySrc: path.join(tmp, "gren-fs-copy-src.txt"),
  copyDst: path.join(tmp, "gren-fs-copy-dst.txt"),
  remove: path.join(tmp, "gren-fs-remove.txt"),
  readFile: path.join(tmp, "gren-fs-read.txt"),
  readStream: path.join(tmp, "gren-fs-readstream.txt"),
};

// Fork the app with the given test argument, collecting all output. Resolves on
// "close" so every stdout/stderr byte is captured before we assert.
function run(arg) {
  return new Promise((resolve) => {
    const child = fork(app, [arg], { silent: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function cleanup(...files) {
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f);
}

describe("FileSystem", () => {
  it("writeFile writes bytes to a file", async () => {
    const { code, stderr } = await run("WriteFile");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.writeFile, "utf8"), "write-content\n");
    } finally {
      cleanup(file.writeFile);
    }
  });

  it("appendToFile adds bytes after existing content", async () => {
    fs.writeFileSync(file.appendToFile, "head\n");
    const { code, stderr } = await run("AppendToFile");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.appendToFile, "utf8"), "head\ntail\n");
    } finally {
      cleanup(file.appendToFile);
    }
  });

  it("writeFileStream Replace overwrites the whole file", async () => {
    fs.writeFileSync(file.wfsReplace, "XXXXXXXXXX");
    const { code, stderr } = await run("WriteFileStreamReplace");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.wfsReplace, "utf8"), "replace\n");
    } finally {
      cleanup(file.wfsReplace);
    }
  });

  it("writeFileStream ReplaceFrom keeps the prefix then writes", async () => {
    fs.writeFileSync(file.wfsReplaceFrom, "abcdef");
    const { code, stderr } = await run("WriteFileStreamReplaceFrom");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.wfsReplaceFrom, "utf8"), "abcXY");
    } finally {
      cleanup(file.wfsReplaceFrom);
    }
  });

  it("writeFileStream Append writes after existing content", async () => {
    fs.writeFileSync(file.append, "first\n");
    const { code, stderr } = await run("Append");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.append, "utf8"), "first\nsecond\n");
    } finally {
      cleanup(file.append);
    }
  });

  it("writeFromOffset works", async () => {
    fs.writeFileSync(file.wfsReplaceFrom, "AAAA");
    const { code, stderr } = await run("WriteFileHandleFromOffset");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.wfsReplaceFrom, "utf8"), "AAZZ");
    } finally {
      cleanup(file.wfsReplaceFrom);
    }
  })

  it("truncateFile shrinks the file to the given length", async () => {
    fs.writeFileSync(file.truncate, "12345678");
    const { code, stderr } = await run("TruncateFile");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.truncate, "utf8"), "1234");
    } finally {
      cleanup(file.truncate);
    }
  });

  it("truncateFile pads a short file with zeroes", async () => {
    fs.writeFileSync(file.truncatePad, "ab");
    const { code, stderr } = await run("TruncateFilePad");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.deepEqual(
        fs.readFileSync(file.truncatePad),
        Buffer.from([0x61, 0x62, 0x00, 0x00]),
      );
    } finally {
      cleanup(file.truncatePad);
    }
  });

  it("copyFile copies bytes from src to dest", async () => {
    fs.writeFileSync(file.copySrc, "copy-data\n");
    const { code, stderr } = await run("CopyFile");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.readFileSync(file.copyDst, "utf8"), "copy-data\n");
    } finally {
      cleanup(file.copySrc, file.copyDst);
    }
  });

  it("remove deletes the file", async () => {
    fs.writeFileSync(file.remove, "anything");
    const { code, stderr } = await run("Remove");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(fs.existsSync(file.remove), false);
    } finally {
      cleanup(file.remove);
    }
  });

  it("readFile reads the entire file", async () => {
    fs.writeFileSync(file.readFile, "read-content\n");
    const { code, stdout, stderr } = await run("ReadFile");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(stdout, "read-content\n");
    } finally {
      cleanup(file.readFile);
    }
  });

  it("readFileStream Beginning reads the whole file", async () => {
    fs.writeFileSync(file.readStream, "abcdef");
    const { code, stdout, stderr } = await run("ReadFileStreamBeginning");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(stdout, "abcdef");
    } finally {
      cleanup(file.readStream);
    }
  });

  it("readFileStream From reads from an offset to the end", async () => {
    fs.writeFileSync(file.readStream, "abcdef");
    const { code, stdout, stderr } = await run("ReadFileStreamFrom");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(stdout, "cdef");
    } finally {
      cleanup(file.readStream);
    }
  });

  it("readFileStream Between reads an inclusive range", async () => {
    fs.writeFileSync(file.readStream, "abcdef");
    const { code, stdout, stderr } = await run("ReadFileStreamBetween");
    try {
      assert.equal(code, 0, `app exited ${code}\n${stderr}`);
      assert.equal(stdout, "bcd");
    } finally {
      cleanup(file.readStream);
    }
  });

  it("makeTempDirectory doesn't crash program", async () => {
    const { code, stdout, stderr } = await run("MakeTempDirectoryError");
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(code, 0, `app exited with unexpected error: ${code}`);
  })
});
