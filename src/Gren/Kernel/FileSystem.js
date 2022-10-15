/*

import Gren.Kernel.Scheduler exposing (binding, succeed)

*/

var fs = require("node:fs");

var _FileSystem_open = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.open(path, function (err, fd) {
      callback(__Scheduler_succeed(fd));
    });
  });
};

var _FileSystem_close = function (fh) {
  return __Scheduler_binding(function (callback) {
    fs.close(fh, function () {
      callback(__Scheduler_succeed({}));
    });
  });
};

var _FileSystem_readFromOffset = F2(function (fh, options) {
  return __Scheduler_binding(function (callback) {
    var buffer = Buffer.allocUnsafe(16 * 1024);
    var length =
      options.length < 0 ? buffer.byteLength - options.offset : options.length;

    _FileSystem_readHelper(fh, buffer, 0, options.offset, length, callback);
  });
});

var _FileSystem_readHelper = function (
  fh,
  buffer,
  bufferOffset,
  fileOffset,
  length,
  callback
) {
  fs.read(
    fh,
    buffer,
    bufferOffset,
    length,
    fileOffset,
    function (err, bytesRead, buff) {
      if (bytesRead === 0) {
        callback(__Scheduler_succeed(new DataView(buffer.buffer, 0, bufferOffset)));
        return;
      }

      _FileSystem_readHelper(
        fh,
        buffer,
        bufferOffset + bytesRead,
        -1,
        length - bytesRead,
        callback
      );
    }
  );
};

var _FileSystem_writeFromOffset = F3(function (fh, options, bytes) {
  return __Scheduler_binding(function (callback) {
    _FileSystem_writeHelper(
      fh,
      bytes,
      0,
      bytes.byteLength,
      options.offset,
      callback
    );
  });
});

var _FileSystem_writeHelper = function (
  fh,
  buffer,
  bufferOffset,
  length,
  fileOffset,
  callback
) {
  fs.write(
    fh,
    bytes,
    0,
    bytes.byteLength,
    options.offset,
    function (err, bytesWritten, buffer) {
      if (bytesWritten === length) {
        callback(__Scheduler_succeed({}));
        return;
      }

      var newBufferOffset = bufferOffset + bytesWritten;
      var newFileOffset = fileOffset + bytesWritten;

      _FileSystem_writeHelper(
        fh,
        bytes,
        newOffset,
        bytes.byteLength - newOffset,
        newFileOffset,
        callback
      );
    }
  );
};
