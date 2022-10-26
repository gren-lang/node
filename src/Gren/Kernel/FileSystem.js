/*

import Gren.Kernel.Scheduler exposing (binding, succeed)

*/

var fs = require("node:fs");
var bufferNs = require("node:buffer");

var _FileSystem_open = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.open(path, "r+", function (err, fd) {
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
    var requestedLength = options.length < 0 || options.length > bufferNs.constants.MAX_LENGTH
          ? bufferNs.constants.MAX_LENGTH
          : options.length;

    var initialBufferSize = requestedLength === bufferNs.constants.MAX_LENGTH ? 16 * 1024 : requestedLength;
    var buffer = Buffer.allocUnsafe(initialBufferSize);

    var fileOffset = options.offset < 0 ? 0 : options.offset;

    _FileSystem_readHelper(fh, buffer, 0, fileOffset, buffer.byteLength, requestedLength, callback);
  });
});

var _FileSystem_readHelper = function (
  fh,
  buffer,
  bufferOffset,
  fileOffset,
  maxReadLength,
  requestedReadLength,
  callback
) {
  fs.read(
    fh,
    buffer,
    bufferOffset,
    maxReadLength,
    fileOffset,
    function (err, bytesRead, _buff) {
      var newBufferOffset = bufferOffset + bytesRead;

      if (bytesRead === 0 || newBufferOffset >= requestedReadLength) {
        callback(__Scheduler_succeed(new DataView(buffer.buffer, buffer.byteOffset, newBufferOffset)));
        return;
      }

      var newMaxReadLength = maxReadLength - bytesRead;
      if (newMaxReadLength <= 0) {
        var oldBuffer = buffer;
        buffer = Buffer.allocUnsafe(oldBuffer.byteLength * 1.5);
        oldBuffer.copy(buffer);

        newMaxReadLength = buffer.byteLength - oldBuffer.byteLength;
      }


      _FileSystem_readHelper(
        fh,
        buffer,
        newBufferOffset,
        fileOffset + bytesRead,
        newMaxReadLength,
        requestedReadLength,
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
    buffer,
    bufferOffset,
    length,
    fileOffset,
    function (err, bytesWritten, buffer) {
      if (bytesWritten === length) {
        callback(__Scheduler_succeed({}));
        return;
      }

      var newBufferOffset = bufferOffset + bytesWritten;
      var newFileOffset = fileOffset + bytesWritten;

      _FileSystem_writeHelper(
        fh,
        buffer,
        newBufferOffset,
        length - bytesWritten,
        newFileOffset,
        callback
      );
    }
  );
};
