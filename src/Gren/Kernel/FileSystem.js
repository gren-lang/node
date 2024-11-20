/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import Gren.Kernel.FilePath exposing (toString, fromString)
import FileSystem exposing (Error, File, Directory, Socket, Symlink, Device, Pipe, Read, Write, Execute, Changed, Moved)
import Maybe exposing (Just, Nothing)
import Time exposing (millisToPosix)

*/

var fs = require("node:fs");
var bufferNs = require("node:buffer");
var process = require("node:process");
var path = require("node:path");
var os = require("node:os");
var stream = require("node:stream");

var _FileSystem_coerce = function (fh) {
  return fh;
};

var _FileSystem_open = F2(function (access, path) {
  return __Scheduler_binding(function (callback) {
    fs.open(__FilePath_toString(path), access, function (err, fd) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
});

var _FileSystem_constructError = function (err) {
  return A2(__FileSystem_Error, err.code || "", err.message || "");
};

var _FileSystem_close = function (fh) {
  return __Scheduler_binding(function (callback) {
    fs.close(fh, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
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
      callback,
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
  callback,
) {
  fs.read(
    fh,
    buffer,
    bufferOffset,
    maxReadLength,
    fileOffset,
    function (err, bytesRead, _buff) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
        return;
      }

      var newBufferOffset = bufferOffset + bytesRead;

      if (bytesRead === 0 || newBufferOffset >= requestedReadLength) {
        callback(
          __Scheduler_succeed(
            new DataView(buffer.buffer, buffer.byteOffset, newBufferOffset),
          ),
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
        callback,
      );
    },
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
      callback,
    );
  });
});

var _FileSystem_writeHelper = function (
  fh,
  buffer,
  bufferOffset,
  length,
  fileOffset,
  callback,
) {
  fs.write(
    fh,
    buffer,
    bufferOffset,
    length,
    fileOffset,
    function (err, bytesWritten, buffer) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
        return;
      }

      if (bytesWritten === length) {
        callback(__Scheduler_succeed(fh));
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
        callback,
      );
    },
  );
};

var _FileSystem_remove = F2(function (options, path) {
  var rmOpts = {
    force: options.__$ignoreErrors,
    recursive: options.__$recursive,
  };

  return __Scheduler_binding(function (callback) {
    fs.rm(__FilePath_toString(path), rmOpts, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_makeDirectory = F2(function (options, path) {
  return __Scheduler_binding(function (callback) {
    fs.mkdir(
      __FilePath_toString(path),
      { recursive: options.__$recursive },
      function (err) {
        if (err != null) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(path));
        }
      },
    );
  });
});

// List of dir contents as DirEntry values holding filename string
var _FileSystem_listDirectory = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.readdir(
      __FilePath_toString(path),
      { withFileTypes: true },
      function (err, content) {
        if (err != null) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(
            __Scheduler_succeed(
              content.map((f) => ({
                __$path: __FilePath_fromString(f.name),
                __$entityType: _FileSystem_toEntityType(f),
              })),
            ),
          );
        }
      },
    );
  });
};

var _FileSystem_toEntityType = function (dirEnt) {
  if (dirEnt.isFile()) {
    return __FileSystem_File;
  } else if (dirEnt.isDirectory()) {
    return __FileSystem_Directory;
  } else if (dirEnt.isFIFO()) {
    return __FileSystem_Pipe;
  } else if (dirEnt.isSocket()) {
    return __FileSystem_Socket;
  } else if (dirEnt.isSymbolicLink()) {
    return __FileSystem_Symlink;
  } else {
    return __FileSystem_Device;
  }
};

