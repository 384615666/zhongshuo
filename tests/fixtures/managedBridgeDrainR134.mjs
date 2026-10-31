// Synthetic bytes only. Synchronous writes ensure normal exit cannot truncate a
// pending Node stdout/stderr write before the managed bridge reads it.
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';

function emit() {
  for (const [fd, path] of [[1, process.argv[2]], [2, process.argv[3]]]) {
    const bytes = readFileSync(path);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  }
}

if (process.argv[4] === 'inherited-writer') {
  const child = spawn(process.execPath, [process.argv[1], process.argv[2], process.argv[3], 'release-file', process.argv[5]], {
    // A separate Windows console lifetime lets the writer outlive the root;
    // it still inherits the managed job and the real output pipe handles.
    stdio: ['ignore', 1, 2], windowsHide: true, detached: true,
  });
  child.unref();
} else if (process.argv[4] === 'release-file') {
  const timer = setInterval(() => {
    if (!existsSync(process.argv[5])) return;
    clearInterval(timer);
    emit();
  }, 10);
} else if (process.argv[4] === 'stdin-eof') {
  process.stdin.resume();
  process.stdin.once('end', emit);
} else {
  emit();
}
