// Own the write queue in a system module. A promise created in a browser
// window can stop running reactions when that window closes.
let queue = Promise.resolve();

export function appendTrace(path, line, maxBytes = 96 * 1024) {
  const write = queue.then(async () => {
    if (await IOUtils.exists(path)) {
      const info = await IOUtils.stat(path);
      if (info.size <= maxBytes) {
        await IOUtils.writeUTF8(path, line, { mode: "append" });
        return;
      }
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
    await IOUtils.writeUTF8(path, line);
  });
  // The queue must recover even if the caller's error handler belongs to a
  // window that has since closed. Callers still receive the original failure.
  queue = write.catch(() => {});
  return write;
}

export function flushTrace() {
  return queue;
}