var _FileSystem_fchmod = F2(function (mode, fd) {
  return __Scheduler_binding(function (callback) {
    fs.fchmod(fd, mode, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
});

var _FileSystem_fchown = F2(function (ids, fd) {
  return __Scheduler_binding(function (callback) {
    fs.fchown(fd, ids.__$userID, ids.__$groupID, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
});

var _FileSystem_fdatasync = function (fd) {
  return __Scheduler_binding(function (callback) {
    fs.fdatasync(fd, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
};

var _FileSystem_fsync = function (fd) {
  return __Scheduler_binding(function (callback) {
    fs.fsync(fd, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
};

var _FileSystem_fstat = function (fd) {
  return __Scheduler_binding(function (callback) {
    fs.fstat(fd, function (err, stats) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(_FileSystem_statToGrenRecord(stats)));
      }
    });
  });
};

var _FileSystem_ftruncate = F2(function (len, fd) {
  return __Scheduler_binding(function (callback) {
    fs.ftruncate(fd, len, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
});

var _FileSystem_futimes = F3(function (atime, mtime, fd) {
  return __Scheduler_binding(function (callback) {
    fs.futimes(fd, atime, mtime, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err.message)));
      } else {
        callback(__Scheduler_succeed(fd));
      }
    });
  });
});

var _FileSystem_access = F2(function (permissions, path) {
  var mode = fs.constants.F_OK;

  if (permissions.includes(__FileSystem_Read)) {
    mode = mode | fs.constants.R_OK;
  }

  if (permissions.includes(__FileSystem_Write)) {
    mode = mode | fs.constants.W_OK;
  }

  if (permissions.includes(__FileSystem_Execute)) {
    mode = mode | fs.constants.X_OK;
  }

  return __Scheduler_binding(function (callback) {
    fs.access(__FilePath_toString(path), mode, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_appendFile = F2(function (data, path) {
  return __Scheduler_binding(function (callback) {
    fs.appendFile(__FilePath_toString(path), data, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_chmod = F2(function (mode, path) {
  return __Scheduler_binding(function (callback) {
    fs.chmod(__FilePath_toString(path), mode, function (err) {
      if (err != null) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_chown = F2(function (ids, path) {
  return __Scheduler_binding(function (callback) {
    fs.chown(
      __FilePath_toString(path),
      ids.__$userID,
      ids.__$groupID,
      function (err) {
        if (err) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(path));
        }
      },
    );
  });
});

var _FileSystem_lchown = F2(function (ids, path) {
  return __Scheduler_binding(function (callback) {
    fs.lchown(
      __FilePath_toString(path),
      ids.__$userID,
      ids.__$groupID,
      function (err) {
        if (err) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(path));
        }
      },
    );
  });
});

var _FileSystem_copyFile = F2(function (src, dest) {
  return __Scheduler_binding(function (callback) {
    fs.copyFile(
      __FilePath_toString(src),
      __FilePath_toString(dest),
      0,
      function (err) {
        if (err) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(dest));
        }
      },
    );
  });
});

var _FileSystem_link = F2(function (src, dest) {
  return __Scheduler_binding(function (callback) {
    fs.link(
      __FilePath_toString(src),
      __FilePath_toString(dest),
      function (err) {
        if (err) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(dest));
        }
      },
    );
  });
});

var _FileSystem_symlink = F2(function (src, dest) {
  return __Scheduler_binding(function (callback) {
    fs.symlink(
      __FilePath_toString(src),
      __FilePath_toString(dest),
      function (err) {
        if (err) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(dest));
        }
      },
    );
  });
});

var _FileSystem_unlink = function (src) {
  return __Scheduler_binding(function (callback) {
    fs.unlink(__FilePath_toString(src), function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(src));
      }
    });
  });
};

var _FileSystem_mkdtemp = function (prefix) {
  return __Scheduler_binding(function (callback) {
    fs.mkdtemp(path.join(os.tmpdir(), prefix), function (err, dir) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(__FilePath_fromString(dir)));
      }
    });
  });
};

var _FileSystem_readFile = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.readFile(__FilePath_toString(path), function (err, data) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(
          __Scheduler_succeed(
            new DataView(data.buffer, data.byteOffset, data.byteLength),
          ),
        );
      }
    });
  });
};

var _FileSystem_readFileStream = function (path) {
  return __Scheduler_binding(function (callback) {
    try {
      var fstream = fs.createReadStream(__FilePath_toString(path))
      callback(__Scheduler_succeed(stream.Readable.toWeb(fstream)));
    } catch (err) {
      callback(__Scheduler_fail(_FileSystem_constructError(err)));
    }
  });
};

var _FileSystem_readLink = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.readlink(__FilePath_toString(path), function (err, linkedPath) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(__FilePath_fromString(linkedPath)));
      }
    });
  });
};

