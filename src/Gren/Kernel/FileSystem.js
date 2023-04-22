/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import FileSystem exposing (AccessErrorNotFound, AccessErrorNoAccess, AccessErrorUnknown, UnknownFileSystemError, File, Directory, Socket, Symlink, Device, Pipe)

*/

var fs = require("node:fs");
var bufferNs = require("node:buffer");
var path = require("node:path");
var process = require("node:process");

var _FileSystem_open = F2(function (access, path) {
  return __Scheduler_binding(function (callback) {
    fs.open(path, access, function (err, fd) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructAccessError(err)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
});

var _FileSystem_constructAccessError = function (err) {
  var errMsg = err.message;
  if (errMsg.indexOf("ENOENT") >= 0) {
    return __FileSystem_AccessErrorNotFound;
  } else if (errMsg.indexOf("EACCES") >= 0) {
    return __FileSystem_AccessErrorNoAccess;
  } else {
    return __FileSystem_AccessErrorUnknown(errMsg);
  }
};

var _FileSystem_close = function (fh) {
  return __Scheduler_binding(function (callback) {
    fs.close(fh, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructAccessError(err)));
      } else {
        callback(__Scheduler_succeed({}));
      }
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
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_UnknownFileSystemError(err)));
        return;
      }

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
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_UnknownFileSystemError(err)));
        return;
      }

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
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructAccessError(err)));
      } else {
        callback(__Scheduler_succeed({}));
      }
    });
  });
});

var _FileSystem_makeDirectory = F2(function (options, path) {
  return __Scheduler_binding(function (callback) {
    fs.mkdir(path, { recursive: options.__$recursive }, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructAccessError(err)));
      } else {
        callback(__Scheduler_succeed({}));
      }
    });
  });
});

// List of dir contents as filename strings
var _FileSystem_listDirectoryContent = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.readdir(path, function (err, content) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructAccessError(err)));
      } else {
        callback(__Scheduler_succeed(content));
      }
    });
  });
};

// List of dir contents as DirEntry values holding filename string
var _FileSystem_listDirectory = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.readdir(path, { withFileTypes: true }, function (err, content) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructAccessError(err)));
      } else {
        callback(__Scheduler_succeed(content.map(_FileSystem_toGrenDirEntry)));
      }
    });
  });
};

var _FileSystem_toGrenDirEntry = function (dirEnt) {
  if (dirEnt.isFile()) {
    return __FileSystem_File(dirEnt.name);
  } else if (dirEnt.isDirectory()) {
    return __FileSystem_Directory(dirEnt.name);
  } else if (dirEnt.isFIFO()) {
    return __FileSystem_Pipe(dirEnt.name);
  } else if (dirEnt.isSocket()) {
    return __FileSystem_Socket(dirEnt.name);
  } else if (dirEnt.isSymbolicLink()) {
    return __FileSystem_Symlink(dirEnt.name);
  } else {
    return __FileSystem_Device(dirEnt.name);
  }
};

var _FileSystem_currentWorkingDirectory = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(process.cwd()));
});

var _FileSystem_normalizePath = function (input) {
  return path.normalize(input);
};

var _FileSystem_buildPath = function (paths) {
  return path.join.apply(null, paths);
};
