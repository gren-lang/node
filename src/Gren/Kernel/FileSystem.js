/*

import Gren.Kernel.Scheduler exposing (binding, succeed)

*/

var fs = require("node:fs");
var bufferNs = require("node:buffer");

var _FileSystem_open = F2(function (access, path) {
  return __Scheduler_binding(function (callback) {
    fs.open(path, access, function (err, fd) {
      callback(__Scheduler_succeed(fd));
    });
  });
});

var _FileSystem_close = function (fh) {
  return __Scheduler_binding(function (callback) {
    fs.close(fh, function () {
      callback(__Scheduler_succeed({}));
    });
  });
};

var _FileSystem_readFromOffset = F2(function (fh, options) {
  var requestedLength =
    options.__$length < 0 || options.__$length > bufferNs.constants.MAX_LENGTH
      ? bufferNs.constants.MAX_LENGTH
      : options.__$length;

  var fileOffset = options.__$offset < 0 ? 0 : options.__$offset;

  return __Scheduler_binding(function (callback) {
    var initialBufferSize =
      requestedLength === bufferNs.constants.MAX_LENGTH
        ? 16 * 1024
        : requestedLength;
    var buffer = Buffer.allocUnsafe(initialBufferSize);

    _FileSystem_readHelper(
      fh,
      buffer,
      0,
      fileOffset,
      buffer.byteLength,
      requestedLength,
      callback
    );
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
        callback(
          __Scheduler_succeed(
            new DataView(buffer.buffer, buffer.byteOffset, newBufferOffset)
          )
        );
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
      options.__$offset,
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

var _FileSystem_remove = F2(function (options, path) {
  var rmOpts = {
    force: options.__$ignoreErrors,
    recursive: options.__$recursive,
  };

  return __Scheduler_binding(function (callback) {
    fs.rm(path, rmOpts, function (err) {
      callback(__Scheduler_succeed({}));
    });
  });
});

var _FileSystem_makeDirectory = F2(function (options, path) {
  return __Scheduler_binding(function (callback) {
    fs.mkdir(path, { recursive: options.__$recursive }, function (err) {
      callback(__Scheduler_succeed({}));
    });
  });
});

var _FileSystem_listDirectoryContent = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.readdir(path, function (err, content) {
      callback(__Scheduler_succeed(content));
    });
  });
};