var _FileSystem_rename = F2(function (oldPath, newPath) {
  return __Scheduler_binding(function (callback) {
    fs.rename(
      __FilePath_toString(oldPath),
      __FilePath_toString(newPath),
      function (err) {
        if (err) {
          callback(__Scheduler_fail(_FileSystem_constructError(err)));
        } else {
          callback(__Scheduler_succeed(newPath));
        }
      },
    );
  });
});

var _FileSystem_realpath = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.realpath(__FilePath_toString(path), function (err, resolvedPath) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(__FilePath_fromString(resolvedPath)));
      }
    });
  });
};

var _FileSystem_stat = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.stat(__FilePath_toString(path), function (err, stats) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(_FileSystem_statToGrenRecord(stats)));
      }
    });
  });
};

var _FileSystem_lstat = function (path) {
  return __Scheduler_binding(function (callback) {
    fs.lstat(__FilePath_toString(path), function (err, stats) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(_FileSystem_statToGrenRecord(stats)));
      }
    });
  });
};

var _FileSystem_statToGrenRecord = function (stats) {
  return {
    __$entityType: _FileSystem_toEntityType(stats),
    __$blockSize: stats.blksize,
    __$blocks: stats.blocks,
    __$byteSize: stats.size,
    __$created: __Time_millisToPosix(Math.floor(stats.birthtimeMs)),
    __$deviceID: stats.dev,
    __$groupID: stats.gid,
    __$lastAccessed: __Time_millisToPosix(Math.floor(stats.atimeMs)),
    __$lastChanged: __Time_millisToPosix(Math.floor(stats.ctimeMs)),
    __$lastModified: __Time_millisToPosix(Math.floor(stats.mtimeMs)),
    __$userID: stats.uid,
  };
};

var _FileSystem_truncate = F2(function (len, path) {
  return __Scheduler_binding(function (callback) {
    fs.truncate(__FilePath_toString(path), len, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_utimes = F3(function (atime, mtime, path) {
  return __Scheduler_binding(function (callback) {
    fs.utimes(__FilePath_toString(path), atime, mtime, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_lutimes = F3(function (atime, mtime, path) {
  return __Scheduler_binding(function (callback) {
    fs.lutimes(__FilePath_toString(path), atime, mtime, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_writeFile = F2(function (data, path) {
  return __Scheduler_binding(function (callback) {
    fs.writeFile(__FilePath_toString(path), data, function (err) {
      if (err) {
        callback(__Scheduler_fail(_FileSystem_constructError(err)));
      } else {
        callback(__Scheduler_succeed(path));
      }
    });
  });
});

var _FileSystem_writeFileStream = function (path) {
  return __Scheduler_binding(function (callback) {
    try {
      var fstream = fs.createWriteStream(__FilePath_toString(path));
      callback(__Scheduler_succeed(stream.Writable.toWeb(fstream)));
    } catch (err) {
      callback(__Scheduler_fail(_FileSystem_constructError(err)));
    }
  });
};

var _FileSystem_watch = F3(function (path, isRecursive, sendToSelf) {
  return __Scheduler_binding(function (_callback) {
    var watcher = null;

    try {
      watcher = fs.watch(
        path,
        { recursive: isRecursive },
        function (eventType, filename) {
          var maybePath = filename
            ? __Maybe_Just(__FilePath_fromString(filename))
            : __Maybe_Nothing;

          if (eventType === "rename") {
            __Scheduler_rawSpawn(sendToSelf(__FileSystem_Moved(maybePath)));
          } else if (eventType === "change") {
            __Scheduler_rawSpawn(sendToSelf(__FileSystem_Changed(maybePath)));
          }

          // other change types are ignored
        },
      );
    } catch (e) {
      // ignore errors
    }

    return function () {
      if (watcher) {
        watcher.close();
      }
    };
  });
});
var _FileSystem_homeDir = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(__FilePath_fromString(os.homedir())));
});

var _FileSystem_currentWorkingDirectory = __Scheduler_binding(
  function (callback) {
    callback(__Scheduler_succeed(__FilePath_fromString(process.cwd())));
  },
);

var _FileSystem_tmpDir = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(__FilePath_fromString(os.tmpdir())));
});

var _FileSystem_devNull = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(__FilePath_fromString(os.devNull)));
});
